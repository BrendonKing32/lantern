import { DIALECTS } from "../../shared/types";
import type { ChapterMeta, DeletedProject, ProjectSummary } from "../../shared/types";
import { CHAPTER_COLS, insertChapter, requireProject } from "../db";
import { body, cleanTitle, HttpError, isDay, json, newId, now, type Handler } from "../http";
import { listActs } from "./acts";

const PROJECT_SUMMARY = `
  SELECT p.id, p.title, p.created_at, p.updated_at, p.archived_at, p.deleted_at,
         COUNT(c.id) AS chapter_count, COALESCE(SUM(c.word_count), 0) AS word_count
    FROM projects p
    LEFT JOIN chapters c ON c.project_id = p.id AND c.deleted_at IS NULL`;

export const listProjects: Handler = async (_req, env) => {
  const { results } = await env.DB.prepare(
    `${PROJECT_SUMMARY} WHERE p.deleted_at IS NULL GROUP BY p.id ORDER BY p.updated_at DESC`,
  ).all<ProjectSummary & { deleted_at: null }>();
  return json(results.map(({ deleted_at: _, ...p }) => p));
};

export const listDeletedProjects: Handler = async (_req, env) => {
  const { results } = await env.DB.prepare(
    `${PROJECT_SUMMARY} WHERE p.deleted_at IS NOT NULL GROUP BY p.id ORDER BY p.deleted_at DESC LIMIT 200`,
  ).all<DeletedProject>();
  return json(
    results.map(({ id, title, deleted_at, chapter_count, word_count }) => ({
      id, title, deleted_at, chapter_count, word_count,
    })),
  );
};

// Bring a deleted novel back to the shelf, with the chapters it had when deleted.
export const restoreProject: Handler = async (_req, env, p) => {
  const res = await env.DB.prepare(
    "UPDATE projects SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL",
  )
    .bind(p.id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, "That novel isn't in Deleted");
  const row = await env.DB.prepare(`${PROJECT_SUMMARY} WHERE p.id = ? GROUP BY p.id`)
    .bind(p.id)
    .first<ProjectSummary & { deleted_at: null }>();
  const { deleted_at: _, ...summary } = row!;
  return json(summary);
};

export const createProject: Handler = async (req, env) => {
  const b = await body<{ title?: string }>(req);
  const id = newId();
  const ts = now();
  const title = cleanTitle(b.title, "Untitled novel");
  await env.DB.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(id, title, ts, ts)
    .run();
  await insertChapter(env, id, "Chapter 1");
  return json({ id, title, created_at: ts, updated_at: ts }, 201);
};

export const getProject: Handler = async (_req, env, p) => {
  const project = await requireProject(env, p.id);
  const { results } = await env.DB.prepare(
    `SELECT ${CHAPTER_COLS} FROM chapters WHERE project_id = ? AND deleted_at IS NULL ORDER BY position`,
  )
    .bind(p.id)
    .all<ChapterMeta>();
  return json({ project, chapters: results, acts: await listActs(env, p.id) });
};

export const updateProject: Handler = async (req, env, p) => {
  const project = await requireProject(env, p.id);
  const b = await body<{ title?: string; archived?: unknown }>(req);
  if (b.archived !== undefined) {
    if (typeof b.archived !== "boolean") throw new HttpError(400, "archived must be true or false");
    // Archiving leaves updated_at alone so the novel keeps its place on the shelf.
    const archivedAt = b.archived ? now() : null;
    await env.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(archivedAt, p.id).run();
    if (b.title === undefined) return json({ id: p.id, title: project.title, archived_at: archivedAt });
  }
  const title = cleanTitle(b.title, "Untitled novel");
  await env.DB.prepare("UPDATE projects SET title = ?, updated_at = ? WHERE id = ?")
    .bind(title, now(), p.id)
    .run();
  return json({ id: p.id, title });
};

export const setTarget: Handler = async (req, env, p) => {
  await requireProject(env, p.id);
  const b = await body<{ target_words?: unknown; target_date?: unknown }>(req);
  const words = b.target_words ?? null;
  const date = b.target_date ?? null;
  if (words !== null && !(Number.isInteger(words) && (words as number) > 0 && (words as number) <= 10_000_000)) {
    throw new HttpError(400, "target_words must be a whole number above zero");
  }
  if (date !== null && !isDay(date)) throw new HttpError(400, "target_date must be YYYY-MM-DD");
  await env.DB.prepare("UPDATE projects SET target_words = ?, target_date = ? WHERE id = ?")
    .bind(words, words === null ? null : date, p.id)
    .run();
  return json({ target_words: words, target_date: words === null ? null : date });
};

export const setDialect: Handler = async (req, env, p) => {
  await requireProject(env, p.id);
  const { dialect } = await body<{ dialect?: unknown }>(req);
  if (!DIALECTS.some((d) => d.id === dialect)) {
    throw new HttpError(400, `dialect must be one of ${DIALECTS.map((d) => d.id).join(", ")}`);
  }
  await env.DB.prepare("UPDATE projects SET dialect = ? WHERE id = ?").bind(dialect, p.id).run();
  return json({ dialect });
};

export const deleteProject: Handler = async (_req, env, p) => {
  await requireProject(env, p.id);
  await env.DB.prepare("UPDATE projects SET deleted_at = ? WHERE id = ?").bind(now(), p.id).run();
  return json({ ok: true });
};
