// The read tools Claude sees when Lantern is added as a connector.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findAnchor } from "../../shared/anchors";
import { splitScenes } from "../../shared/scenes";
import type { BibleEntry, ChapterMeta, Snapshot } from "../../shared/types";
import { BIBLE_KINDS } from "../../shared/types";
import { CHAPTER_COLS, chapterKey, chapterTextVersion, getChapterRow, reconcileChapter, requireProject, snapshotKey } from "../db";
import type { Env } from "../env";
import { listActs } from "../handlers/acts";
import { BIBLE_COLS, toEntry, type BibleRow } from "../handlers/bible";
import { draftRow, readClaudeDraft } from "../handlers/claudeDrafts";
import { listChapterNotes } from "../handlers/notes";
import { sceneListing } from "../handlers/scenes";
import { HttpError } from "../http";

/** Longest slice of a chapter returned by one read_chapter call. */
export const READ_LIMIT = 100_000;
const SEARCH_LIMIT = 50;
const PREVIEW = 300;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const data = (value: unknown) => text(JSON.stringify(value, null, 1));

async function chapters(env: Env, projectId: string): Promise<ChapterMeta[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${CHAPTER_COLS} FROM chapters WHERE project_id = ? AND deleted_at IS NULL ORDER BY position`,
  )
    .bind(projectId)
    .all<ChapterMeta>();
  return results;
}

async function chapterText(env: Env, row: Pick<ChapterMeta, "project_id" | "id">): Promise<string> {
  const obj = await env.BUCKET.get(chapterKey(row.project_id, row.id));
  return obj ? await obj.text() : "";
}

function sliced(content: string, offset: number) {
  const slice = content.slice(offset, offset + READ_LIMIT);
  const end = offset + slice.length;
  const range = offset > 0 || end < content.length
    ? `characters ${offset}–${end} of ${content.length}` + (end < content.length ? `; continue with offset ${end}` : "")
    : "";
  return { slice, range };
}

/** Translate a position in LF-normalized text back to the stored text. */
function originalOffset(text: string, normalizedOffset: number): number {
  let normalized = 0;
  for (let original = 0; original < text.length; original++) {
    if (normalized === normalizedOffset) return original;
    if (text[original] === "\r" && text[original + 1] === "\n") original++;
    normalized++;
  }
  return text.length;
}

/** Literal, line-by-line matches across a book, in reading order. */
export function findMatches(
  books: { chapter: ChapterMeta; number: number; content: string }[],
  query: string,
  matchCase: boolean,
  limit = SEARCH_LIMIT,
) {
  const needle = matchCase ? query : query.toLowerCase();
  const matches: { chapter_id: string; chapter: number; title: string; line: number; text: string }[] = [];
  let total = 0;
  for (const { chapter, number, content } of books) {
    content.split("\n").forEach((line, i) => {
      const hay = matchCase ? line : line.toLowerCase();
      let at = hay.indexOf(needle);
      while (at !== -1) {
        total++;
        if (matches.length < limit) {
          const start = Math.max(0, at - 120);
          const end = Math.min(line.length, at + needle.length + 120);
          matches.push({
            chapter_id: chapter.id,
            chapter: number,
            title: chapter.title,
            line: i + 1,
            text: `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`,
          });
        }
        at = hay.indexOf(needle, at + needle.length);
      }
    });
  }
  return { total, matches };
}

export function registerTools(server: McpServer, env: Env) {
  server.registerTool(
    "list_margin_notes",
    {
      title: "List margin notes",
      description: "Private margin notes on the saved chapter text, including whether each passage is still found.",
      inputSchema: {
        novel_id: z.string().optional().describe("From list_novels"),
        chapter_id: z.string().optional().describe("From get_outline"),
        include_resolved: z.boolean().optional().describe("Include resolved notes (default false)"),
      },
      annotations: READ_ONLY,
    },
    async ({ novel_id, chapter_id, include_resolved = false }) => {
      if (!novel_id && !chapter_id) throw new HttpError(400, "Give novel_id or chapter_id.");
      if (novel_id) await requireProject(env, novel_id);
      const selected = chapter_id ? [await getChapterRow(env, chapter_id)] : await chapters(env, novel_id!);
      if (novel_id && selected.some((chapter) => chapter.project_id !== novel_id)) {
        throw new HttpError(400, "That chapter isn't in that novel.");
      }
      const notes = await Promise.all(selected.map(async (chapter) => {
        const [content, open, resolved] = await Promise.all([
          chapterText(env, chapter),
          listChapterNotes(env, chapter.id, false),
          include_resolved ? listChapterNotes(env, chapter.id, true) : Promise.resolve([]),
        ]);
        return [...open, ...resolved].map((note) => ({
          ...note,
          resolved: note.resolved_at !== null,
          passage_found: findAnchor(content, note) !== null,
        }));
      }));
      return data(notes.flat());
    },
  );

  server.registerTool(
    "list_novels",
    {
      title: "List novels",
      description:
        "List the novels on the Lantern shelf with their ids, chapter counts and word counts. " +
        "Start here to find a novel_id.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const { results } = await env.DB.prepare(
        `SELECT p.id, p.title, p.updated_at, p.archived_at IS NOT NULL AS archived,
                COUNT(c.id) AS chapter_count, COALESCE(SUM(c.word_count), 0) AS word_count
           FROM projects p
           LEFT JOIN chapters c ON c.project_id = p.id AND c.deleted_at IS NULL
          WHERE p.deleted_at IS NULL
          GROUP BY p.id ORDER BY p.updated_at DESC`,
      ).all<{ id: string; title: string; updated_at: string; archived: number; chapter_count: number; word_count: number }>();
      return data(results.map((r) => ({ ...r, archived: Boolean(r.archived) })));
    },
  );

  server.registerTool(
    "get_outline",
    {
      title: "Get a novel's outline",
      description:
        "The novel's chapters in reading order (id, number, title, synopsis, word count, and the act " +
        "it's in, if any) with each chapter's scene cards, the novel's acts in order (the author's " +
        "groupings of chapters, such as acts or parts), the scene cards not yet placed in any " +
        "chapter (unassigned_scenes), " +
        "plus the novel's target length and English dialect.",
      inputSchema: { novel_id: z.string().describe("From list_novels") },
      annotations: READ_ONLY,
    },
    async ({ novel_id }) => {
      const project = await requireProject(env, novel_id);
      const [acts, { listing, chapters: snapshots }] = await Promise.all([
        listActs(env, novel_id),
        sceneListing(env, novel_id),
      ]);
      const list = snapshots.map(({ chapter }) => chapter);
      const scenesByChapter = new Map<string | null, unknown[]>();
      for (const { id, chapter_id, title, summary, pov, location, status, in_text, word_count, passage_index } of listing.scenes) {
        const list = scenesByChapter.get(chapter_id) ?? [];
        list.push({ id, title, summary, pov, location, status, in_text, word_count, passage_index });
        scenesByChapter.set(chapter_id, list);
      }
      const actTitle = new Map(acts.map((a) => [a.id, a.title]));
      return data({
        id: project.id,
        title: project.title,
        dialect: project.dialect,
        target_words: project.target_words,
        target_date: project.target_date,
        word_count: list.reduce((sum, c) => sum + c.word_count, 0),
        chapters: list.map((c, i) => ({
          id: c.id,
          number: i + 1,
          title: c.title,
          synopsis: c.synopsis,
          word_count: c.word_count,
          updated_at: c.updated_at,
          act: c.act_id ? (actTitle.get(c.act_id) ?? null) : null,
          scenes: scenesByChapter.get(c.id) ?? [],
          uncarded_passages: listing.placeholders.filter((p) => p.chapter_id === c.id)
            .map(({ passage_index, words, excerpt }) => ({ passage_index, words, excerpt })),
        })),
        acts: acts.map((a) => ({
          id: a.id,
          title: a.title,
          chapter_ids: list.filter((c) => c.act_id === a.id).map((c) => c.id),
        })),
        unassigned_scenes: scenesByChapter.get(null) ?? [],
      });
    },
  );

  server.registerTool(
    "read_chapter",
    {
      title: "Read a chapter",
      description:
        "The chapter's saved markdown text and its version (edits need it as base_version). " +
        "[[Name]] and [[Name|shown words]] are links to story guide " +
        `entries. Long chapters come back in slices of ${READ_LIMIT.toLocaleString("en-US")} characters; ` +
        "pass the offset the reply gives to read on. If Claude's draft of the chapter is waiting for the " +
        "author, the reply says so; read it with read_draft. Give scene_id to read only that scene's passage from the chapter, not the draft.",
      inputSchema: {
        chapter_id: z.string().describe("From get_outline"),
        scene_id: z.string().optional().describe("An in-text scene from this chapter"),
        offset: z.number().int().min(0).optional().describe("Character offset to start from (default 0)"),
      },
      annotations: READ_ONLY,
    },
    async ({ chapter_id, scene_id, offset = 0 }) => {
      let row = await reconcileChapter(env, await getChapterRow(env, chapter_id));
      let content: string;
      let passageIndex: number | null = null;
      if (scene_id) {
        const { listing, chapters: snapshots } = await sceneListing(env, row.project_id);
        const scene = listing.scenes.find((s) => s.id === scene_id && s.chapter_id === chapter_id);
        if (!scene?.in_text || scene.passage_index === null) throw new HttpError(400, "That scene is not in this chapter's text");
        const snapshot = snapshots.find((c) => c.chapter.id === chapter_id);
        if (!snapshot) throw new HttpError(404, "Chapter not found");
        const current = await env.BUCKET.get(chapterKey(row.project_id, row.id));
        const originalText = current ? await current.text() : "";
        if (snapshot.textVersion !== snapshot.chapter.version ||
            chapterTextVersion(current, snapshot.chapter.version) !== snapshot.textVersion ||
            originalText.replace(/\r\n?/g, "\n") !== snapshot.text) {
          throw new HttpError(409, "The chapter changed while reading the scene. Read it again.");
        }
        row = snapshot.chapter;
        passageIndex = scene.passage_index;
        const passage = splitScenes(snapshot.text, row.title)[passageIndex];
        if (!passage) throw new HttpError(409, "The scene changed while reading. Read it again.");
        content = originalText.slice(
          originalOffset(originalText, passage.start),
          originalOffset(originalText, passage.end),
        );
      } else {
        content = await chapterText(env, row);
      }
      const { slice, range } = sliced(content, offset);
      const draft = await draftRow(env, row.id);
      const header = [
        `# ${row.title}`,
        `chapter_id: ${row.id} · version ${row.version} · ${row.word_count} words · saved ${row.updated_at}`,
        passageIndex !== null ? `scene_id: ${scene_id} · passage_index: ${passageIndex}` : "",
        draft
          ? `Claude's draft of this chapter is waiting for the author to accept it (draft version ${draft.version}, ` +
            `${draft.word_count} words). Chapter edits go into that draft: read it with read_draft.`
          : "",
        range,
      ]
        .filter(Boolean)
        .join("\n");
      return text(`${header}\n\n---\n\n${slice || (content ? "(nothing past this offset)" : "(this chapter is empty)")}`);
    },
  );

  server.registerTool(
    "read_draft",
    {
      title: "Read Claude's draft of a chapter",
      description:
        "The text of Claude's draft of a chapter: changes made through this connector that wait beside the " +
        "chapter until the author accepts or discards them in Lantern. While a draft exists, chapter edits " +
        "apply to it and need its draft version as base_version. Long drafts come back in slices like read_chapter.",
      inputSchema: {
        chapter_id: z.string().describe("From get_outline"),
        offset: z.number().int().min(0).optional().describe("Character offset to start from (default 0)"),
      },
      annotations: READ_ONLY,
    },
    async ({ chapter_id, offset = 0 }) => {
      const row = await getChapterRow(env, chapter_id);
      const draft = await readClaudeDraft(env, row.project_id, row.id);
      if (!draft) {
        return text(
          `There's no draft of “${row.title}” by Claude: the author accepted or discarded it, or none was made. ` +
            `Read the chapter with read_chapter; the next edit starts a new draft from it (chapter version ${row.version}).`,
        );
      }
      const { slice, range } = sliced(draft.content, offset);
      const header = [
        `# ${row.title} (Claude's draft, not yet accepted)`,
        `chapter_id: ${row.id} · draft version ${draft.version} · ${draft.word_count} words · ` +
          `begun from chapter version ${draft.base_version}${draft.base_version === row.version ? "" : ` (the chapter is now version ${row.version})`}` +
          ` · last changed ${draft.updated_at}`,
        range,
      ]
        .filter(Boolean)
        .join("\n");
      return text(`${header}\n\n---\n\n${slice || (draft.content ? "(nothing past this offset)" : "(this draft is empty)")}`);
    },
  );

  server.registerTool(
    "search_book",
    {
      title: "Search a novel",
      description:
        `Find a literal word or phrase across every chapter of a novel (up to ${SEARCH_LIMIT} matches, ` +
        "with the line and surrounding text). Searches saved text only.",
      inputSchema: {
        novel_id: z.string(),
        query: z.string().min(1).max(200),
        match_case: z.boolean().optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ novel_id, query, match_case = false }) => {
      await requireProject(env, novel_id);
      const list = await chapters(env, novel_id);
      const books = await Promise.all(
        list.map(async (chapter, i) => ({ chapter, number: i + 1, content: await chapterText(env, chapter) })),
      );
      return data(findMatches(books, query, match_case));
    },
  );

  server.registerTool(
    "get_story_guide",
    {
      title: "Get the story guide",
      description:
        "The novel's story guide: characters, places, things and notes, each with its other names and " +
        `the start of its notes (first ${PREVIEW} characters). Use get_story_entry for an entry's full notes.`,
      inputSchema: {
        novel_id: z.string(),
        kind: z.enum(BIBLE_KINDS as [string, ...string[]]).optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ novel_id, kind }) => {
      await requireProject(env, novel_id);
      const { results } = await env.DB.prepare(
        `SELECT ${BIBLE_COLS} FROM bible_entries
          WHERE project_id = ? AND deleted_at IS NULL ${kind ? "AND kind = ?" : ""}
          ORDER BY kind, name COLLATE NOCASE`,
      )
        .bind(...(kind ? [novel_id, kind] : [novel_id]))
        .all<BibleRow>();
      return data(
        results.map(toEntry).map(({ id, kind, name, aliases, body }) => ({
          id,
          kind,
          name,
          aliases,
          notes: body.length > PREVIEW ? `${body.slice(0, PREVIEW)}…` : body,
        })),
      );
    },
  );

  server.registerTool(
    "get_story_entry",
    {
      title: "Read a story guide entry",
      description: "One story guide entry in full, found by its id or by its name or one of its other names.",
      inputSchema: {
        novel_id: z.string(),
        entry: z.string().describe("The entry's id, name or alias"),
      },
      annotations: READ_ONLY,
    },
    async ({ novel_id, entry }) => {
      await requireProject(env, novel_id);
      const { results } = await env.DB.prepare(
        `SELECT ${BIBLE_COLS} FROM bible_entries WHERE project_id = ? AND deleted_at IS NULL`,
      )
        .bind(novel_id)
        .all<BibleRow>();
      const wanted = entry.trim().toLowerCase();
      const found: BibleEntry | undefined = results
        .map(toEntry)
        .find((e) => e.id === entry || [e.name, ...e.aliases].some((n) => n.toLowerCase() === wanted));
      if (!found) throw new HttpError(404, `No story guide entry is called “${entry}”`);
      const { project_id: _, ...rest } = found;
      return data(rest);
    },
  );

  server.registerTool(
    "list_history",
    {
      title: "List a chapter's saved versions",
      description:
        "Earlier versions of a chapter kept in History, newest first (Lantern keeps one at most every " +
        "10 minutes while writing, and one before every restore or replacement).",
      inputSchema: { chapter_id: z.string() },
      annotations: READ_ONLY,
    },
    async ({ chapter_id }) => {
      const row = await getChapterRow(env, chapter_id);
      const { results } = await env.DB.prepare(
        `SELECT id, version, word_count, reason, created_at FROM chapter_snapshots
          WHERE chapter_id = ? ORDER BY created_at DESC LIMIT 100`,
      )
        .bind(row.id)
        .all<Snapshot>();
      return data(results);
    },
  );

  server.registerTool(
    "read_version",
    {
      title: "Read an earlier version",
      description: `The text of one version from list_history (up to ${READ_LIMIT.toLocaleString("en-US")} characters).`,
      inputSchema: { chapter_id: z.string(), version_id: z.string().describe("An id from list_history") },
      annotations: READ_ONLY,
    },
    async ({ chapter_id, version_id }) => {
      const row = await getChapterRow(env, chapter_id);
      const snap = await env.DB.prepare(
        "SELECT id, version, word_count, reason, created_at FROM chapter_snapshots WHERE id = ? AND chapter_id = ?",
      )
        .bind(version_id, row.id)
        .first<Snapshot>();
      if (!snap) throw new HttpError(404, "That version isn't in this chapter's history");
      const obj = await env.BUCKET.get(snapshotKey(row.project_id, row.id, snap.id));
      const content = obj ? await obj.text() : "";
      return text(
        `# ${row.title} (version from ${snap.created_at}, ${snap.word_count} words, ${snap.reason})\n\n---\n\n` +
          content.slice(0, READ_LIMIT),
      );
    },
  );
}
