import type { ChapterMeta, ProjectInfo } from "../shared/types";
import type { Env } from "./env";
import { HttpError, newId, now } from "./http";

// Data access shared by several feature areas.

export const MAX_CHAPTER_BYTES = 5 * 1024 * 1024;

export const CHAPTER_COLS =
  "id, project_id, title, synopsis, position, word_count, version, updated_at, act_id";

export const chapterKey = (projectId: string, chapterId: string) =>
  `projects/${projectId}/chapters/${chapterId}.md`;
export const snapshotKey = (projectId: string, chapterId: string, snapshotId: string) =>
  `projects/${projectId}/chapters/${chapterId}/history/${snapshotId}.md`;
export const MARKDOWN = { httpMetadata: { contentType: "text/markdown; charset=utf-8" } };

export function chapterPut(env: Env, row: Pick<ChapterMeta, "project_id" | "id">, text: string, version: number) {
  return env.BUCKET.put(chapterKey(row.project_id, row.id), text, {
    ...MARKDOWN,
    customMetadata: { version: String(version) },
  });
}

export function chapterTextVersion(object: R2ObjectBody | null, fallback: number): number | null {
  const value = object?.customMetadata?.version;
  if (value === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  const version = Number(value);
  return Number.isSafeInteger(version) ? version : null;
}

export async function getChapterRow(env: Env, id: string): Promise<ChapterMeta> {
  const row = await env.DB.prepare(
    `SELECT ${CHAPTER_COLS} FROM chapters
      WHERE id = ? AND deleted_at IS NULL
        AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)`,
  )
    .bind(id)
    .first<ChapterMeta>();
  if (!row) throw new HttpError(404, "Chapter not found");
  return row;
}

export async function requireProject(env: Env, id: string): Promise<ProjectInfo> {
  const row = await env.DB.prepare(
    `SELECT id, title, created_at, updated_at, target_words, target_date, dialect
       FROM projects WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(id)
    .first<ProjectInfo>();
  if (!row) throw new HttpError(404, "Project not found");
  return row;
}

export async function insertChapter(env: Env, projectId: string, title: string): Promise<ChapterMeta> {
  const max = await env.DB.prepare(
    "SELECT COALESCE(MAX(position), -1) AS m FROM chapters WHERE project_id = ? AND deleted_at IS NULL",
  )
    .bind(projectId)
    .first<{ m: number }>();
  const id = newId();
  const ts = now();
  const position = (max?.m ?? -1) + 1;
  // A new chapter goes at the end of the book, so into the last act.
  const actId = await lastActId(env, projectId);
  await chapterPut(env, { project_id: projectId, id }, "", 0);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO chapters (id, project_id, title, position, act_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, projectId, title, position, actId, ts, ts),
    env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(ts, projectId),
  ]);
  return {
    id, project_id: projectId, title, synopsis: "", position,
    word_count: 0, version: 0, updated_at: ts, act_id: actId,
  };
}

export async function lastActId(env: Env, projectId: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT id FROM acts WHERE project_id = ? ORDER BY position DESC LIMIT 1")
    .bind(projectId)
    .first<{ id: string }>();
  return row?.id ?? null;
}
