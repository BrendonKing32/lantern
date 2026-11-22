import type { SceneMeta } from "../../shared/types";
import { getChapterRow, requireProject } from "../db";
import type { Env } from "../env";
import { body, cleanTitle, HttpError, json, newId, now, type Handler } from "../http";

// Scene cards belong to a novel. A chapter is optional: a scene with no
// chapter is "unassigned" and can be placed in (or taken out of) a chapter
// later. Positions count within a scene's group (one chapter, or the
// unassigned scenes).

const SCENE_COLS =
  "id, project_id, chapter_id, title, summary, pov, location, status, position, created_at, updated_at";

// A scene is visible while its novel is, and, when it has a chapter, while
// that chapter is. Scenes of a deleted chapter come back if it's restored.
const VISIBLE = `project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)
  AND (chapter_id IS NULL OR chapter_id IN (SELECT id FROM chapters WHERE deleted_at IS NULL))`;

async function getSceneRow(env: Env, id: string): Promise<SceneMeta> {
  const row = await env.DB.prepare(`SELECT ${SCENE_COLS} FROM scenes WHERE id = ? AND ${VISIBLE}`)
    .bind(id)
    .first<SceneMeta>();
  if (!row) throw new HttpError(404, "Scene not found");
  return row;
}

async function nextPosition(env: Env, projectId: string, chapterId: string | null): Promise<number> {
  const max = chapterId === null
    ? await env.DB.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM scenes WHERE project_id = ? AND chapter_id IS NULL")
      .bind(projectId)
      .first<{ m: number }>()
    : await env.DB.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM scenes WHERE chapter_id = ?")
      .bind(chapterId)
      .first<{ m: number }>();
  return (max?.m ?? -1) + 1;
}

/** Check a chapter id from a request belongs to the novel; null means no chapter. */
async function chapterIn(env: Env, projectId: string, chapterId: unknown): Promise<string | null> {
  if (chapterId === null) return null;
  if (typeof chapterId !== "string") throw new HttpError(400, "chapterId must be a chapter id or null");
  const chapter = await getChapterRow(env, chapterId);
  if (chapter.project_id !== projectId) throw new HttpError(404, "Chapter not found");
  return chapter.id;
}

export const listScenes: Handler = async (_req, env, p) => {
  await requireProject(env, p.id);
  const { results } = await env.DB.prepare(
    `SELECT ${SCENE_COLS} FROM scenes
      WHERE project_id = ? AND ${VISIBLE}
      ORDER BY chapter_id IS NOT NULL,
        (SELECT position FROM chapters WHERE chapters.id = scenes.chapter_id), position`,
  )
    .bind(p.id)
    .all<SceneMeta>();
  return json(results);
};

async function insertScene(env: Env, projectId: string, chapterId: string | null): Promise<SceneMeta> {
  const ts = now();
  const scene: SceneMeta = {
    id: newId(),
    project_id: projectId,
    chapter_id: chapterId,
    title: "New scene",
    summary: "",
    pov: "",
    location: "",
    status: "planned",
    position: await nextPosition(env, projectId, chapterId),
    created_at: ts,
    updated_at: ts,
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO scenes (${SCENE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      scene.id, scene.project_id, scene.chapter_id, scene.title, scene.summary, scene.pov,
      scene.location, scene.status, scene.position, scene.created_at, scene.updated_at,
    ),
    env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(ts, scene.project_id),
  ]);
  return scene;
}

/** POST /api/projects/:id/scenes — a new scene, unassigned unless the body names a chapterId. */
export const createProjectScene: Handler = async (req, env, p) => {
  await requireProject(env, p.id);
  // The body is optional: no body makes an unassigned scene.
  const b = ((await body<{ chapterId?: unknown } | null>(req).catch(() => null)) ?? {}) as { chapterId?: unknown };
  const chapterId = b.chapterId === undefined ? null : await chapterIn(env, p.id, b.chapterId);
  return json(await insertScene(env, p.id, chapterId), 201);
};

/** POST /api/chapters/:id/scenes — a new scene at the end of that chapter. */
export const createScene: Handler = async (_req, env, p) => {
  const chapter = await getChapterRow(env, p.id);
  return json(await insertScene(env, chapter.project_id, chapter.id), 201);
};

export const updateScene: Handler = async (req, env, p) => {
  const scene = await getSceneRow(env, p.id);
  const b = await body<{
    title?: unknown; summary?: unknown; pov?: unknown; location?: unknown; status?: unknown; chapter_id?: unknown;
  }>(req);
  for (const field of ["title", "summary", "pov", "location"] as const) {
    if (b[field] !== undefined && typeof b[field] !== "string") {
      throw new HttpError(400, `${field} must be a string`);
    }
  }
  if (b.status !== undefined && b.status !== "planned" && b.status !== "drafted") {
    throw new HttpError(400, "status must be planned or drafted");
  }
  const chapterId = b.chapter_id === undefined ? scene.chapter_id : await chapterIn(env, scene.project_id, b.chapter_id);
  const moved = chapterId !== scene.chapter_id;
  const updated: SceneMeta = {
    ...scene,
    title: b.title === undefined ? scene.title : cleanTitle(b.title, scene.title),
    summary: typeof b.summary === "string" ? b.summary.slice(0, 2000) : scene.summary,
    pov: typeof b.pov === "string" ? b.pov.slice(0, 120) : scene.pov,
    location: typeof b.location === "string" ? b.location.slice(0, 120) : scene.location,
    status: b.status === undefined ? scene.status : b.status,
    chapter_id: chapterId,
    // A scene placed in another chapter (or unassigned) goes to the end of its new group.
    position: moved ? await nextPosition(env, scene.project_id, chapterId) : scene.position,
    updated_at: now(),
  };
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE scenes SET title = ?, summary = ?, pov = ?, location = ?, status = ?, chapter_id = ?, position = ?, updated_at = ?
        WHERE id = ?`,
    ).bind(
      updated.title, updated.summary, updated.pov, updated.location, updated.status,
      updated.chapter_id, updated.position, updated.updated_at, scene.id,
    ),
    env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(updated.updated_at, scene.project_id),
  ]);
  return json(updated);
};

export const deleteScene: Handler = async (_req, env, p) => {
  const scene = await getSceneRow(env, p.id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM scenes WHERE id = ?").bind(scene.id),
    env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(now(), scene.project_id),
  ]);
  return json({ ok: true });
};

/** PUT /api/projects/:id/scenes/order — reorder one group; chapterId null means the unassigned scenes. */
export const reorderScenes: Handler = async (req, env, p) => {
  await requireProject(env, p.id);
  const b = await body<{ chapterId?: unknown; sceneIds?: unknown }>(req);
  if (b.chapterId === undefined || !Array.isArray(b.sceneIds) || !b.sceneIds.every((x) => typeof x === "string")) {
    throw new HttpError(400, "chapterId and sceneIds are required");
  }
  const chapterId = await chapterIn(env, p.id, b.chapterId);
  const { results } = await (chapterId === null
    ? env.DB.prepare("SELECT id FROM scenes WHERE project_id = ? AND chapter_id IS NULL").bind(p.id)
    : env.DB.prepare("SELECT id FROM scenes WHERE chapter_id = ?").bind(chapterId)
  ).all<{ id: string }>();
  const existing = new Set(results.map((r) => r.id));
  const ids = b.sceneIds as string[];
  if (ids.length !== existing.size || !ids.every((id) => existing.has(id)) || new Set(ids).size !== ids.length) {
    throw new HttpError(409, "Scene list is out of date; reload and try again");
  }
  await env.DB.batch([
    ...ids.map((id, i) => env.DB.prepare("UPDATE scenes SET position = ? WHERE id = ?").bind(i, id)),
    env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(now(), p.id),
  ]);
  return json({ ok: true });
};
