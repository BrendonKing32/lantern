import { BIBLE_KINDS } from "../../shared/types";
import type { BibleEntry, BibleKind } from "../../shared/types";
import { requireProject } from "../db";
import type { Env } from "../env";
import { body, HttpError, json, newId, now, type Handler } from "../http";

const MAX_BIBLE_BODY = 200_000;
export const BIBLE_COLS = "id, project_id, kind, name, aliases, body, created_at, updated_at";
export type BibleRow = Omit<BibleEntry, "aliases"> & { aliases: string };

export const toEntry = (r: BibleRow): BibleEntry => {
  let aliases: string[] = [];
  try {
    const parsed = JSON.parse(r.aliases);
    if (Array.isArray(parsed)) aliases = parsed.filter((a): a is string => typeof a === "string");
  } catch {
    /* treat as none */
  }
  return { ...r, aliases };
};

function cleanAliases(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, "aliases must be a list of names");
  const seen = new Set([name.toLowerCase()]);
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const a = v.trim().replace(/[[\]|]/g, "").slice(0, 100);
    if (a && !seen.has(a.toLowerCase())) {
      seen.add(a.toLowerCase());
      out.push(a);
    }
  }
  return out.slice(0, 30);
}

function cleanName(value: unknown): string {
  // Brackets and pipes would break [[links]] to the entry.
  const n = typeof value === "string" ? value.trim().replace(/[[\]|]/g, "").slice(0, 120) : "";
  if (!n) throw new HttpError(400, "An entry needs a name");
  return n;
}

async function requireEntry(env: Env, id: string): Promise<BibleEntry> {
  const row = await env.DB.prepare(
    `SELECT ${BIBLE_COLS} FROM bible_entries
      WHERE id = ? AND deleted_at IS NULL
        AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)`,
  )
    .bind(id)
    .first<BibleRow>();
  if (!row) throw new HttpError(404, "That entry wasn't found");
  return toEntry(row);
}

// Names are matched case-insensitively, so two entries can't share one.
async function assertNameFree(env: Env, projectId: string, names: string[], exceptId: string | null) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, aliases FROM bible_entries WHERE project_id = ? AND deleted_at IS NULL",
  )
    .bind(projectId)
    .all<{ id: string; name: string; aliases: string }>();
  const wanted = new Map(names.map((n) => [n.toLowerCase(), n]));
  for (const r of results) {
    if (r.id === exceptId) continue;
    const e = toEntry({ ...r, aliases: r.aliases } as BibleRow);
    for (const taken of [e.name, ...e.aliases]) {
      const clash = wanted.get(taken.toLowerCase());
      if (clash) throw new HttpError(409, `“${clash}” is already used by the entry “${e.name}”`);
    }
  }
}

export const listBible: Handler = async (_req, env, p) => {
  await requireProject(env, p.id);
  const { results } = await env.DB.prepare(
    `SELECT ${BIBLE_COLS} FROM bible_entries WHERE project_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE`,
  )
    .bind(p.id)
    .all<BibleRow>();
  return json(results.map(toEntry));
};

export const createEntry: Handler = async (req, env, p) => {
  await requireProject(env, p.id);
  const b = await body<{ kind?: unknown; name?: unknown; aliases?: unknown; body?: unknown }>(req);
  const name = cleanName(b.name);
  const kind: BibleKind = BIBLE_KINDS.includes(b.kind as BibleKind) ? (b.kind as BibleKind) : "note";
  const aliases = cleanAliases(b.aliases ?? [], name);
  const text = typeof b.body === "string" ? b.body.slice(0, MAX_BIBLE_BODY) : "";
  await assertNameFree(env, p.id, [name, ...aliases], null);
  const id = newId();
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO bible_entries (id, project_id, kind, name, aliases, body, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, p.id, kind, name, JSON.stringify(aliases), text, ts, ts)
    .run();
  const entry: BibleEntry = { id, project_id: p.id, kind, name, aliases, body: text, created_at: ts, updated_at: ts };
  return json(entry, 201);
};

export const updateEntry: Handler = async (req, env, p) => {
  const entry = await requireEntry(env, p.id);
  const b = await body<{ kind?: unknown; name?: unknown; aliases?: unknown; body?: unknown }>(req);
  const name = b.name === undefined ? entry.name : cleanName(b.name);
  const kind = b.kind === undefined ? entry.kind : BIBLE_KINDS.includes(b.kind as BibleKind) ? (b.kind as BibleKind) : entry.kind;
  const aliases = b.aliases === undefined ? entry.aliases.filter((a) => a.toLowerCase() !== name.toLowerCase()) : cleanAliases(b.aliases, name);
  const text = typeof b.body === "string" ? b.body.slice(0, MAX_BIBLE_BODY) : entry.body;
  if (b.name !== undefined || b.aliases !== undefined) await assertNameFree(env, entry.project_id, [name, ...aliases], entry.id);
  const ts = now();
  await env.DB.prepare(
    "UPDATE bible_entries SET kind = ?, name = ?, aliases = ?, body = ?, updated_at = ? WHERE id = ?",
  )
    .bind(kind, name, JSON.stringify(aliases), text, ts, entry.id)
    .run();
  return json({ ...entry, kind, name, aliases, body: text, updated_at: ts });
};

export const deleteEntry: Handler = async (_req, env, p) => {
  const entry = await requireEntry(env, p.id);
  await env.DB.prepare("UPDATE bible_entries SET deleted_at = ? WHERE id = ?").bind(now(), entry.id).run();
  return json({ ok: true });
};
