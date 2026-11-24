import { arrangeChapters } from "../../shared/acts";
import type { Act, ChapterMeta, Outline } from "../../shared/types";
import { CHAPTER_COLS, requireProject } from "../db";
import type { Env } from "../env";
import { body, cleanTitle, HttpError, json, newId, now, type Handler } from "../http";

// Acts group chapters. Book order always runs: chapters with no act, then each
// act's chapters in act order. Every change here rewrites chapter positions to
// keep that true, so export, sharing and the connector can read chapters by
// position alone.

const ACT_COLS = "id, project_id, title, position";

export async function listActs(env: Env, projectId: string): Promise<Act[]> {
  const { results } = await env.DB.prepare(`SELECT ${ACT_COLS} FROM acts WHERE project_id = ? ORDER BY position`)
    .bind(projectId)
    .all<Act>();
  return results;
}

async function liveChapters(env: Env, projectId: string): Promise<ChapterMeta[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${CHAPTER_COLS} FROM chapters WHERE project_id = ? AND deleted_at IS NULL ORDER BY position`,
  )
    .bind(projectId)
    .all<ChapterMeta>();
  return results;
}

export async function getOutline(env: Env, projectId: string): Promise<Outline> {
  const [acts, chapters] = await Promise.all([listActs(env, projectId), liveChapters(env, projectId)]);
  return { acts, chapters };
}

/**
 * Save a new arrangement: acts in `acts` order, chapters in `chapters` order
 * with the act each names. Positions are rewritten so every act's chapters
 * sit together.
 */
async function saveArrangement(env: Env, projectId: string, acts: Act[], chapters: ChapterMeta[]): Promise<Outline> {
  const orderedActs = acts.map((a, i) => ({ ...a, position: i }));
  const ordered = arrangeChapters(
    chapters.map((c, i) => ({ ...c, position: i })),
    orderedActs,
  );
  const ts = now();
  await env.DB.batch([
    ...orderedActs.map((a) =>
      env.DB.prepare("UPDATE acts SET position = ? WHERE id = ? AND project_id = ?").bind(a.position, a.id, projectId),
    ),
    ...ordered.map((c) =>
      env.DB.prepare("UPDATE chapters SET position = ?, act_id = ? WHERE id = ? AND project_id = ?").bind(
        c.position,
        c.act_id,
        c.id,
        projectId,
      ),
    ),
    env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(ts, projectId),
  ]);
  return { acts: orderedActs, chapters: ordered };
}

/**
 * PUT /api/projects/:id/order. `chapterIds` is the whole book in order.
 * Optional `actIds` (every act, in order) and `chapterActs` (chapter id → act
 * id or null) move chapters between acts and reorder the acts. Chapters left
 * out of `chapterActs` keep their act.
 */
export const reorderChapters: Handler = async (req, env, p) => {
  await requireProject(env, p.id);
  const b = await body<{ chapterIds?: unknown; actIds?: unknown; chapterActs?: unknown }>(req);
  if (!Array.isArray(b.chapterIds) || !b.chapterIds.every((x) => typeof x === "string")) {
    throw new HttpError(400, "chapterIds must be an array of ids");
  }
  const ids = b.chapterIds as string[];
  const { acts, chapters } = await getOutline(env, p.id);
  const byId = new Map(chapters.map((c) => [c.id, c]));
  if (ids.length !== byId.size || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id))) {
    throw new HttpError(409, "Chapter list is out of date; reload and try again");
  }

  let actOrder = acts;
  if (b.actIds !== undefined) {
    const actById = new Map(acts.map((a) => [a.id, a]));
    if (
      !Array.isArray(b.actIds) ||
      b.actIds.length !== acts.length ||
      new Set(b.actIds).size !== acts.length ||
      !b.actIds.every((x) => typeof x === "string" && actById.has(x))
    ) {
      throw new HttpError(409, "The acts are out of date; reload and try again");
    }
    actOrder = (b.actIds as string[]).map((id) => actById.get(id)!);
  }

  const moves = new Map<string, string | null>();
  if (b.chapterActs !== undefined) {
    if (typeof b.chapterActs !== "object" || b.chapterActs === null || Array.isArray(b.chapterActs)) {
      throw new HttpError(400, "chapterActs must map chapter ids to act ids");
    }
    const actIds = new Set(acts.map((a) => a.id));
    for (const [chapterId, actId] of Object.entries(b.chapterActs)) {
      if (!byId.has(chapterId)) throw new HttpError(409, "Chapter list is out of date; reload and try again");
      if (actId !== null && (typeof actId !== "string" || !actIds.has(actId))) {
        throw new HttpError(409, "The acts are out of date; reload and try again");
      }
      moves.set(chapterId, actId as string | null);
    }
  }

  const next = ids.map((id) => {
    const c = byId.get(id)!;
    return moves.has(id) ? { ...c, act_id: moves.get(id)! } : c;
  });
  await saveArrangement(env, p.id, actOrder, next);
  return json({ ok: true });
};

/**
 * POST /api/projects/:id/acts. With `startChapterId`, the new act begins at
 * that chapter and takes it and the chapters after it in its act; the new act
 * goes right after that one. Without it, the new act is empty, at the end.
 */
export const createAct: Handler = async (req, env, p) => {
  await requireProject(env, p.id);
  const b = await body<{ title?: unknown; startChapterId?: unknown }>(req);
  const { acts, chapters } = await getOutline(env, p.id);
  const ts = now();
  const act: Act = {
    id: newId(),
    project_id: p.id,
    title: cleanTitle(b.title, `Act ${acts.length + 1}`),
    position: acts.length,
  };

  let actOrder = [...acts, act];
  let next = chapters;
  if (b.startChapterId !== undefined && b.startChapterId !== null) {
    const start = chapters.findIndex((c) => c.id === b.startChapterId);
    if (start < 0) throw new HttpError(404, "Chapter not found");
    // Chapters are stored in book order, so the rest of this chapter's act
    // is every later chapter in the same act.
    const from = chapters[start].act_id;
    next = chapters.map((c, i) => (i >= start && c.act_id === from ? { ...c, act_id: act.id } : c));
    const at = from === null ? 0 : acts.findIndex((a) => a.id === from) + 1;
    actOrder = [...acts.slice(0, at), act, ...acts.slice(at)];
  }

  await env.DB.prepare(
    "INSERT INTO acts (id, project_id, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(act.id, p.id, act.title, act.position, ts, ts)
    .run();
  return json(await saveArrangement(env, p.id, actOrder, next), 201);
};

async function getAct(env: Env, id: string): Promise<Act> {
  const act = await env.DB.prepare(
    `SELECT ${ACT_COLS} FROM acts WHERE id = ? AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)`,
  )
    .bind(id)
    .first<Act>();
  if (!act) throw new HttpError(404, "Act not found");
  return act;
}

export const updateAct: Handler = async (req, env, p) => {
  const act = await getAct(env, p.id);
  const b = await body<{ title?: unknown }>(req);
  const title = cleanTitle(b.title, act.title);
  await env.DB.prepare("UPDATE acts SET title = ?, updated_at = ? WHERE id = ?").bind(title, now(), act.id).run();
  return json({ ...act, title });
};

/**
 * DELETE /api/acts/:id removes the grouping only. Its chapters stay where they
 * are in the book and join the act before it (or no act, for the first one).
 */
export const deleteAct: Handler = async (_req, env, p) => {
  const act = await getAct(env, p.id);
  const { acts, chapters } = await getOutline(env, act.project_id);
  const index = acts.findIndex((a) => a.id === act.id);
  const into = index > 0 ? acts[index - 1].id : null;
  // Deleted chapters keep an act too; point them at the same place.
  await env.DB.prepare("UPDATE chapters SET act_id = ? WHERE act_id = ? AND deleted_at IS NOT NULL")
    .bind(into, act.id)
    .run();
  const outline = await saveArrangement(
    env,
    act.project_id,
    acts.filter((a) => a.id !== act.id),
    chapters.map((c) => (c.act_id === act.id ? { ...c, act_id: into } : c)),
  );
  await env.DB.prepare("DELETE FROM acts WHERE id = ?").bind(act.id).run();
  return json(outline);
};
