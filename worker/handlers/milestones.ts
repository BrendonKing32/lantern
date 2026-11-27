import { countWords } from "../../shared/wordcount";
import type { ChapterMeta, MilestoneChapter } from "../../shared/types";
import { assertChapterUnlocked, CHAPTER_COLS, chapterKey, chapterMoveToken, chapterTextVersion, MARKDOWN, milestoneKey, reconcileChapter, requireProject } from "../db";
import type { Env } from "../env";
import { body, HttpError, json, newId, now, type Handler } from "../http";

type Milestone = {
  id: string; project_id: string; name: string; note: string;
  word_count: number; chapter_count: number; created_at: string;
};

function nameValue(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120) {
    throw new HttpError(400, "Give the milestone a name of 120 characters or fewer.");
  }
  return value.trim();
}

function noteValue(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "The note must be text.");
  return value;
}

async function removeMilestone(env: Pick<Env, "DB" | "BUCKET">, projectId: string, id: string, confirmedLinks?: string[]) {
  const check = confirmedLinks === undefined ? "" : ` AND NOT EXISTS (
    SELECT 1 FROM project_shares WHERE milestone_id = ? AND revoked_at IS NULL
      AND id NOT IN (SELECT value FROM json_each(?)))`;
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE milestones SET complete = -1 WHERE id = ?${check}`)
      .bind(id, ...(confirmedLinks === undefined ? [] : [id, JSON.stringify(confirmedLinks)])),
    env.DB.prepare(`UPDATE project_shares SET revoked_at = COALESCE(revoked_at, ?), milestone_id = NULL
      WHERE milestone_id = ? AND EXISTS (SELECT 1 FROM milestones WHERE id = ? AND complete = -1)`)
      .bind(now(), id, id),
  ]);
  if (confirmedLinks !== undefined && !results[0].meta.changes) {
    throw new HttpError(409, "Review links changed. Check them and try deleting the milestone again.");
  }
  const prefix = `projects/${projectId}/milestones/${id}/`;
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix, cursor, limit: 1000 });
    for (const object of page.objects) await env.BUCKET.delete(object.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM milestone_chapters WHERE milestone_id = ?").bind(id),
    env.DB.prepare("DELETE FROM milestones WHERE id = ? AND complete = -1").bind(id),
  ]);
}

export async function cleanupIncompleteMilestones(env: Pick<Env, "DB" | "BUCKET">) {
  const cutoff = new Date(Date.now() - 3_600_000).toISOString();
  const { results } = await env.DB.prepare(
    "SELECT id, project_id FROM milestones WHERE (complete = 0 OR complete = -1) AND created_at < ?",
  ).bind(cutoff).all<{ id: string; project_id: string }>();
  for (const row of results) await removeMilestone(env, row.project_id, row.id);
}

export const listMilestones: Handler = async (_req, env, p) => {
  await requireProject(env, p.id);
  const { results } = await env.DB.prepare(
    `SELECT id, project_id, name, note, word_count, chapter_count, created_at
       FROM milestones WHERE project_id = ? AND complete = 1 ORDER BY created_at DESC, rowid DESC`,
  ).bind(p.id).all<Milestone>();
  return json(results);
};

export const createMilestone: Handler = async (req, env, p) => {
  await requireProject(env, p.id);
  const input = await body<{ name?: unknown; note?: unknown }>(req);
  const name = nameValue(input.name);
  const note = input.note === undefined ? "" : noteValue(input.note);
  const id = newId();
  const createdAt = now();
  try {
    await env.DB.prepare("INSERT INTO milestones (id, project_id, name, note, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(id, p.id, name, note, createdAt).run();
    const { results } = await env.DB.prepare(
      `SELECT ${CHAPTER_COLS} FROM chapters WHERE project_id = ? AND deleted_at IS NULL ORDER BY position`,
    ).bind(p.id).all<ChapterMeta>();
    let words = 0;
    for (const chapter of results) {
      await assertChapterUnlocked(env, chapter.id);
      const row = await reconcileChapter(env, chapter);
      const moveToken = await chapterMoveToken(env, chapter.id);
      await assertChapterUnlocked(env, chapter.id);
      const object = await env.BUCKET.get(chapterKey(p.id, row.id));
      const version = chapterTextVersion(object, row.version);
      if (version === null) throw new Error("Chapter version is invalid");
      const text = object ? await object.text() : "";
      await assertChapterUnlocked(env, chapter.id);
      if (await chapterMoveToken(env, chapter.id) !== moveToken) {
        throw new HttpError(423, "A scene was moved in this chapter. Try again shortly.");
      }
      const wordCount = countWords(text);
      const act = row.act_id ? await env.DB.prepare("SELECT title FROM acts WHERE id = ?")
        .bind(row.act_id).first<{ title: string }>() : null;
      await env.BUCKET.put(milestoneKey(p.id, id, row.id), text, MARKDOWN);
      await env.DB.prepare(
        `INSERT INTO milestone_chapters (milestone_id, chapter_id, position, title, act_title, version, word_count)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, row.id, row.position, row.title, act?.title ?? null, version, wordCount).run();
      words += wordCount;
    }
    await env.DB.prepare("UPDATE milestones SET complete = 1, word_count = ?, chapter_count = ? WHERE id = ?")
      .bind(words, results.length, id).run();
    return json({ id, project_id: p.id, name, note, word_count: words, chapter_count: results.length, created_at: createdAt }, 201);
  } catch (e) {
    try {
      await removeMilestone(env, p.id, id);
    } catch (cleanupError) {
      console.error("milestone cleanup failed", cleanupError);
    }
    if (e instanceof HttpError && e.status === 423) throw e;
    console.error("milestone creation failed", e);
    throw new HttpError(500, "Couldn't save the milestone. Nothing was kept. Try again.");
  }
};

async function getMilestone(env: Env, id: string): Promise<Milestone> {
  const row = await env.DB.prepare(
    `SELECT id, project_id, name, note, word_count, chapter_count, created_at FROM milestones
     WHERE id = ? AND complete = 1 AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)`,
  ).bind(id).first<Milestone>();
  if (!row) throw new HttpError(404, "Milestone not found");
  return row;
}

export const listMilestoneChapters: Handler = async (_req, env, p) => {
  await getMilestone(env, p.id);
  const { results } = await env.DB.prepare(
    "SELECT milestone_id, chapter_id, position, title, act_title, version, word_count FROM milestone_chapters WHERE milestone_id = ? ORDER BY position",
  ).bind(p.id).all<MilestoneChapter>();
  return json(results);
};

export const getMilestoneChapter: Handler = async (_req, env, p) => {
  const milestone = await getMilestone(env, p.id);
  const row = await env.DB.prepare(
    "SELECT milestone_id, chapter_id, position, title, act_title, version, word_count FROM milestone_chapters WHERE milestone_id = ? AND chapter_id = ?",
  ).bind(p.id, p.chapterId).first<MilestoneChapter>();
  if (!row) throw new HttpError(404, "Milestone chapter not found");
  const object = await env.BUCKET.get(milestoneKey(milestone.project_id, p.id, p.chapterId));
  if (!object) throw new HttpError(404, "Milestone chapter text not found");
  return json({ ...row, content: await object.text() });
};

export const updateMilestone: Handler = async (req, env, p) => {
  const row = await getMilestone(env, p.id);
  const input = await body<{ name?: unknown; note?: unknown }>(req);
  const name = input.name === undefined ? row.name : nameValue(input.name);
  const note = input.note === undefined ? row.note : noteValue(input.note);
  await env.DB.prepare("UPDATE milestones SET name = ?, note = ? WHERE id = ?").bind(name, note, p.id).run();
  return json({ ...row, name, note });
};

export const deleteMilestone: Handler = async (req, env, p) => {
  const row = await env.DB.prepare(
    `SELECT id, project_id FROM milestones WHERE id = ? AND complete IN (1, -1)
     AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)`,
  ).bind(p.id).first<{ id: string; project_id: string }>();
  if (!row) throw new HttpError(404, "Milestone not found");
  const confirmed = new URL(req.url).searchParams.get("confirmedLinks");
  let links: string[] | undefined;
  if (confirmed !== null) {
    try {
      const value: unknown = JSON.parse(confirmed);
      if (!Array.isArray(value) || !value.every((id) => typeof id === "string")) throw new Error();
      links = value;
    } catch { throw new HttpError(400, "Review link confirmation is invalid."); }
  }
  try {
    await removeMilestone(env, row.project_id, row.id, links);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error("milestone deletion failed", error);
    throw new HttpError(500, "Couldn't finish deleting the milestone. Its review links may have stopped working. Try again.");
  }
  return json({ ok: true });
};
