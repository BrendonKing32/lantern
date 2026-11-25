import { replayDraft } from "../../shared/draftReplay";
import type { ClaudeDraft } from "../../shared/types";
import { assertChapterUnlocked, chapterKey, claudeDraftKey, getChapterRow, MAX_CHAPTER_BYTES, reconcileChapter } from "../db";
import type { Env } from "../env";
import { body, HttpError, json, type Handler } from "../http";
import { afterChapterWrite } from "../sceneSync";
import { writeChapter } from "./chapters";
import { logClaudeChange } from "./claudeChanges";

// AI draft of a chapter: changes made through MCP clients, kept
// beside the chapter until the author accepts or discards them. Accepting puts
// the draft in the chapter (keeping the chapter's text in History first) and
// adds nothing to the author's daily words.
// Legacy Claude names in storage and API paths stay unchanged for compatibility.

type DraftRow = Omit<ClaudeDraft, "content">;

export async function draftRow(env: Env, chapterId: string): Promise<DraftRow | null> {
  const row = await env.DB.prepare(
    `SELECT chapter_id, version, base_version, word_count, ops, created_at, updated_at
       FROM claude_drafts WHERE chapter_id = ?`,
  )
    .bind(chapterId)
    .first<Omit<DraftRow, "ops"> & { ops: string }>();
  return row ? { ...row, ops: JSON.parse(row.ops) } : null;
}

/** The chapter's AI draft with its text, or null if there isn't one. */
export async function readClaudeDraft(env: Env, projectId: string, chapterId: string): Promise<ClaudeDraft | null> {
  const row = await draftRow(env, chapterId);
  if (!row) return null;
  const obj = await env.BUCKET.get(claudeDraftKey(projectId, chapterId));
  if (!obj) throw new HttpError(404, "The AI draft's text is missing from storage. Discard the draft and ask your AI client to try again.");
  return { ...row, content: await obj.text() };
}

// Leave the text alone if a client has already begun a new draft in the meantime.
async function removeDraftText(env: Env, projectId: string, chapterId: string) {
  try {
    if (!(await draftRow(env, chapterId))) await env.BUCKET.delete(claudeDraftKey(projectId, chapterId));
  } catch (e) {
    console.error("couldn't remove the text of the AI draft", e);
  }
}

export const getClaudeDraft: Handler = async (_req, env, p) => {
  const chapter = await getChapterRow(env, p.id);
  return json(await readClaudeDraft(env, chapter.project_id, chapter.id));
};

/**
 * Put the AI draft in the chapter. Needs the chapter version on screen and
 * the draft version the author reviewed, so neither changes unseen.
 */
export const acceptClaudeDraft: Handler = async (req, env, p) => {
  const b = await body<{ baseVersion?: unknown; draftVersion?: unknown; mode?: unknown; expectedText?: unknown }>(req);
  if (typeof b.baseVersion !== "number") throw new HttpError(400, "baseVersion must be a number");
  if (typeof b.draftVersion !== "number") throw new HttpError(400, "draftVersion must be a number");
  if (b.mode !== "as-drafted" && b.mode !== "replayed") throw new HttpError(400, "Choose how to accept the draft");
  if (b.mode === "replayed" && typeof b.expectedText !== "string") throw new HttpError(400, "expectedText must be text");
  await assertChapterUnlocked(env, p.id);
  const row = await reconcileChapter(env, await getChapterRow(env, p.id));
  const draft = await readClaudeDraft(env, row.project_id, row.id);
  if (!draft) throw new HttpError(404, "The AI draft of this chapter is no longer there. It may have been accepted or discarded on another device.");
  if (draft.version !== b.draftVersion) {
    throw new HttpError(409, "An AI client changed this draft while you were reviewing it. Look it over again, then accept it.", {
      code: "draft_changed",
    });
  }

  if (row.version !== b.baseVersion) {
    throw new HttpError(409, "This chapter was saved somewhere else. Open it again, then accept the draft.", {
      version: row.version,
    });
  }
  let content = draft.content;
  let applied = draft.ops.length;
  if (b.mode === "as-drafted") {
    if (draft.base_version !== row.version) throw new HttpError(409, "The chapter changed since this draft began. Look it over again.");
  } else {
    const obj = await env.BUCKET.get(chapterKey(row.project_id, row.id));
    const replay = replayDraft(obj ? await obj.text() : "", draft.ops);
    if (replay.text !== b.expectedText) {
      throw new HttpError(409, "The chapter changed again while you were reviewing. Look it over again.");
    }
    if (!replay.applied) throw new HttpError(409, "None of the AI edits fit the chapter any more.");
    content = replay.text;
    applied = replay.applied;
  }
  if (new TextEncoder().encode(content).length > MAX_CHAPTER_BYTES) throw new HttpError(413, "Chapter is too large (5 MB limit)");
  const saved = await writeChapter(env, row, content, b.baseVersion, "claude", { draftVersion: draft.version });
  await afterChapterWrite(env, row, content, saved.version);
  // AI words aren't the author's writing, so daily_words is left alone.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM claude_drafts WHERE chapter_id = ? AND version = ?").bind(row.id, draft.version),
    env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(saved.updated_at, row.project_id),
  ]);
  await removeDraftText(env, row.project_id, row.id);
  await logClaudeChange(env, {
    project_id: row.project_id, action: "accept_draft", target_kind: "chapter", target_id: row.id,
    chapter_id: row.id, summary: `Accepted the AI draft of “${row.title}”` +
      (applied < draft.ops.length ? ` (${applied} of ${draft.ops.length} edits applied)` : ""),
    detail: "",
  });
  return json({ ...row, ...saved, content });
};

export const discardClaudeDraft: Handler = async (_req, env, p) => {
  const row = await getChapterRow(env, p.id);
  await env.DB.prepare("DELETE FROM claude_drafts WHERE chapter_id = ?").bind(row.id).run();
  await removeDraftText(env, row.project_id, row.id);
  await logClaudeChange(env, {
    project_id: row.project_id, action: "discard_draft", target_kind: "chapter", target_id: row.id,
    chapter_id: row.id, summary: `Discarded the AI draft of “${row.title}”`, detail: "",
  });
  return json({ ok: true });
};
