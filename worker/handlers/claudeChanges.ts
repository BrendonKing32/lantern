import type { ClaudeChange } from "../../shared/types";
import { requireProject } from "../db";
import type { Env } from "../env";
import { json, newId, now, type Handler } from "../http";

const KEEP_DAYS = 180;

/** Changes Claude made to a novel through the connector, newest first. */
export const listClaudeChanges: Handler = async (_req, env, p) => {
  await requireProject(env, p.id);
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, action, target_kind, target_id, chapter_id, summary, detail
       FROM claude_changes WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 200`,
  )
    .bind(p.id)
    .all<ClaudeChange>();
  return json(results);
};

/**
 * Record a change Claude made. Never fails the change itself: the edit is
 * already saved (and chapter text is in History) by the time this runs.
 */
export async function logClaudeChange(
  env: Env,
  change: Omit<ClaudeChange, "id" | "created_at"> & { project_id: string },
): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO claude_changes (id, project_id, created_at, action, target_kind, target_id, chapter_id, summary, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        newId(), change.project_id, now(), change.action, change.target_kind, change.target_id,
        change.chapter_id, change.summary, change.detail,
      ),
      env.DB.prepare("DELETE FROM claude_changes WHERE project_id = ? AND created_at < ?").bind(change.project_id, cutoff),
    ]);
  } catch (e) {
    console.error("couldn't record Claude's change", e);
  }
}
