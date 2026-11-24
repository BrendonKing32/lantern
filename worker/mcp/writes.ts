// Tools that change the novel. Registered only for connections the author
// allowed to edit (the lantern:write scope).
//
// Chapter text: Claude never changes a chapter directly. Its edits go into
// Claude's draft of the chapter, kept beside it until the author accepts or
// discards it in the app. Every edit needs the version Claude read (the
// chapter's, or the draft's once there is one), so nothing changes unseen.
// Claude's words don't count toward the author's daily words.
//
// Story guide, scenes and chapter details go through the app's own handlers,
// so they follow exactly the same rules as edits made in the app.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { countWords } from "../../shared/wordcount";
import type { BibleEntry, ChapterMeta, DraftOp, SceneMeta } from "../../shared/types";
import { BIBLE_KINDS } from "../../shared/types";
import { replayDraft } from "../../shared/draftReplay";
import { assertChapterUnlocked, chapterKey, claudeDraftKey, getChapterRow, MARKDOWN, MAX_CHAPTER_BYTES, reconcileChapter } from "../db";
import type { Env } from "../env";
import { createEntry, updateEntry } from "../handlers/bible";
import { logClaudeChange } from "../handlers/claudeChanges";
import { createChapter, updateChapter } from "../handlers/chapters";
import { draftRow } from "../handlers/claudeDrafts";
import { arrangeScenes, createProjectScene, moveScene, sceneListing, updateScene } from "../handlers/scenes";
import { HttpError, now, type Handler, type Params } from "../http";

const EDITS = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
const ADDS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const data = (value: unknown) => text(JSON.stringify(value, null, 1));

/** Run one of the app's handlers with a JSON body, as if the app had called it. */
async function viaApp<T>(handler: Handler, params: Params, method: string, payload: unknown, env: Env): Promise<T> {
  const req = new Request("https://lantern.internal/", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const res = await handler(req, env, params);
  return (await res.json()) as T;
}

// ---------- chapter text ----------

export class EditError extends Error {}

async function assertEditable(env: Env, chapterId: string): Promise<void> {
  try {
    await assertChapterUnlocked(env, chapterId);
  } catch (e) {
    if (e instanceof HttpError && e.status === 423) {
      const seconds = (e.extra as { retryAfter: number }).retryAfter;
      throw new EditError(`A scene is being moved in this chapter. Try again in ${seconds} seconds.`);
    }
    throw e;
  }
}

// Curly quotes, dashes and non-breaking spaces, mapped one-for-one so that
// positions in the normalized text match the original.
const LOOSE: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"',
  "–": "-", "—": "-", "‒": "-", "―": "-", "−": "-",
  " ": " ", " ": " ", " ": " ",
};
const loosen = (s: string) => s.replace(/[‘-‟‒-―−   ]/g, (c) => LOOSE[c] ?? c);

function occurrences(hay: string, needle: string): number[] {
  const at: number[] = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) at.push(i);
  return at;
}

/**
 * Apply exact replacements in order. Each old_text must appear exactly once in
 * the text as it stands when that edit is applied. All or nothing.
 */
export function applyEdits(
  content: string,
  edits: { old_text: string; new_text: string }[],
  what: "chapter" | "draft" = "chapter",
): string {
  let out = content;
  edits.forEach((edit, i) => {
    const which = edits.length > 1 ? `Edit ${i + 1}: ` : "";
    if (!edit.old_text) throw new EditError(`${which}old_text is empty. To add text at the end, use append_to_chapter.`);
    const found = occurrences(out, edit.old_text);
    if (found.length === 1) {
      out = out.slice(0, found[0]) + edit.new_text + out.slice(found[0] + edit.old_text.length);
      return;
    }
    if (found.length > 1) {
      throw new EditError(
        `${which}old_text appears ${found.length} times in the ${what}. Include more of the surrounding text so it matches exactly once.`,
      );
    }
    const near = occurrences(loosen(out), loosen(edit.old_text));
    if (near.length === 1) {
      const actual = out.slice(near[0], near[0] + edit.old_text.length);
      throw new EditError(
        `${which}old_text wasn't found exactly; the ${what} has it with different quotes or dashes:\n${actual}\nCopy that text exactly and try again.`,
      );
    }
    const reread = what === "draft" ? "Read the draft again with read_draft" : "Read the chapter again";
    throw new EditError(`${which}old_text wasn't found in the ${what}. ${reread} and copy the passage exactly.`);
  });
  return out;
}

/**
 * Change Claude's draft of a chapter, starting one from the chapter's text if
 * there isn't one. The chapter itself is left alone. With a draft, baseVersion
 * is the draft's version; without one, the chapter's.
 */
export async function draftAsClaude(
  env: Env,
  chapterId: string,
  baseVersion: number,
  change: (current: string, what: "chapter" | "draft") => string,
  ops: DraftOp[],
) {
  await assertEditable(env, chapterId);
  const row = await reconcileChapter(env, await getChapterRow(env, chapterId));
  await assertEditable(env, chapterId);
  const draft = await draftRow(env, row.id);
  if (draft && draft.version !== baseVersion) throw draftConflict(draft.version);
  if (!draft && row.version !== baseVersion) throw conflict(row.version);
  const key = claudeDraftKey(row.project_id, row.id);
  const obj = await env.BUCKET.get(draft ? key : chapterKey(row.project_id, row.id));
  if (draft && !obj) throw new EditError("The text of this chapter's draft is missing, so nothing was changed. Ask the author to discard the draft in Lantern.");
  const current = obj ? await obj.text() : "";
  if (!draft) {
    const latest = await reconcileChapter(env, await getChapterRow(env, chapterId));
    await assertEditable(env, chapterId);
    if (latest.version !== row.version) throw conflict(latest.version);
  }
  const content = change(current, draft ? "draft" : "chapter");
  if (content === current) throw new EditError("Those edits don't change the text, so nothing was saved.");
  if (new TextEncoder().encode(content).length > MAX_CHAPTER_BYTES) {
    throw new EditError("That would make the draft larger than 5 MB, so nothing was changed.");
  }
  const words = countWords(content);
  const ts = now();

  let rollBack: () => Promise<unknown>;
  if (draft) {
    const claim = await env.DB.prepare(
      "UPDATE claude_drafts SET version = version + 1, word_count = ?, updated_at = ?, ops = ? WHERE chapter_id = ? AND version = ?",
    )
      .bind(words, ts, JSON.stringify([...draft.ops, ...ops]), row.id, baseVersion)
      .run();
    if (!claim.meta.changes) throw draftConflict(baseVersion + 1);
    rollBack = () =>
      env.DB.prepare("UPDATE claude_drafts SET version = ?, word_count = ?, updated_at = ?, ops = ? WHERE chapter_id = ? AND version = ?")
        .bind(baseVersion, draft.word_count, draft.updated_at, JSON.stringify(draft.ops), row.id, baseVersion + 1)
        .run();
  } else {
    const claim = await env.DB.prepare(
      `INSERT INTO claude_drafts (chapter_id, project_id, version, base_version, word_count, ops, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?) ON CONFLICT (chapter_id) DO NOTHING`,
    )
      .bind(row.id, row.project_id, row.version, words, JSON.stringify(ops), ts, ts)
      .run();
    if (!claim.meta.changes) throw draftConflict(1);
    rollBack = () => env.DB.prepare("DELETE FROM claude_drafts WHERE chapter_id = ? AND version = 1").bind(row.id).run();
  }
  try {
    await env.BUCKET.put(key, content, MARKDOWN);
  } catch (e) {
    await rollBack();
    throw e;
  }
  return {
    draft_version: draft ? baseVersion + 1 : 1, started: !draft, word_count: words,
    previous_word_count: countWords(current), title: row.title, project_id: row.project_id, chapter_id: row.id,
  };
}

const conflict = (current: number) =>
  new EditError(
    `The chapter has changed since you read it (it's now version ${current}). Nothing was changed. ` +
      "Read it again with read_chapter and redo the edit against the new text.",
  );

const draftConflict = (current: number) =>
  new EditError(
    `This chapter has a draft by Claude waiting for the author (draft version ${current}), and edits go into ` +
      `that draft. Nothing was changed. Read it with read_draft and redo the edit against its text, with base_version ${current}.`,
  );

const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toLocaleString("en-US")}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listed = (parts: string[]) => {
  const s = parts.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

function saved(r: Awaited<ReturnType<typeof draftAsClaude>>) {
  const diff = r.word_count - r.previous_word_count;
  return text(
    `${r.started ? "Started" : "Updated"} Claude's draft of “${r.title}”: draft version ${r.draft_version} ` +
      `(${r.word_count.toLocaleString("en-US")} words, ${diff >= 0 ? "+" : ""}${diff.toLocaleString("en-US")}). ` +
      "The chapter itself is unchanged until the author accepts the draft in Lantern; tell them it's waiting. " +
      `Use base_version ${r.draft_version} for any further edit to this chapter.`,
  );
}

/** Tool errors Claude should read and act on, rather than a generic failure. */
async function guarded<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof EditError || e instanceof HttpError) {
      return { content: [{ type: "text" as const, text: e.message }], isError: true };
    }
    throw e;
  }
}

const baseVersion = z
  .number()
  .int()
  .min(0)
  .describe("The chapter's version from read_chapter or, once Claude's draft of it exists, the draft version from read_draft or your last edit");

export function registerWriteTools(server: McpServer, env: Env) {
  server.registerTool(
    "edit_chapter",
    {
      title: "Edit a chapter",
      description:
        "Replace exact passages in a chapter's text. The change goes into Claude's draft of the chapter, which " +
        "the author accepts or discards in Lantern; the chapter itself doesn't change. The first edit starts the " +
        "draft from the chapter; later edits change the draft, so copy old_text from read_draft. Each old_text " +
        "must be copied exactly (same quotes, dashes and line breaks) and appear exactly once; new_text replaces " +
        "it (empty deletes it). Edits apply in order and all or none. Keep each old_text short but unique, and " +
        "change only what the author asked for.",
      inputSchema: {
        chapter_id: z.string(),
        base_version: baseVersion,
        edits: z
          .array(z.object({ old_text: z.string(), new_text: z.string() }))
          .min(1)
          .max(50),
      },
      annotations: EDITS,
    },
    async ({ chapter_id, base_version, edits }) =>
      guarded(async () => {
        const r = await draftAsClaude(env, chapter_id, base_version, (content, what) => applyEdits(content, edits, what),
          edits.map((edit) => ({ kind: "replace", ...edit })));
        await logClaudeChange(env, {
          project_id: r.project_id, action: "edit_chapter", target_kind: "chapter", target_id: r.chapter_id,
          chapter_id: r.chapter_id, summary: `Drafted edits to “${r.title}”`,
          detail: `${plural(edits.length, "passage")} · ${signed(r.word_count - r.previous_word_count)} words`,
        });
        return saved(r);
      }),
  );

  server.registerTool(
    "append_to_chapter",
    {
      title: "Add to the end of a chapter",
      description:
        "Add text to the end of a chapter, after a blank line. Start the text with *** on its own line to " +
        "begin a new scene. Like edit_chapter, it goes into Claude's draft of the chapter for the author to accept.",
      inputSchema: { chapter_id: z.string(), base_version: baseVersion, text: z.string().min(1) },
      annotations: ADDS,
    },
    async ({ chapter_id, base_version, text: addition }) =>
      guarded(async () => {
        const ops: DraftOp[] = [{ kind: "append", text: addition }];
        const r = await draftAsClaude(env, chapter_id, base_version, (content) => replayDraft(content, ops).text, ops);
        await logClaudeChange(env, {
          project_id: r.project_id, action: "append_to_chapter", target_kind: "chapter", target_id: r.chapter_id,
          chapter_id: r.chapter_id, summary: `Drafted an addition to the end of “${r.title}”`,
          detail: `${signed(r.word_count - r.previous_word_count)} words`,
        });
        return saved(r);
      }),
  );

  server.registerTool(
    "create_chapter",
    {
      title: "Add a chapter",
      description:
        "Add a chapter at the end of a novel, optionally with its synopsis and opening text. The opening text " +
        "goes into Claude's draft of the new chapter, for the author to accept.",
      inputSchema: {
        novel_id: z.string(),
        title: z.string().min(1).max(200),
        synopsis: z.string().max(2000).optional(),
        text: z.string().optional(),
      },
      annotations: ADDS,
    },
    async ({ novel_id, title, synopsis, text: opening }) =>
      guarded(async () => {
        const chapter = await viaApp<ChapterMeta>(createChapter, { id: novel_id }, "POST", { title }, env);
        if (synopsis) await viaApp(updateChapter, { id: chapter.id }, "PATCH", { synopsis }, env);
        const draft = opening?.trim()
          ? await draftAsClaude(env, chapter.id, chapter.version, () => (opening.endsWith("\n") ? opening : `${opening}\n`),
            [{ kind: "set", text: opening.endsWith("\n") ? opening : `${opening}\n` }])
          : null;
        await logClaudeChange(env, {
          project_id: chapter.project_id, action: "create_chapter", target_kind: "chapter", target_id: chapter.id,
          chapter_id: chapter.id, summary: `Added the chapter “${chapter.title}”`,
          detail: listed([
            `chapter ${chapter.position + 1}`,
            ...(draft ? [`${plural(draft.word_count, "word")} drafted`] : []),
            ...(synopsis ? ["with a synopsis"] : []),
          ]),
        });
        return data({
          chapter_id: chapter.id, title: chapter.title, position: chapter.position + 1, version: chapter.version,
          ...(draft ? {
            draft_version: draft.draft_version, draft_word_count: draft.word_count,
            note: "The opening text is in Claude's draft of the chapter, waiting for the author to accept it.",
          } : {}),
        });
      }),
  );

  server.registerTool(
    "update_chapter_details",
    {
      title: "Change chapter details",
      description: "Change a chapter's title, synopsis or revision status. Doesn't touch the chapter's text.",
      inputSchema: {
        chapter_id: z.string(),
        title: z.string().min(1).max(200).optional(),
        synopsis: z.string().max(2000).optional(),
        revision_status: z.enum(["drafting", "revising", "done"]).optional(),
      },
      annotations: EDITS,
    },
    async ({ chapter_id, title, synopsis, revision_status }) =>
      guarded(async () => {
        if (title === undefined && synopsis === undefined && revision_status === undefined) throw new EditError("Give a title, synopsis or revision status.");
        const r = await viaApp<ChapterMeta>(updateChapter, { id: chapter_id }, "PATCH", { title, synopsis, revision_status }, env);
        await logClaudeChange(env, {
          project_id: r.project_id, action: "update_chapter_details", target_kind: "chapter", target_id: r.id,
          chapter_id: r.id, summary: `Changed the details of “${r.title}”`,
          detail: listed([...(title !== undefined ? ["title"] : []), ...(synopsis !== undefined ? ["synopsis"] : []), ...(revision_status !== undefined ? ["revision status"] : [])]),
        });
        return data({ chapter_id: r.id, title: r.title, synopsis: r.synopsis, revision_status: r.revision_status });
      }),
  );

  server.registerTool(
    "create_story_entry",
    {
      title: "Add a story guide entry",
      description:
        "Add a character, place, thing or note to the story guide. Names and other names must not already " +
        "be used by another entry. Chapters can then link to it with [[Name]].",
      inputSchema: {
        novel_id: z.string(),
        kind: z.enum(BIBLE_KINDS as [string, ...string[]]),
        name: z.string().min(1).max(120),
        aliases: z.array(z.string()).max(30).optional().describe("Other names it goes by"),
        notes: z.string().optional().describe("Markdown notes"),
      },
      annotations: ADDS,
    },
    async ({ novel_id, kind, name, aliases, notes }) =>
      guarded(async () => {
        const e = await viaApp<BibleEntry>(createEntry, { id: novel_id }, "POST", { kind, name, aliases: aliases ?? [], body: notes ?? "" }, env);
        await logClaudeChange(env, {
          project_id: e.project_id, action: "create_story_entry", target_kind: "entry", target_id: e.id,
          chapter_id: null, summary: `Added “${e.name}” to the story guide`,
          detail: listed([e.kind, ...(e.aliases.length ? [`also ${e.aliases.join(", ")}`] : [])]),
        });
        return data({ id: e.id, kind: e.kind, name: e.name, aliases: e.aliases });
      }),
  );

  server.registerTool(
    "update_story_entry",
    {
      title: "Change a story guide entry",
      description:
        "Change a story guide entry. Fields you leave out stay as they are. notes replaces the notes; " +
        "add_to_notes appends a paragraph to them instead. aliases replaces the whole list of other names.",
      inputSchema: {
        entry_id: z.string().describe("From get_story_guide or get_story_entry"),
        kind: z.enum(BIBLE_KINDS as [string, ...string[]]).optional(),
        name: z.string().min(1).max(120).optional(),
        aliases: z.array(z.string()).max(30).optional(),
        notes: z.string().optional(),
        add_to_notes: z.string().optional(),
      },
      annotations: EDITS,
    },
    async ({ entry_id, kind, name, aliases, notes, add_to_notes }) =>
      guarded(async () => {
        if (notes !== undefined && add_to_notes !== undefined) throw new EditError("Use notes or add_to_notes, not both.");
        let body = notes;
        if (add_to_notes !== undefined) {
          const current = await env.DB.prepare(
            "SELECT body FROM bible_entries WHERE id = ? AND deleted_at IS NULL",
          )
            .bind(entry_id)
            .first<{ body: string }>();
          if (!current) throw new HttpError(404, "That entry wasn't found");
          body = current.body.trim() ? `${current.body.replace(/\s+$/, "")}\n\n${add_to_notes}` : add_to_notes;
        }
        const e = await viaApp<BibleEntry>(updateEntry, { id: entry_id }, "PATCH", { kind, name, aliases, body }, env);
        await logClaudeChange(env, {
          project_id: e.project_id, action: "update_story_entry", target_kind: "entry", target_id: e.id,
          chapter_id: null, summary: `Changed the story guide entry “${e.name}”`,
          detail: listed([
            ...(name !== undefined ? ["name"] : []),
            ...(kind !== undefined ? ["kind"] : []),
            ...(aliases !== undefined ? ["other names"] : []),
            ...(notes !== undefined ? ["notes"] : []),
            ...(add_to_notes !== undefined ? ["added to the notes"] : []),
          ]),
        });
        return data({ id: e.id, kind: e.kind, name: e.name, aliases: e.aliases, notes: e.body });
      }),
  );

  const sceneFields = {
    title: z.string().min(1).max(200).optional(),
    summary: z.string().max(2000).optional(),
    pov: z.string().max(120).optional().describe("Whose point of view"),
    location: z.string().max(120).optional(),
    status: z.enum(["planned", "drafted", "revising", "done"]).optional(),
  };

  server.registerTool(
    "create_scene",
    {
      title: "Add a scene card",
      description:
        "Add a scene planning card. Scenes stand on their own: give chapter_id to put it at the end of " +
        "that chapter's scenes, or leave it out to add an unassigned scene the author can place later. " +
        "Cards can be tied to passages between scene breaks. move_scene moves their text with them, keeping a History copy.",
      inputSchema: {
        novel_id: z.string().optional().describe("From list_novels. Needed when chapter_id is left out"),
        chapter_id: z.string().optional().describe("From get_outline. Leave out for an unassigned scene"),
        ...sceneFields,
      },
      annotations: ADDS,
    },
    async ({ novel_id, chapter_id, ...fields }) =>
      guarded(async () => {
        const projectId = chapter_id ? (await getChapterRow(env, chapter_id)).project_id : novel_id;
        if (!projectId) throw new HttpError(400, "Give novel_id, or chapter_id to add the scene to a chapter");
        if (novel_id && novel_id !== projectId) throw new HttpError(400, "That chapter isn't in that novel");
        const scene = await viaApp<SceneMeta>(createProjectScene, { id: projectId }, "POST", { chapterId: chapter_id ?? null }, env);
        const filled = Object.values(fields).some((v) => v !== undefined)
          ? await viaApp<SceneMeta>(updateScene, { id: scene.id }, "PATCH", fields, env)
          : scene;
        const chapter = filled.chapter_id ? await getChapterRow(env, filled.chapter_id) : null;
        await logClaudeChange(env, {
          project_id: filled.project_id, action: "create_scene", target_kind: "scene", target_id: filled.id,
          chapter_id: filled.chapter_id, summary: `Added the scene “${filled.title}”`,
          detail: chapter ? `In “${chapter.title}”` : "Not in a chapter yet",
        });
        const { project_id: _p, created_at: _c, updated_at: _u, ...rest } = filled;
        return data(rest);
      }),
  );

  server.registerTool(
    "move_scene",
    {
      title: "Move a scene",
      description: "Move an in-text scene and its passage, keeping a History copy. Give the chapter version and " +
        "passage_index from read_chapter with scene_id. " +
        "Within a chapter, uncarded passages stay attached to the preceding scene.",
      inputSchema: {
        scene_id: z.string(),
        from_chapter_id: z.string().describe("The chapter containing the scene when you read it"),
        from_passage_index: z.number().int().min(0)
          .describe("The scene's passage_index from read_chapter with scene_id"),
        to_chapter_id: z.string().optional(),
        before_passage_index: z.number().int().min(0).nullable().optional().describe("Destination passage index, or null for the end"),
        base_versions: z.object({ from: baseVersion, to: baseVersion.optional() }),
      },
      annotations: EDITS,
    },
    async ({ scene_id, from_chapter_id, from_passage_index, to_chapter_id, before_passage_index, base_versions }) =>
      guarded(async () => {
        try {
          const found = await env.DB.prepare("SELECT project_id FROM scenes WHERE id = ?").bind(scene_id).first<{ project_id: string }>();
          if (!found) throw new HttpError(404, "Scene not found");
          const { listing, chapters: snapshots } = await sceneListing(env, found.project_id);
          const scene = listing.scenes.find((s) => s.id === scene_id);
          if (scene && scene.chapter_id !== from_chapter_id) throw new HttpError(409, "Scene moved");
          if (!scene?.in_text || !scene.chapter_id || scene.passage_index === null) {
            throw new HttpError(400, "Only scenes in the text can be moved this way");
          }
          if (scene.passage_index !== from_passage_index) {
            throw new EditError("That scene's passage has changed since you read it. Read it again with read_chapter and redo the move.");
          }
          const from = snapshots.find((c) => c.chapter.id === from_chapter_id);
          if (!from) throw new HttpError(404, "Chapter not found");
          if (await draftRow(env, from_chapter_id) || (to_chapter_id && await draftRow(env, to_chapter_id))) {
            throw new EditError("This chapter has a draft by Claude waiting for the author. Ask them to accept or discard it first.");
          }
          if (from.chapter.version !== base_versions.from || from.textVersion !== base_versions.from) {
            throw conflict(from.chapter.version);
          }
          let result: unknown;
          let destination = from.chapter.id;
          if (to_chapter_id !== undefined) {
            if (base_versions.to === undefined) throw new HttpError(400, "Give the destination chapter version");
            destination = to_chapter_id;
            result = await viaApp(moveScene, { id: scene_id }, "POST", {
              toChapterId: destination, expectedFromChapterId: from_chapter_id,
              expectedFromPassageIndex: from_passage_index,
              beforePassageIndex: before_passage_index ?? null, baseVersions: base_versions,
            }, env);
          } else {
            const cards = listing.scenes.filter((s) => s.chapter_id === from.chapter.id).sort((a, b) => a.position - b.position);
            const before = before_passage_index ?? null;
            if (before !== null && !from.passages[before]) throw new HttpError(400, "Passage not found");
            const target = before === null ? undefined : cards.find((s) => s.in_text && s.passage_index === before);
            if (before !== null && !target) {
              throw new HttpError(400, "Uncarded passages stay with the scene before them. Choose a scene or the end.");
            }
            const ids = cards.map((s) => s.id);
            if (target?.id !== scene_id) {
              ids.splice(ids.indexOf(scene_id), 1);
              ids.splice(target ? ids.indexOf(target.id) : ids.length, 0, scene_id);
            }
            const expectedPassages = cards.filter((s) => s.in_text && s.passage_index !== null)
              .map((s) => [s.id, s.passage_index]);
            result = await viaApp(arrangeScenes, { id: from.chapter.id }, "PUT", {
              baseVersion: base_versions.from, sceneIds: ids, expectedPassages,
            }, env);
          }
          await logClaudeChange(env, {
            project_id: found.project_id, action: "move_scene", target_kind: "scene", target_id: scene.id,
            chapter_id: destination, summary: `Moved the scene “${scene.title}”`,
            detail: `From “${from.chapter.title}”`,
          });
          return data(result);
        } catch (e) {
          if (e instanceof HttpError && e.status === 409) {
            throw new EditError("The chapter has changed since you read it. Nothing was changed. Read it again with read_chapter and redo the move.");
          }
          if (e instanceof HttpError && e.status === 423) {
            throw new EditError("A scene is being moved in this chapter; try again in a few seconds.");
          }
          throw e;
        }
      }),
  );

  server.registerTool(
    "update_scene",
    {
      title: "Change a scene card",
      description:
        "Change a scene card's title, summary, point of view, location or status, or which chapter it's in " +
        "(chapter_id null takes it out of its chapter). Fields you leave out stay as they are.",
      inputSchema: {
        scene_id: z.string().describe("From get_outline"),
        chapter_id: z.string().nullable().optional()
          .describe("Move the scene to the end of this chapter's scenes, or null to unassign it"),
        ...sceneFields,
      },
      annotations: EDITS,
    },
    async ({ scene_id, ...fields }) =>
      guarded(async () => {
        const s = await viaApp<SceneMeta>(updateScene, { id: scene_id }, "PATCH", fields, env);
        const names: Record<string, string> = {
          title: "title", summary: "summary", pov: "point of view", location: "location", status: "status",
        };
        const moved = fields.chapter_id === undefined
          ? []
          : [s.chapter_id ? `moved to “${(await getChapterRow(env, s.chapter_id)).title}”` : "taken out of its chapter"];
        await logClaudeChange(env, {
          project_id: s.project_id, action: "update_scene", target_kind: "scene", target_id: s.id,
          chapter_id: s.chapter_id, summary: `Changed the scene “${s.title}”`,
          detail: listed([
            ...Object.entries(fields).filter(([k, v]) => v !== undefined && k !== "chapter_id").map(([k]) => names[k] ?? k),
            ...moved,
          ]),
        });
        const { project_id: _p, created_at: _c, updated_at: _u, ...rest } = s;
        return data(rest);
      }),
  );
}
