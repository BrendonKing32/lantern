import { countWords } from "../../shared/wordcount";
import type { DeletedChapter, SnapshotReason } from "../../shared/types";
import { chapterKey, getChapterRow, insertChapter, lastActId, MARKDOWN, MAX_CHAPTER_BYTES, requireProject } from "../db";
import { body, cleanTitle, HttpError, isDay, json, now, type Handler } from "../http";
import { snapshotBeforeSave } from "./history";

export const listDeletedChapters: Handler = async (_req, env, p) => {
  await requireProject(env, p.id);
  const { results } = await env.DB.prepare(
    `SELECT id, title, word_count, deleted_at FROM chapters
      WHERE project_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 200`,
  )
    .bind(p.id)
    .all<DeletedChapter>();
  return json(results);
};

// A restored chapter goes back at the end of the book (so into the last act);
// drag it where it belongs.
export const restoreChapter: Handler = async (_req, env, p) => {
  const row = await env.DB.prepare(
    `SELECT project_id FROM chapters
      WHERE id = ? AND deleted_at IS NOT NULL
        AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)`,
  )
    .bind(p.id)
    .first<{ project_id: string }>();
  if (!row) throw new HttpError(404, "That chapter isn't in Recently deleted");
  const ts = now();
  const actId = await lastActId(env, row.project_id);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE chapters SET deleted_at = NULL, act_id = ?,
              position = (SELECT COALESCE(MAX(position), -1) + 1 FROM chapters
                           WHERE project_id = ? AND deleted_at IS NULL)
        WHERE id = ?`,
    ).bind(actId, row.project_id, p.id),
    env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(ts, row.project_id),
  ]);
  return json(await getChapterRow(env, p.id));
};

export const createChapter: Handler = async (req, env, p) => {
  await requireProject(env, p.id);
  const b = await body<{ title?: string }>(req);
  const chapter = await insertChapter(env, p.id, cleanTitle(b.title, "Untitled chapter"));
  return json(chapter, 201);
};

export const getChapter: Handler = async (_req, env, p) => {
  const row = await getChapterRow(env, p.id);
  const obj = await env.BUCKET.get(chapterKey(row.project_id, row.id));
  const content = obj ? await obj.text() : "";
  return json({ ...row, content });
};

export const saveChapter: Handler = async (req, env, p) => {
  const b = await body<{
    content?: unknown;
    baseVersion?: unknown;
    snapshot?: unknown;
    snapshotContent?: unknown;
    day?: unknown;
  }>(req);
  if (typeof b.content !== "string") throw new HttpError(400, "content must be a string");
  const reason: SnapshotReason =
    b.snapshot === "restore" || b.snapshot === "conflict" || b.snapshot === "replace" ? b.snapshot : "auto";
  if (typeof b.baseVersion !== "number") throw new HttpError(400, "baseVersion must be a number");
  if (b.snapshotContent !== undefined && typeof b.snapshotContent !== "string") {
    throw new HttpError(400, "snapshotContent must be text");
  }
  if (b.snapshotContent !== undefined && reason !== "replace") {
    throw new HttpError(400, "snapshotContent is only valid for a replacement");
  }
  if (typeof b.snapshotContent === "string" && new TextEncoder().encode(b.snapshotContent).length > MAX_CHAPTER_BYTES) {
    throw new HttpError(413, "Snapshot is too large (5 MB limit)");
  }
  if (new TextEncoder().encode(b.content).length > MAX_CHAPTER_BYTES) {
    throw new HttpError(413, "Chapter is too large (5 MB limit)");
  }
  const row = await getChapterRow(env, p.id);
  const ts = now();
  const words = countWords(b.content);

  // Claim the next version only if nobody else saved in the meantime.
  const claim = await env.DB.prepare(
    `UPDATE chapters SET version = version + 1, word_count = ?, updated_at = ?
      WHERE id = ? AND version = ? AND deleted_at IS NULL`,
  )
    .bind(words, ts, row.id, b.baseVersion)
    .run();
  if (!claim.meta.changes) {
    const current = await getChapterRow(env, p.id);
    throw new HttpError(409, "conflict", { version: current.version });
  }

  // Keep the server copy and, when it differs, the local draft being replaced.
  try {
    const savedText = await snapshotBeforeSave(env, row, reason);
    if (
      reason === "replace" &&
      typeof b.snapshotContent === "string" &&
      b.snapshotContent.trim() &&
      b.snapshotContent !== savedText
    ) {
      await snapshotBeforeSave(env, row, reason, b.snapshotContent);
    }
  } catch (e) {
    console.error("snapshot failed", e);
    if (reason === "replace") {
      await env.DB.prepare(
        "UPDATE chapters SET version = ?, word_count = ?, updated_at = ? WHERE id = ? AND version = ?",
      )
        .bind(b.baseVersion, row.word_count, row.updated_at, row.id, b.baseVersion + 1)
        .run();
      throw new HttpError(500, "Could not preserve the earlier versions; no replacement was saved");
    }
  }

  try {
    await env.BUCKET.put(chapterKey(row.project_id, row.id), b.content, MARKDOWN);
  } catch (e) {
    // Roll the version back so the client's next attempt still lines up.
    await env.DB.prepare(
      "UPDATE chapters SET version = ?, word_count = ? WHERE id = ? AND version = ?",
    )
      .bind(b.baseVersion, row.word_count, row.id, b.baseVersion + 1)
      .run();
    throw e;
  }
  // Count the words this save added (or removed) toward the writer's day.
  // Putting back an old version from History isn't writing, so it doesn't count.
  const day = isDay(b.day) ? b.day : ts.slice(0, 10);
  const delta = reason === "restore"
    ? 0
    : reason === "replace"
      ? (typeof b.snapshotContent === "string" ? countWords(b.snapshotContent) : row.word_count) - row.word_count
      : words - row.word_count;
  await env.DB.batch([
    env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(ts, row.project_id),
    env.DB.prepare(
      `INSERT INTO daily_words (day, project_id, words) VALUES (?, ?, ?)
         ON CONFLICT (day, project_id) DO UPDATE SET words = words + excluded.words`,
    ).bind(day, row.project_id, delta),
  ]);
  const today = await env.DB.prepare("SELECT COALESCE(SUM(words), 0) AS w FROM daily_words WHERE day = ?")
    .bind(day)
    .first<{ w: number }>();

  return json({ version: b.baseVersion + 1, word_count: words, updated_at: ts, today_words: today?.w ?? 0 });
};

export const updateChapter: Handler = async (req, env, p) => {
  const row = await getChapterRow(env, p.id);
  const b = await body<{ title?: string; synopsis?: string }>(req);
  const title = b.title === undefined ? row.title : cleanTitle(b.title, row.title);
  const synopsis = typeof b.synopsis === "string" ? b.synopsis.slice(0, 2000) : row.synopsis;
  await env.DB.prepare("UPDATE chapters SET title = ?, synopsis = ? WHERE id = ?")
    .bind(title, synopsis, row.id)
    .run();
  return json({ ...row, title, synopsis });
};

export const deleteChapter: Handler = async (_req, env, p) => {
  const row = await getChapterRow(env, p.id);
  await env.DB.prepare("UPDATE chapters SET deleted_at = ? WHERE id = ?").bind(now(), row.id).run();
  return json({ ok: true });
};
