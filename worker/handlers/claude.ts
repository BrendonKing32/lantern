import type { BookCheckEvent, BookCheckResult } from "../../shared/types";
import { AiError, aiStatus, guardedMessage } from "../ai";
import { prepareBookCheck } from "../bookCheck";
import { checkChapter, draftBibleEntry } from "../check";
import { chapterKey, getChapterRow, MAX_CHAPTER_BYTES, requireProject } from "../db";
import { body, HttpError, json, newId, type Handler } from "../http";
import { BIBLE_COLS, toEntry, type BibleRow } from "./bible";

export const getAiStatus: Handler = async (_req, env) => json(await aiStatus(env));

// A tiny call to confirm the key works. It goes through every safeguard and
// counts toward the limits like any other call.
export const testAi: Handler = async (_req, env) => {
  const started = Date.now();
  const r = await guardedMessage(env, {
    purpose: "Connection test",
    system: "You are checking that a connection works.",
    prompt: "Reply with exactly the word: ready",
    maxTokens: 1024,
    effort: "low",
  });
  return json({
    ok: r.stopReason !== "refusal" && r.text.length > 0,
    reply: r.text.slice(0, 200),
    model: r.model,
    ms: Date.now() - started,
    cost_usd: r.costUsd,
  });
};

// Check a chapter against the story bible. The app sends the text on screen
// (unsaved writing included); without it, the last saved text is used.
export const checkChapterHandler: Handler = async (req, env, p) => {
  const row = await getChapterRow(env, p.id);
  const project = await requireProject(env, row.project_id);
  const b = await body<{ content?: unknown }>(req);
  let content: string;
  if (typeof b.content === "string") {
    if (new TextEncoder().encode(b.content).length > MAX_CHAPTER_BYTES) throw new HttpError(413, "Chapter is too large (5 MB limit)");
    content = b.content;
  } else {
    const obj = await env.BUCKET.get(chapterKey(row.project_id, row.id));
    content = obj ? await obj.text() : "";
  }
  if (!content.trim()) throw new HttpError(400, "This chapter is empty, so there's nothing to check yet.");

  const [earlier, bible] = await env.DB.batch([
    env.DB.prepare(
      "SELECT title, synopsis FROM chapters WHERE project_id = ? AND deleted_at IS NULL AND position < ? ORDER BY position",
    ).bind(row.project_id, row.position),
    env.DB.prepare(`SELECT ${BIBLE_COLS} FROM bible_entries WHERE project_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE`).bind(
      row.project_id,
    ),
  ]);
  const before = (earlier.results ?? []) as { title: string; synopsis: string }[];
  const result = await checkChapter(env, {
    projectTitle: project.title,
    chapter: { title: row.title, position: before.length, content },
    earlier: before,
    entries: ((bible.results ?? []) as BibleRow[]).map(toEntry),
  });
  return json(result);
};

// Suggest a story-bible note from a passage the author chose in a chapter.
// The suggestion is returned for review; this endpoint never creates an entry.
export const draftBibleEntryHandler: Handler = async (req, env, p) => {
  const row = await getChapterRow(env, p.id);
  const b = await body<{ content?: unknown; quote?: unknown }>(req);
  let content: string;
  if (typeof b.content === "string") {
    if (new TextEncoder().encode(b.content).length > MAX_CHAPTER_BYTES) throw new HttpError(413, "Chapter is too large (5 MB limit)");
    content = b.content;
  } else {
    const obj = await env.BUCKET.get(chapterKey(row.project_id, row.id));
    content = obj ? await obj.text() : "";
  }
  const quote = typeof b.quote === "string" ? b.quote.trim() : "";
  if (!content.trim()) throw new HttpError(400, "This chapter is empty, so there's nothing to draft from.");
  if (!quote || quote.length > 2000 || !content.includes(quote)) {
    throw new HttpError(400, "That passage is no longer in the chapter. Run the continuity check again.");
  }
  const { results } = await env.DB.prepare(
    `SELECT ${BIBLE_COLS} FROM bible_entries WHERE project_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE`,
  )
    .bind(row.project_id)
    .all<BibleRow>();
  const entries = results.map(toEntry);
  return json(
    await draftBibleEntry(env, {
      chapterTitle: row.title,
      content,
      quote,
      existingEntries: entries.map(({ name, kind, aliases }) => ({ name, kind, aliases })),
    }),
  );
};

// Whole-book check. The app sends the text of any chapter it has unsaved
// writing for; every other chapter is read from storage. Limits are checked
// before anything streams, so those refusals are ordinary error replies. Then
// the reply streams one JSON line per event, with a progress line every ten
// seconds so the connection stays open while Claude reads the book.
export const checkBook: Handler = async (req, env, p) => {
  const project = await requireProject(env, p.id);
  const b = await body<{ overrides?: unknown }>(req);
  const overrides = new Map<string, string>();
  if (b.overrides && typeof b.overrides === "object") {
    for (const [id, text] of Object.entries(b.overrides as Record<string, unknown>)) {
      if (typeof text === "string") overrides.set(id, text);
    }
  }
  const [rows, bible] = await env.DB.batch([
    env.DB.prepare("SELECT id, title FROM chapters WHERE project_id = ? AND deleted_at IS NULL ORDER BY position").bind(p.id),
    env.DB.prepare(`SELECT ${BIBLE_COLS} FROM bible_entries WHERE project_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE`).bind(p.id),
  ]);
  const chapters = await Promise.all(
    ((rows.results ?? []) as { id: string; title: string }[]).map(async (c) => {
      const text = overrides.get(c.id) ?? (await (await env.BUCKET.get(chapterKey(p.id, c.id)))?.text()) ?? "";
      return { ...c, content: text };
    }),
  );
  const prepared = await prepareBookCheck(env, {
    projectTitle: project.title,
    chapters,
    entries: ((bible.results ?? []) as BibleRow[]).map(toEntry),
  });

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  // Writes fail once the browser goes away; the check still settles its cost.
  const send = (e: BookCheckEvent) => writer.write(enc.encode(JSON.stringify(e) + "\n")).catch(() => {});

  const started = Date.now();
  void (async () => {
    await send({ type: "started", reserved_usd: prepared.call.reservedUsd, chapters: prepared.chapters, words: prepared.words });
    const tick = setInterval(() => void send({ type: "progress", seconds: Math.round((Date.now() - started) / 1000) }), 10_000);
    try {
      const result = await prepared.finish();
      await env.DB.prepare("INSERT INTO book_checks (id, project_id, result, created_at) VALUES (?, ?, ?, ?)")
        .bind(newId(), p.id, JSON.stringify(result), result.checked_at)
        .run();
      await send({ type: "result", result });
    } catch (e) {
      const err = e instanceof AiError ? e : new AiError(500, "Something went wrong checking the book.", "unknown");
      if (!(e instanceof AiError)) console.error(e);
      await send({ type: "error", status: err.status, code: err.code, error: err.message });
    } finally {
      clearInterval(tick);
      await writer.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
};

export const lastBookCheck: Handler = async (_req, env, p) => {
  await requireProject(env, p.id);
  const row = await env.DB.prepare("SELECT result FROM book_checks WHERE project_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(p.id)
    .first<{ result: string }>();
  return json(row ? (JSON.parse(row.result) as BookCheckResult) : null);
};
