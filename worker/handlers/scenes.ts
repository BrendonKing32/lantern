import type { SceneMeta } from "../../shared/types";
import { getChapterRow, requireProject } from "../db";
import type { Env } from "../env";
import { body, cleanTitle, HttpError, json, newId, now, type Handler } from "../http";

const SCENE_COLS =
  "id, project_id, chapter_id, title, summary, pov, location, status, position, created_at, updated_at";

async function getSceneRow(env: Env, id: string): Promise<SceneMeta> {
  const row = await env.DB.prepare(
    `SELECT ${SCENE_COLS} FROM scenes
      WHERE id = ? AND chapter_id IN (
        SELECT id FROM chapters WHERE deleted_at IS NULL
          AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)
      )`,
  )
    .bind(id)
    .first<SceneMeta>();
  if (!row) throw new HttpError(404, "Scene not found");
  return row;
}

export const listScenes: Handler = async (_req, env, p) => {
  await requireProject(env, p.id);
  const { results } = await env.DB.prepare(
    `SELECT ${SCENE_COLS} FROM scenes
      WHERE project_id = ? AND chapter_id IN (
        SELECT id FROM chapters WHERE deleted_at IS NULL
      )
      ORDER BY (SELECT position FROM chapters WHERE chapters.id = scenes.chapter_id), position`,
  )
    .bind(p.id)
    .all<SceneMeta>();
  return json(results);
};

export const createScene: Handler = async (_req, env, p) => {
  const chapter = await getChapterRow(env, p.id);
  const max = await env.DB.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM scenes WHERE chapter_id = ?")
    .bind(chapter.id)
    .first<{ m: number }>();
  const ts = now();
  const scene: SceneMeta = {
    id: newId(),
    project_id: chapter.project_id,
    chapter_id: chapter.id,
    title: "New scene",
    summary: "",
    pov: "",
    location: "",
    status: "planned",
    position: (max?.m ?? -1) + 1,
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
  return json(scene, 201);
};

export const updateScene: Handler = async (req, env, p) => {
  const scene = await getSceneRow(env, p.id);
  const b = await body<{ title?: unknown; summary?: unknown; pov?: unknown; location?: unknown; status?: unknown }>(req);
  for (const field of ["title", "summary", "pov", "location"] as const) {
    if (b[field] !== undefined && typeof b[field] !== "string") {
      throw new HttpError(400, `${field} must be a string`);
    }
  }
  if (b.status !== undefined && b.status !== "planned" && b.status !== "drafted") {
    throw new HttpError(400, "status must be planned or drafted");
  }
  const updated: SceneMeta = {
    ...scene,
    title: b.title === undefined ? scene.title : cleanTitle(b.title, scene.title),
    summary: typeof b.summary === "string" ? b.summary.slice(0, 2000) : scene.summary,
    pov: typeof b.pov === "string" ? b.pov.slice(0, 120) : scene.pov,
    location: typeof b.location === "string" ? b.location.slice(0, 120) : scene.location,
    status: b.status === undefined ? scene.status : b.status,
    updated_at: now(),
  };
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE scenes SET title = ?, summary = ?, pov = ?, location = ?, status = ?, updated_at = ? WHERE id = ?",
    ).bind(updated.title, updated.summary, updated.pov, updated.location, updated.status, updated.updated_at, scene.id),
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

export const reorderScenes: Handler = async (req, env, p) => {
  await requireProject(env, p.id);
  const b = await body<{ chapterId?: unknown; sceneIds?: unknown }>(req);
  if (typeof b.chapterId !== "string" || !Array.isArray(b.sceneIds) || !b.sceneIds.every((x) => typeof x === "string")) {
    throw new HttpError(400, "chapterId and sceneIds are required");
  }
  const chapter = await getChapterRow(env, b.chapterId);
  if (chapter.project_id !== p.id) throw new HttpError(404, "Chapter not found");
  const { results } = await env.DB.prepare("SELECT id FROM scenes WHERE chapter_id = ?")
    .bind(chapter.id)
    .all<{ id: string }>();
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
