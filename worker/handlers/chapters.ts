import { countWords } from "../../shared/wordcount";
import type { ChapterMeta, DeletedChapter, SnapshotReason } from "../../shared/types";
import { assertChapterUnlocked, chapterKey, chapterMoveToken, chapterPut, getChapterRow, insertChapter, lastActId, MAX_CHAPTER_BYTES, reconcileChapter, requireProject } from "../db";
import type { Env } from "../env";
import { body, cleanTitle, HttpError, isDay, json, now, type Handler } from "../http";
import { snapshotBeforeSave } from "./history";
import { afterChapterWrite } from "../sceneSync";

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
  const row = await reconcileChapter(env, await getChapterRow(env, p.id));
  const obj = await env.BUCKET.get(chapterKey(row.project_id, row.id));
  const content = obj ? await obj.text() : "";
  return json({ ...row, content });
};

/** Claim, preserve and write a chapter. Failed mandatory snapshots and puts roll back the claim. */
export async function writeChapter(
  env: Env, row: ChapterMeta, content: string, baseVersion: number, reason: SnapshotReason,
  options: { snapshotContent?: string; sceneSnapshot?: string; draftVersion?: number } = {},
): Promise<{ version: number; word_count: number; updated_at: string }> {
  await assertChapterUnlocked(env, row.id);
  const token = await chapterMoveToken(env, row.id);
  const originalVersion = row.version;
  row = await reconcileChapter(env, row);
  await assertChapterUnlocked(env, row.id);
  if (row.version !== originalVersion || row.version !== baseVersion) {
    throw new HttpError(409, "conflict", { version: row.version });
  }
  const ts = now();
  const words = countWords(content);
  const guard = options.sceneSnapshot === undefined ? "" : ` AND
    (SELECT json_group_array(json_array(id, position, in_text, anchor_head, anchor_tail))
       FROM (SELECT id, position, in_text, anchor_head, anchor_tail FROM scenes WHERE chapter_id = ? ORDER BY id)) = ?`;
  const draftGuard = options.draftVersion === undefined ? "" :
    " AND EXISTS (SELECT 1 FROM claude_drafts WHERE chapter_id = ? AND version = ?)";
  const claim = await env.DB.prepare(
    `UPDATE chapters SET version = version + 1, word_count = ?, updated_at = ?
      WHERE id = ? AND version = ? AND moving_until IS ? AND deleted_at IS NULL
        AND (moving_until IS NULL OR moving_until <= ?)${guard}${draftGuard}`,
  ).bind(words, ts, row.id, baseVersion, token, ts, ...(options.sceneSnapshot === undefined ? [] : [row.id, options.sceneSnapshot]),
    ...(options.draftVersion === undefined ? [] : [row.id, options.draftVersion])).run();
  if (!claim.meta.changes) {
    await assertChapterUnlocked(env, row.id);
    const current = await getChapterRow(env, row.id);
    if (current.version !== baseVersion) throw new HttpError(409, "conflict", { version: current.version });
    if (options.draftVersion !== undefined) {
      const draft = await env.DB.prepare("SELECT version FROM claude_drafts WHERE chapter_id = ?").bind(row.id).first<{ version: number }>();
      if (draft?.version !== options.draftVersion) throw new HttpError(409, "Claude changed this draft while you were reviewing it. Look it over again, then accept it.", { code: "draft_changed" });
    }
    throw new HttpError(409, "Chapter or scene list is out of date; reload and try again");
  }
  const rollback = () => env.DB.prepare(
    "UPDATE chapters SET version = ?, word_count = ?, updated_at = ? WHERE id = ? AND version = ?",
  ).bind(baseVersion, row.word_count, row.updated_at, row.id, baseVersion + 1).run();
  try {
    const savedText = await snapshotBeforeSave(env, row, reason);
    if (reason === "replace" && options.snapshotContent?.trim() && options.snapshotContent !== savedText) {
      await snapshotBeforeSave(env, row, reason, options.snapshotContent);
    }
  } catch (e) {
    console.error("snapshot failed", e);
    if (reason === "replace" || reason === "move" || reason === "claude") {
      await rollback();
      throw new HttpError(500, reason === "claude"
        ? "Lantern couldn't keep a copy of the chapter in History, so the draft wasn't accepted. Try again."
        : reason === "move"
        ? "Could not keep a copy in History, so nothing was moved"
        : "Could not preserve the earlier versions; no replacement was saved");
    }
  }
  try {
    await chapterPut(env, row, content, baseVersion + 1);
  } catch (e) {
    await rollback();
    throw e;
  }
  return { version: baseVersion + 1, word_count: words, updated_at: ts };
}

export const saveChapter: Handler = async (req, env, p) => {
  const b = await body<{
    content?: unknown;
    baseVersion?: unknown;
    snapshot?: unknown;
    snapshotContent?: unknown;
    day?: unknown;
    revised?: unknown;
  }>(req);
  if (typeof b.content !== "string") throw new HttpError(400, "content must be a string");
  const reason: SnapshotReason =
    b.snapshot === "restore" || b.snapshot === "conflict" || b.snapshot === "replace" ? b.snapshot : "auto";
  if (typeof b.baseVersion !== "number") throw new HttpError(400, "baseVersion must be a number");
  if (b.revised !== undefined && (!Number.isSafeInteger(b.revised) || (b.revised as number) < 0)) {
    throw new HttpError(400, "revised must be a non-negative whole number");
  }
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
  const row = await reconcileChapter(env, await getChapterRow(env, p.id));
  const { word_count: words, updated_at: ts } = await writeChapter(env, row, b.content, b.baseVersion, reason,
    { snapshotContent: typeof b.snapshotContent === "string" ? b.snapshotContent : undefined });
  await afterChapterWrite(env, row, b.content, b.baseVersion + 1);
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
      `INSERT INTO daily_words (day, project_id, words, revised) VALUES (?, ?, ?, ?)
         ON CONFLICT (day, project_id) DO UPDATE SET words = words + excluded.words, revised = revised + excluded.revised`,
    ).bind(day, row.project_id, delta, reason === "auto" ? Math.min(50_000, (b.revised as number | undefined) ?? 0) : 0),
  ]);
  const today = await env.DB.prepare("SELECT COALESCE(SUM(words), 0) AS w FROM daily_words WHERE day = ?")
    .bind(day)
    .first<{ w: number }>();

  return json({ version: b.baseVersion + 1, word_count: words, updated_at: ts, today_words: today?.w ?? 0 });
};

export const updateChapter: Handler = async (req, env, p) => {
  const row = await getChapterRow(env, p.id);
  await assertChapterUnlocked(env, row.id);
  const b = await body<{ title?: string; synopsis?: string; revision_status?: unknown }>(req);
  if (b.revision_status !== undefined && b.revision_status !== "drafting" && b.revision_status !== "revising" && b.revision_status !== "done") {
    throw new HttpError(400, "revision_status must be drafting, revising or done");
  }
  const revisionStatus = b.revision_status ?? null;
  const title = b.title === undefined ? null : cleanTitle(b.title, row.title);
  const synopsis = typeof b.synopsis === "string" ? b.synopsis.slice(0, 2000) : null;
  const result = await env.DB.prepare(
    "UPDATE chapters SET title = COALESCE(?, title), synopsis = COALESCE(?, synopsis), revision_status = COALESCE(?, revision_status) WHERE id = ? AND deleted_at IS NULL AND (moving_until IS NULL OR moving_until <= ?)",
  )
    .bind(title, synopsis, revisionStatus, row.id, now())
    .run();
  if (!result.meta.changes) {
    await assertChapterUnlocked(env, row.id);
    throw new HttpError(409, "Chapter changed; reload and try again");
  }
  return json(await getChapterRow(env, row.id));
};

export const deleteChapter: Handler = async (_req, env, p) => {
  const row = await getChapterRow(env, p.id);
  await assertChapterUnlocked(env, row.id);
  const ts = now();
  const result = await env.DB.prepare(
    "UPDATE chapters SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL AND (moving_until IS NULL OR moving_until <= ?)",
  ).bind(ts, row.id, ts).run();
  if (!result.meta.changes) {
    await assertChapterUnlocked(env, row.id);
    throw new HttpError(409, "Chapter changed; reload and try again");
  }
  return json({ ok: true });
};
