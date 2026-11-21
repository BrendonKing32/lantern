// The tools Claude sees when Lantern is added as a connector. Read-only for now:
// nothing here writes to D1 or R2.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BibleEntry, ChapterMeta, SceneMeta, Snapshot } from "../../shared/types";
import { BIBLE_KINDS } from "../../shared/types";
import { CHAPTER_COLS, chapterKey, getChapterRow, requireProject, snapshotKey } from "../db";
import type { Env } from "../env";
import { BIBLE_COLS, toEntry, type BibleRow } from "../handlers/bible";
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
        "The novel's chapters in reading order (id, number, title, synopsis, word count) with each " +
        "chapter's scene cards, plus the novel's target length and English dialect.",
      inputSchema: { novel_id: z.string().describe("From list_novels") },
      annotations: READ_ONLY,
    },
    async ({ novel_id }) => {
      const project = await requireProject(env, novel_id);
      const [list, scenesResult] = await Promise.all([
        chapters(env, novel_id),
        env.DB.prepare(
          `SELECT id, chapter_id, title, summary, pov, location, status, position
             FROM scenes WHERE project_id = ? ORDER BY position`,
        )
          .bind(novel_id)
          .all<Omit<SceneMeta, "project_id" | "created_at" | "updated_at">>(),
      ]);
      const scenesByChapter = new Map<string, unknown[]>();
      for (const { chapter_id, position: _, ...scene } of scenesResult.results) {
        const list = scenesByChapter.get(chapter_id) ?? [];
        list.push(scene);
        scenesByChapter.set(chapter_id, list);
      }
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
          scenes: scenesByChapter.get(c.id) ?? [],
        })),
      });
    },
  );

  server.registerTool(
    "read_chapter",
    {
      title: "Read a chapter",
      description:
        "The chapter's saved markdown text. [[Name]] and [[Name|shown words]] are links to story guide " +
        `entries. Long chapters come back in slices of ${READ_LIMIT.toLocaleString("en-US")} characters; ` +
        "pass the offset the reply gives to read on.",
      inputSchema: {
        chapter_id: z.string().describe("From get_outline"),
        offset: z.number().int().min(0).optional().describe("Character offset to start from (default 0)"),
      },
      annotations: READ_ONLY,
    },
    async ({ chapter_id, offset = 0 }) => {
      const row = await getChapterRow(env, chapter_id);
      const content = await chapterText(env, row);
      const slice = content.slice(offset, offset + READ_LIMIT);
      const end = offset + slice.length;
      const header = [
        `# ${row.title}`,
        `chapter_id: ${row.id} · version ${row.version} · ${row.word_count} words · saved ${row.updated_at}`,
        offset > 0 || end < content.length
          ? `characters ${offset}–${end} of ${content.length}` +
            (end < content.length ? `; continue with offset ${end}` : "")
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      return text(`${header}\n\n---\n\n${slice || (content ? "(nothing past this offset)" : "(this chapter is empty)")}`);
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
