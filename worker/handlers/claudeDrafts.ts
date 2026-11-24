import { countWords } from "../../shared/wordcount";
import type { ClaudeDraft } from "../../shared/types";
import { chapterPut, claudeDraftKey, getChapterRow } from "../db";
import type { Env } from "../env";
import { body, HttpError, json, now, type Handler } from "../http";
import { snapshotBeforeSave } from "./history";
import { afterChapterWrite } from "../sceneSync";

// Claude's draft of a chapter: changes Claude made through the connector, kept
// beside the chapter until the author accepts or discards them. Accepting puts
// the draft in the chapter (keeping the chapter's text in History first) and
// adds nothing to the author's daily words.

type DraftRow = Omit<ClaudeDraft, "content">;

export async function draftRow(env: Env, chapterId: string): Promise<DraftRow | null> {
  return env.DB.prepare(
    `SELECT chapter_id, version, base_version, word_count, created_at, updated_at
       FROM claude_drafts WHERE chapter_id = ?`,
  )
    .bind(chapterId)
    .first<DraftRow>();
}

/** The chapter's draft by Claude with its text, or null if there isn't one. */
export async function readClaudeDraft(env: Env, projectId: string, chapterId: string): Promise<ClaudeDraft | null> {
  const row = await draftRow(env, chapterId);
  if (!row) return null;
  const obj = await env.BUCKET.get(claudeDraftKey(projectId, chapterId));
  if (!obj) throw new HttpError(404, "The text of Claude's draft is missing from storage");
  return { ...row, content: await obj.text() };
}

// Leave the text alone if Claude has already begun a new draft in the meantime.
async function removeDraftText(env: Env, projectId: string, chapterId: string) {
  try {
    if (!(await draftRow(env, chapterId))) await env.BUCKET.delete(claudeDraftKey(projectId, chapterId));
  } catch (e) {
    console.error("couldn't remove the text of Claude's draft", e);
  }
}

export const getClaudeDraft: Handler = async (_req, env, p) => {
  const chapter = await getChapterRow(env, p.id);
  return json(await readClaudeDraft(env, chapter.project_id, chapter.id));
};

/**
 * Put Claude's draft in the chapter. Needs the chapter version on screen and
 * the draft version the author reviewed, so neither changes unseen.
 */
export const acceptClaudeDraft: Handler = async (req, env, p) => {
  const b = await body<{ baseVersion?: unknown; draftVersion?: unknown }>(req);
  if (typeof b.baseVersion !== "number") throw new HttpError(400, "baseVersion must be a number");
  if (typeof b.draftVersion !== "number") throw new HttpError(400, "draftVersion must be a number");
  const row = await getChapterRow(env, p.id);
  const draft = await readClaudeDraft(env, row.project_id, row.id);
  if (!draft) throw new HttpError(404, "Claude's draft of this chapter is no longer there. It may have been accepted or discarded on another device.");
  if (draft.version !== b.draftVersion) {
    throw new HttpError(409, "Claude changed this draft while you were reviewing it. Look it over again, then accept it.", {
      code: "draft_changed",
    });
  }

  const ts = now();
  const words = countWords(draft.content);
  const claim = await env.DB.prepare(
    `UPDATE chapters SET version = version + 1, word_count = ?, updated_at = ?
      WHERE id = ? AND version = ? AND deleted_at IS NULL`,
  )
    .bind(words, ts, row.id, b.baseVersion)
    .run();
  if (!claim.meta.changes) {
    throw new HttpError(409, "This chapter was saved somewhere else. Open it again, then accept the draft.", {
      version: row.version,
    });
  }
  const rollBack = () =>
    env.DB.prepare("UPDATE chapters SET version = ?, word_count = ?, updated_at = ? WHERE id = ? AND version = ?")
      .bind(b.baseVersion, row.word_count, row.updated_at, row.id, (b.baseVersion as number) + 1)
      .run();

  try {
    await snapshotBeforeSave(env, { ...row, version: b.baseVersion }, "claude");
  } catch (e) {
    console.error("snapshot before accepting Claude's draft failed", e);
    await rollBack();
    throw new HttpError(500, "Lantern couldn't keep a copy of the chapter in History, so the draft wasn't accepted. Try again.");
  }
  try {
    await chapterPut(env, row, draft.content, b.baseVersion + 1);
  } catch (e) {
    await rollBack();
    throw e;
  }
  await afterChapterWrite(env, row, draft.content, b.baseVersion + 1);
  // Claude's words aren't the author's writing, so daily_words is left alone.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM claude_drafts WHERE chapter_id = ? AND version = ?").bind(row.id, draft.version),
    env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(ts, row.project_id),
  ]);
  await removeDraftText(env, row.project_id, row.id);
  return json({ ...row, version: b.baseVersion + 1, word_count: words, updated_at: ts, content: draft.content });
};

export const discardClaudeDraft: Handler = async (_req, env, p) => {
  const row = await getChapterRow(env, p.id);
  await env.DB.prepare("DELETE FROM claude_drafts WHERE chapter_id = ?").bind(row.id).run();
  await removeDraftText(env, row.project_id, row.id);
  return json({ ok: true });
};
