import type { MarginNote } from "../../shared/types";
import { assertChapterUnlocked, chapterMoveToken, getChapterRow } from "../db";
import type { Env } from "../env";
import { body, HttpError, json, newId, now, type Handler } from "../http";

const NOTE_COLS = "id, project_id, chapter_id, quote, prefix, suffix, body, author, resolved_at, created_at, updated_at";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "A note needs an object");
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max: number, min = 0): string {
  if (typeof value !== "string" || value.length < min || value.length > max) {
    throw new HttpError(400, `${name} must be ${min} to ${max} characters`);
  }
  return value;
}

async function requireNote(env: Env, id: string): Promise<MarginNote> {
  const note = await env.DB.prepare(
    `SELECT ${NOTE_COLS} FROM margin_notes WHERE id = ?
      AND chapter_id IN (SELECT id FROM chapters WHERE deleted_at IS NULL)
      AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)`,
  ).bind(id).first<MarginNote>();
  if (!note) throw new HttpError(404, "Note not found");
  return note;
}

export async function captureNoteChapter(env: Env, chapterId: string) {
  const chapter = await getChapterRow(env, chapterId);
  await assertChapterUnlocked(env, chapterId);
  const token = await chapterMoveToken(env, chapterId);
  return { chapter, token };
}

async function failedWrite(env: Env, chapterId: string): Promise<never> {
  await getChapterRow(env, chapterId);
  await assertChapterUnlocked(env, chapterId);
  throw new HttpError(409, "The chapter or note changed. Open it again and try again.");
}

// Each mutation checks the chapter and move token in the same SQL statement as
// the write, so it cannot slip in after a move has gathered its notes.
const GUARD = `EXISTS (SELECT 1 FROM chapters c JOIN projects p ON p.id = c.project_id
  WHERE c.id = ? AND c.project_id = ? AND c.version = ? AND c.moving_until IS ?
    AND (c.moving_until IS NULL OR c.moving_until <= ?)
    AND c.deleted_at IS NULL AND p.deleted_at IS NULL)`;

export async function listChapterNotes(env: Env, chapterId: string, resolved: boolean): Promise<MarginNote[]> {
  await getChapterRow(env, chapterId);
  const { results } = await env.DB.prepare(
    `SELECT ${NOTE_COLS} FROM margin_notes WHERE chapter_id = ?
      AND resolved_at IS ${resolved ? "NOT " : ""}NULL
      AND chapter_id IN (SELECT id FROM chapters WHERE deleted_at IS NULL)
      AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)
      ORDER BY created_at, id`,
  ).bind(chapterId).all<MarginNote>();
  return results;
}

export const listNotes: Handler = async (req, env, p) => {
  const resolved = new URL(req.url).searchParams.get("resolved") ?? "0";
  if (resolved !== "0" && resolved !== "1") throw new HttpError(400, "resolved must be 0 or 1");
  return json(await listChapterNotes(env, p.id, resolved === "1"));
};

export async function createChapterNote(
  env: Env, chapterId: string, input: unknown, author: "writer" | "claude",
  captured?: Awaited<ReturnType<typeof captureNoteChapter>>,
): Promise<MarginNote> {
  const b = object(input);
  const quote = text(b.quote, "quote", 2000, 1);
  const prefix = text(b.prefix, "prefix", 32);
  const suffix = text(b.suffix, "suffix", 32);
  const noteBody = text(b.body, "body", 4000);
  const { chapter, token } = captured ?? await captureNoteChapter(env, chapterId);
  if (chapter.id !== chapterId) throw new HttpError(400, "Chapter does not match the note");
  const ts = now();
  const note = await env.DB.prepare(
    `INSERT INTO margin_notes (id, project_id, chapter_id, quote, prefix, suffix, body, author, resolved_at, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ? WHERE ${GUARD}
     RETURNING ${NOTE_COLS}`,
  ).bind(newId(), chapter.project_id, chapter.id, quote, prefix, suffix, noteBody, author, ts, ts,
    chapter.id, chapter.project_id, chapter.version, token, ts).first<MarginNote>();
  if (!note) return failedWrite(env, chapter.id);
  return note;
}

export const createNote: Handler = async (req, env, p) => {
  return json(await createChapterNote(env, p.id, await body<unknown>(req), "writer"), 201);
};

export const updateNote: Handler = async (req, env, p) => {
  const b = object(await body<unknown>(req));
  if (b.body === undefined && b.resolved === undefined) throw new HttpError(400, "Choose a note change");
  const noteBody = b.body === undefined ? null : text(b.body, "body", 4000);
  if (b.resolved !== undefined && typeof b.resolved !== "boolean") throw new HttpError(400, "resolved must be true or false");
  const note = await requireNote(env, p.id);
  const { chapter, token } = await captureNoteChapter(env, note.chapter_id);
  const ts = now();
  const updated = await env.DB.prepare(
    `UPDATE margin_notes SET body = COALESCE(?, body),
      resolved_at = CASE WHEN ? IS NULL THEN resolved_at WHEN ? = 1 THEN COALESCE(resolved_at, ?) ELSE NULL END,
      updated_at = ?
     WHERE id = ? AND chapter_id = ? AND project_id = ? AND ${GUARD}
     RETURNING ${NOTE_COLS}`,
  ).bind(noteBody, b.resolved === undefined ? null : Number(b.resolved), Number(b.resolved), ts, ts,
    note.id, chapter.id, chapter.project_id, chapter.id, chapter.project_id, chapter.version, token, ts).first<MarginNote>();
  if (!updated) return failedWrite(env, chapter.id);
  return json(updated);
};

export const deleteNote: Handler = async (_req, env, p) => {
  const note = await requireNote(env, p.id);
  const { chapter, token } = await captureNoteChapter(env, note.chapter_id);
  const deleted = await env.DB.prepare(
    `DELETE FROM margin_notes WHERE id = ? AND chapter_id = ? AND project_id = ? AND ${GUARD}
     RETURNING id`,
  ).bind(note.id, chapter.id, chapter.project_id, chapter.id, chapter.project_id, chapter.version, token, now())
    .first<{ id: string }>();
  if (!deleted) return failedWrite(env, chapter.id);
  return json({ ok: true });
};
