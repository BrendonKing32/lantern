import { countWords } from "../../shared/wordcount";
import type { ChapterMeta, Snapshot, SnapshotReason } from "../../shared/types";
import { getChapterRow, chapterKey, MARKDOWN, snapshotKey } from "../db";
import type { Env } from "../env";
import { HttpError, json, newId, now, type Handler } from "../http";

// While someone keeps writing, keep at most one automatic snapshot per window.
const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Copy the chapter's current text into its history before it's overwritten.
 * Automatic snapshots are rate-limited; moves, restores, replacements and conflict
 * overwrites always keep a copy. Empty text is never worth keeping.
 */
export async function snapshotBeforeSave(
  env: Env,
  row: ChapterMeta,
  reason: SnapshotReason,
  contentOverride?: string,
): Promise<string> {
  if (reason === "auto") {
    const last = await env.DB.prepare(
      "SELECT created_at FROM chapter_snapshots WHERE chapter_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(row.id)
      .first<{ created_at: string }>();
    if (last && Date.now() - Date.parse(last.created_at) < SNAPSHOT_INTERVAL_MS) return "";
  }
  const obj = contentOverride === undefined ? await env.BUCKET.get(chapterKey(row.project_id, row.id)) : null;
  const text = contentOverride ?? (obj ? await obj.text() : "");
  if (!text.trim()) return text;
  const id = newId();
  await env.BUCKET.put(snapshotKey(row.project_id, row.id, id), text, MARKDOWN);
  await env.DB.prepare(
    "INSERT INTO chapter_snapshots (id, chapter_id, version, word_count, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, row.id, row.version, countWords(text), reason, now())
    .run();
  return text;
}

export const listHistory: Handler = async (_req, env, p) => {
  const row = await getChapterRow(env, p.id);
  const { results } = await env.DB.prepare(
    `SELECT id, version, word_count, reason, created_at FROM chapter_snapshots
      WHERE chapter_id = ? ORDER BY created_at DESC LIMIT 500`,
  )
    .bind(row.id)
    .all<Snapshot>();
  return json(results);
};

export const getSnapshot: Handler = async (_req, env, p) => {
  const row = await getChapterRow(env, p.id);
  const snap = await env.DB.prepare(
    "SELECT id, version, word_count, reason, created_at FROM chapter_snapshots WHERE id = ? AND chapter_id = ?",
  )
    .bind(p.snapshotId, row.id)
    .first<Snapshot>();
  if (!snap) throw new HttpError(404, "That version wasn't found");
  const obj = await env.BUCKET.get(snapshotKey(row.project_id, row.id, snap.id));
  if (!obj) throw new HttpError(404, "That version's text is missing from storage");
  return json({ ...snap, content: await obj.text() });
};
