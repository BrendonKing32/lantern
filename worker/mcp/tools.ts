// The read tools MCP clients see when Lantern is added as a connector.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createAnchorMatcher } from "../../shared/anchors";
import { splitScenes } from "../../shared/scenes";
import type { BibleEntry, ChapterMeta, Snapshot } from "../../shared/types";
import { BIBLE_KINDS } from "../../shared/types";
import { CHAPTER_COLS, chapterKey, chapterTextVersion, getChapterRow, milestoneKey, reconcileChapter, requireProject, snapshotKey } from "../db";
import type { Env } from "../env";
import { listActs } from "../handlers/acts";
import { BIBLE_COLS, toEntry, type BibleRow } from "../handlers/bible";
import { draftRow, readClaudeDraft } from "../handlers/claudeDrafts";
import { sceneListing } from "../handlers/scenes";
import { HttpError } from "../http";
import { DATA_OUTPUT_SCHEMA, dataResult, registerConnectorTool } from "./telemetry";

/** Longest text slice returned by one chapter or history read. */
export const READ_LIMIT = 100_000;
const SEARCH_LIMIT = 50;
const SEARCH_CHAPTER_LIMIT = 20;
const SEARCH_BYTE_LIMIT = 20 * 1024 * 1024;
const PREVIEW = 300;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
const data = dataResult;

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
  registerConnectorTool(
    server,
    "list_milestones",
    {
      title: "List milestones",
      description: "List a novel's completed, read-only milestones, newest first.",
      inputSchema: { novel_id: z.string().describe("From list_novels") },
      outputSchema: DATA_OUTPUT_SCHEMA,
      annotations: READ_ONLY,
    },
    async ({ novel_id }) => {
      await requireProject(env, novel_id);
      const { results } = await env.DB.prepare(
        `SELECT id, name, note, created_at, word_count, chapter_count FROM milestones
         WHERE project_id = ? AND complete = 1 ORDER BY created_at DESC, rowid DESC`,
      ).bind(novel_id).all();
      return data(results);
    },
  );

  registerConnectorTool(
    server,
    "read_milestone",
    {
      title: "Read a milestone",
      description:
        "List the chapters in a completed milestone, or read one chapter's copied text. Compare it with read_chapter " +
        "to see what changed. Long text comes back in slices; pass the offset the reply gives to read on.",
      inputSchema: {
        milestone_id: z.string().describe("From list_milestones"),
        chapter_id: z.string().optional().describe("From the milestone's chapter list"),
        offset: z.number().int().min(0).optional().describe("Character offset to start from (default 0)"),
      },
      annotations: READ_ONLY,
    },
    async ({ milestone_id, chapter_id, offset = 0 }) => {
      const milestone = await env.DB.prepare(
        `SELECT project_id FROM milestones WHERE id = ? AND complete = 1
         AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)`,
      ).bind(milestone_id).first<{ project_id: string }>();
      if (!milestone) throw new HttpError(404, "Milestone not found");
      if (chapter_id === undefined) {
        const { results } = await env.DB.prepare(
          `SELECT chapter_id, title, position, word_count, version FROM milestone_chapters
           WHERE milestone_id = ? ORDER BY position`,
        ).bind(milestone_id).all();
        return data(results);
      }
      const chapter = await env.DB.prepare(
        "SELECT chapter_id FROM milestone_chapters WHERE milestone_id = ? AND chapter_id = ?",
      ).bind(milestone_id, chapter_id).first<{ chapter_id: string }>();
      if (!chapter) throw new HttpError(404, "Chapter not found in this milestone");
      const object = await env.BUCKET.get(milestoneKey(milestone.project_id, milestone_id, chapter_id));
      if (!object) throw new HttpError(404, "The milestone chapter's text is missing");
      const { slice, range } = sliced(await object.text(), offset);
      return text(range ? `${range}\n\n${slice}` : slice);
    },
  );

  registerConnectorTool(
    server,
    "list_margin_notes",
    {
      title: "List margin notes",
      description:
        "Private margin notes on the saved chapter text, including whether each passage is still found. " +
        "Returns up to 50 notes by default (100 maximum); continue from next_offset.",
      inputSchema: {
        novel_id: z.string().optional().describe("From list_novels"),
        chapter_id: z.string().optional().describe("From get_outline"),
        include_resolved: z.boolean().optional().describe("Include resolved notes (default false)"),
        limit: z.number().int().min(1).max(100).optional().describe("Notes per page (default 50, maximum 100)"),
        offset: z.number().int().min(0).max(1000000).optional().describe("Number of notes to skip (default 0)"),
      },
      outputSchema: DATA_OUTPUT_SCHEMA,
      annotations: READ_ONLY,
    },
    async ({ novel_id, chapter_id, include_resolved = false, limit = 50, offset = 0 }) => {
      if (!novel_id && !chapter_id) throw new HttpError(400, "Give novel_id or chapter_id.");
      const projectId = novel_id ? (await requireProject(env, novel_id)).id : undefined;
      const chapter = chapter_id ? await getChapterRow(env, chapter_id) : undefined;
      if (projectId && chapter && chapter.project_id !== projectId) {
        throw new HttpError(400, "That chapter isn't in that novel.");
      }
      const { results } = await env.DB.prepare(
        `SELECT n.id, n.project_id, n.chapter_id, n.quote, n.prefix, n.suffix, n.body, n.author,
                n.resolved_at, n.created_at, n.updated_at
           FROM margin_notes n JOIN chapters c ON c.id = n.chapter_id
          WHERE c.deleted_at IS NULL AND c.project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)
            ${chapter_id ? "AND n.chapter_id = ?" : "AND n.project_id = ?"}
            ${include_resolved ? "" : "AND n.resolved_at IS NULL"}
          ORDER BY n.created_at, n.id LIMIT ? OFFSET ?`,
      ).bind(chapter_id ?? projectId, limit + 1, offset).all<{
        id: string; project_id: string; chapter_id: string; quote: string; prefix: string; suffix: string;
        body: string; author: string; resolved_at: string | null; created_at: string; updated_at: string;
      }>();
      const hasMore = results.length > limit;
      const page = results.slice(0, limit);
      const chaptersById = new Map<string, typeof page>();
      for (const note of page) {
        const group = chaptersById.get(note.chapter_id) ?? [];
        group.push(note);
        chaptersById.set(note.chapter_id, group);
      }
      const passageFound = new Map<string, boolean>();
      for (const [id, notes] of chaptersById) {
        const content = await chapterText(env, await getChapterRow(env, id));
        const findAnchor = createAnchorMatcher(content);
        for (const note of notes) passageFound.set(note.id, findAnchor(note) !== null);
      }
      return data({
        notes: page.map((note) => ({
          ...note,
          resolved: note.resolved_at !== null,
          passage_found: passageFound.get(note.id) ?? false,
        })),
        limit,
        offset,
        next_offset: hasMore ? offset + limit : null,
      });
    },
  );

  registerConnectorTool(
    server,
    "list_novels",
    {
      title: "List novels",
      description:
        "List the novels on the Lantern shelf with their ids, chapter counts and word counts. " +
        "Start here to find a novel_id.",
      inputSchema: {},
      outputSchema: DATA_OUTPUT_SCHEMA,
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

  registerConnectorTool(
    server,
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
      outputSchema: DATA_OUTPUT_SCHEMA,
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
          revision_status: c.revision_status,
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

  registerConnectorTool(
    server,
    "read_chapter",
    {
      title: "Read a chapter",
      description:
        "The chapter's saved markdown text and its version (edits need it as base_version). " +
        "[[Name]] and [[Name|shown words]] are links to story guide " +
        `entries. Long chapters come back in slices of ${READ_LIMIT.toLocaleString("en-US")} characters; ` +
        "pass the offset the reply gives to read on. If an AI draft of the chapter is waiting for the " +
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
          ? `An AI draft of this chapter is waiting for the author to accept it (draft version ${draft.version}, ` +
            `${draft.word_count} words). Chapter edits go into that draft: read it with read_draft.`
          : "",
        range,
      ]
        .filter(Boolean)
        .join("\n");
      return text(`${header}\n\n---\n\n${slice || (content ? "(nothing past this offset)" : "(this chapter is empty)")}`);
    },
  );

  registerConnectorTool(
    server,
    "read_draft",
    {
      title: "Read the AI draft of a chapter",
      description:
        "The text of the AI draft of a chapter: changes made through this connector that wait beside the " +
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
          `There's no AI draft of “${row.title}”: the author accepted or discarded it, or none was made. ` +
            `Read the chapter with read_chapter; the next edit starts a new draft from it (chapter version ${row.version}).`,
        );
      }
      const { slice, range } = sliced(draft.content, offset);
      const header = [
        `# ${row.title} (AI draft, not yet accepted)`,
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

  registerConnectorTool(
    server,
    "search_book",
    {
      title: "Search a novel",
      description:
        `Find a literal word or phrase across up to ${SEARCH_CHAPTER_LIMIT} chapters per call (up to ${SEARCH_LIMIT} ` +
        "matches, with the line and surrounding text). Searches saved text only. If next_offset is returned, " +
        "continue with chapter_offset to search the next page; total counts matches in the scanned chapters.",
      inputSchema: {
        novel_id: z.string(),
        query: z.string().min(1).max(200),
        match_case: z.boolean().optional(),
        chapter_offset: z.number().int().min(0).optional().describe("Chapter offset from get_outline (default 0)"),
      },
      outputSchema: DATA_OUTPUT_SCHEMA,
      annotations: READ_ONLY,
    },
    async ({ novel_id, query, match_case = false, chapter_offset = 0 }) => {
      await requireProject(env, novel_id);
      const allChapters = await chapters(env, novel_id);
      const list = allChapters.slice(chapter_offset, chapter_offset + SEARCH_CHAPTER_LIMIT);
      const matches: ReturnType<typeof findMatches>["matches"] = [];
      let total = 0;
      let bytesScanned = 0;
      let chaptersScanned = 0;
      for (let i = 0; i < list.length; i++) {
        const chapter = list[i];
        const object = await env.BUCKET.get(chapterKey(chapter.project_id, chapter.id));
        const estimatedBytes = object?.size ?? 0;
        if (chaptersScanned > 0 &&
            (bytesScanned >= SEARCH_BYTE_LIMIT ||
              (estimatedBytes > 0 && bytesScanned + estimatedBytes > SEARCH_BYTE_LIMIT))) break;
        const content = object ? await object.text() : "";
        const contentBytes = estimatedBytes || new TextEncoder().encode(content).length;
        const result = findMatches(
          [{ chapter, number: chapter_offset + i + 1, content }],
          query,
          match_case,
          Math.max(0, SEARCH_LIMIT - matches.length),
        );
        total += result.total;
        matches.push(...result.matches);
        bytesScanned += contentBytes;
        chaptersScanned++;
      }
      return data({
        total,
        matches,
        chapter_offset,
        chapters_scanned: chaptersScanned,
        bytes_scanned: bytesScanned,
        next_offset: chapter_offset + chaptersScanned < allChapters.length ? chapter_offset + chaptersScanned : null,
      });
    },
  );

  registerConnectorTool(
    server,
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
      outputSchema: DATA_OUTPUT_SCHEMA,
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

  registerConnectorTool(
    server,
    "get_story_entry",
    {
      title: "Read a story guide entry",
      description: "One story guide entry in full, found by its id or by its name or one of its other names.",
      inputSchema: {
        novel_id: z.string(),
        entry: z.string().describe("The entry's id, name or alias"),
      },
      outputSchema: DATA_OUTPUT_SCHEMA,
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

  registerConnectorTool(
    server,
    "list_history",
    {
      title: "List a chapter's saved versions",
      description:
        "Earlier versions of a chapter kept in History, newest first (Lantern keeps one at most every " +
        "10 minutes while writing, and one before every restore or replacement).",
      inputSchema: { chapter_id: z.string() },
      outputSchema: DATA_OUTPUT_SCHEMA,
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

  registerConnectorTool(
    server,
    "read_version",
    {
      title: "Read an earlier version",
      description:
        `The text of one version from list_history. Long versions come back in slices of ${READ_LIMIT.toLocaleString("en-US")} ` +
        "characters; pass the offset the reply gives to read on.",
      inputSchema: {
        chapter_id: z.string(),
        version_id: z.string().describe("An id from list_history"),
        offset: z.number().int().min(0).optional().describe("Character offset to start from (default 0)"),
      },
      annotations: READ_ONLY,
    },
    async ({ chapter_id, version_id, offset = 0 }) => {
      const row = await getChapterRow(env, chapter_id);
      const snap = await env.DB.prepare(
        "SELECT id, version, word_count, reason, created_at FROM chapter_snapshots WHERE id = ? AND chapter_id = ?",
      )
        .bind(version_id, row.id)
        .first<Snapshot>();
      if (!snap) throw new HttpError(404, "That version isn't in this chapter's history");
      const obj = await env.BUCKET.get(snapshotKey(row.project_id, row.id, snap.id));
      const content = obj ? await obj.text() : "";
      const { slice, range } = sliced(content, offset);
      return text(
        `# ${row.title} (version from ${snap.created_at}, ${snap.word_count} words, ${snap.reason})` +
          `${range ? ` · ${range}` : ""}\n\n---\n\n${slice || (content ? "(nothing past this offset)" : "(this version is empty)")}`,
      );
    },
  );
}
