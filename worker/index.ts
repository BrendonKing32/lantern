import { createRemoteJWKSet, jwtVerify } from "jose";
import { countWords } from "../shared/wordcount";
import { BIBLE_KINDS, DIALECTS } from "../shared/types";
import { AiError, aiStatus, guardedMessage, type AiEnv } from "./ai";
import { checkChapter, draftBibleEntry } from "./check";
import { prepareBookCheck } from "./bookCheck";
import { createBackup, type BackupEnv } from "./backups";
import type {
  BibleEntry,
  BibleKind,
  ChapterMeta,
  DeletedChapter,
  DeletedProject,
  BookCheckEvent,
  BookCheckResult,
  ProjectInfo,
  ProjectSummary,
  Snapshot,
  SnapshotReason,
  SceneMeta,
  Stats,
} from "../shared/types";

export interface Env extends AiEnv, BackupEnv {
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  DEV_BYPASS?: string;
}

const MAX_CHAPTER_BYTES = 5 * 1024 * 1024;
// While someone keeps writing, keep at most one automatic snapshot per window.
const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
const CHAPTER_COLS =
  "id, project_id, title, synopsis, position, word_count, version, updated_at";
const SCENE_COLS =
  "id, project_id, chapter_id, title, summary, pov, location, status, position, created_at, updated_at";

// ---------- helpers ----------

class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: object) {
    super(message);
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const chapterKey = (projectId: string, chapterId: string) =>
  `projects/${projectId}/chapters/${chapterId}.md`;
const snapshotKey = (projectId: string, chapterId: string, snapshotId: string) =>
  `projects/${projectId}/chapters/${chapterId}/history/${snapshotId}.md`;
const MARKDOWN = { httpMetadata: { contentType: "text/markdown; charset=utf-8" } };

async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function cleanTitle(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const t = value.trim().slice(0, 200);
  return t || fallback;
}

// ---------- auth (Cloudflare Access) ----------

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function authorize(req: Request, env: Env): Promise<string> {
  if (env.DEV_BYPASS === "true") return "dev@localhost";
  // Fail closed: if Access isn't configured yet, nobody gets in.
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new HttpError(503, "Access is not configured for this deployment");
  }
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new HttpError(401, "Not signed in");
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  try {
    let jwks = jwksByIssuer.get(issuer);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      jwksByIssuer.set(issuer, jwks);
    }
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: env.ACCESS_AUD });
    return typeof payload.email === "string" ? payload.email : "unknown";
  } catch {
    throw new HttpError(401, "Invalid Access token");
  }
}

// ---------- data access ----------

async function getChapterRow(env: Env, id: string): Promise<ChapterMeta> {
  const row = await env.DB.prepare(
    `SELECT ${CHAPTER_COLS} FROM chapters
      WHERE id = ? AND deleted_at IS NULL
        AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)`,
  )
    .bind(id)
    .first<ChapterMeta>();
  if (!row) throw new HttpError(404, "Chapter not found");
  return row;
}

async function requireProject(env: Env, id: string): Promise<ProjectInfo> {
  const row = await env.DB.prepare(
    `SELECT id, title, created_at, updated_at, target_words, target_date, dialect
       FROM projects WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(id)
    .first<ProjectInfo>();
  if (!row) throw new HttpError(404, "Project not found");
  return row;
}

async function getSceneRow(env: Env, id: string): Promise<SceneMeta> {
  const row = await env.DB.prepare(
    `SELECT ${SCENE_COLS} FROM scenes
      WHERE id = ? AND chapter_id IN (
        SELECT id FROM chapters WHERE deleted_at IS NULL
          AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)
      )`,
  )
    .bind(id)
    .first<SceneMeta>();
  if (!row) throw new HttpError(404, "Scene not found");
  return row;
}

async function insertChapter(env: Env, projectId: string, title: string): Promise<ChapterMeta> {
  const max = await env.DB.prepare(
    "SELECT COALESCE(MAX(position), -1) AS m FROM chapters WHERE project_id = ? AND deleted_at IS NULL",
  )
    .bind(projectId)
    .first<{ m: number }>();
  const id = newId();
  const ts = now();
  const position = (max?.m ?? -1) + 1;
  await env.BUCKET.put(chapterKey(projectId, id), "", MARKDOWN);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO chapters (id, project_id, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, projectId, title, position, ts, ts),
    env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(ts, projectId),
  ]);
  return {
    id, project_id: projectId, title, synopsis: "", position,
    word_count: 0, version: 0, updated_at: ts,
  };
}

/**
 * Copy the chapter's current text into its history before it's overwritten.
 * Automatic snapshots are rate-limited; restores and conflict overwrites always
 * keep a copy. Empty text is never worth keeping.
 */
async function snapshotBeforeSave(env: Env, row: ChapterMeta, reason: SnapshotReason) {
  if (reason === "auto") {
    const last = await env.DB.prepare(
      "SELECT created_at FROM chapter_snapshots WHERE chapter_id = ? ORDER BY created_at DESC LIMIT 1",
    )
      .bind(row.id)
      .first<{ created_at: string }>();
    if (last && Date.now() - Date.parse(last.created_at) < SNAPSHOT_INTERVAL_MS) return;
  }
  const obj = await env.BUCKET.get(chapterKey(row.project_id, row.id));
  const text = obj ? await obj.text() : "";
  if (!text.trim()) return;
  const id = newId();
  await env.BUCKET.put(snapshotKey(row.project_id, row.id, id), text, MARKDOWN);
  await env.DB.prepare(
    "INSERT INTO chapter_snapshots (id, chapter_id, version, word_count, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, row.id, row.version, countWords(text), reason, now())
    .run();
}

// ---------- handlers ----------

type Params = Record<string, string>;
type Handler = (req: Request, env: Env, p: Params) => Promise<Response>;

const PROJECT_SUMMARY = `
  SELECT p.id, p.title, p.created_at, p.updated_at, p.archived_at, p.deleted_at,
         COUNT(c.id) AS chapter_count, COALESCE(SUM(c.word_count), 0) AS word_count
    FROM projects p
    LEFT JOIN chapters c ON c.project_id = p.id AND c.deleted_at IS NULL`;

const listProjects: Handler = async (_req, env) => {
  const { results } = await env.DB.prepare(
    `${PROJECT_SUMMARY} WHERE p.deleted_at IS NULL GROUP BY p.id ORDER BY p.updated_at DESC`,
  ).all<ProjectSummary & { deleted_at: null }>();
  return json(results.map(({ deleted_at: _, ...p }) => p));
};

const listDeletedProjects: Handler = async (_req, env) => {
  const { results } = await env.DB.prepare(
    `${PROJECT_SUMMARY} WHERE p.deleted_at IS NOT NULL GROUP BY p.id ORDER BY p.deleted_at DESC LIMIT 200`,
  ).all<DeletedProject>();
  return json(
    results.map(({ id, title, deleted_at, chapter_count, word_count }) => ({
      id, title, deleted_at, chapter_count, word_count,
    })),
  );
};

// Bring a deleted novel back to the shelf, with the chapters it had when deleted.
const restoreProject: Handler = async (_req, env, p) => {
  const res = await env.DB.prepare(
    "UPDATE projects SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL",
  )
    .bind(p.id)
    .run();
  if (!res.meta.changes) throw new HttpError(404, "That novel isn't in Deleted");
  const row = await env.DB.prepare(`${PROJECT_SUMMARY} WHERE p.id = ? GROUP BY p.id`)
    .bind(p.id)
    .first<ProjectSummary & { deleted_at: null }>();
  const { deleted_at: _, ...summary } = row!;
  return json(summary);
};

const createProject: Handler = async (req, env) => {
  const b = await body<{ title?: string }>(req);
  const id = newId();
  const ts = now();
  const title = cleanTitle(b.title, "Untitled novel");
  await env.DB.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(id, title, ts, ts)
    .run();
  await insertChapter(env, id, "Chapter 1");
  return json({ id, title, created_at: ts, updated_at: ts }, 201);
};

const getProject: Handler = async (_req, env, p) => {
  const project = await requireProject(env, p.id);
  const { results } = await env.DB.prepare(
    `SELECT ${CHAPTER_COLS} FROM chapters WHERE project_id = ? AND deleted_at IS NULL ORDER BY position`,
  )
    .bind(p.id)
    .all<ChapterMeta>();
  return json({ project, chapters: results });
};

const updateProject: Handler = async (req, env, p) => {
  const project = await requireProject(env, p.id);
  const b = await body<{ title?: string; archived?: unknown }>(req);
  if (b.archived !== undefined) {
    if (typeof b.archived !== "boolean") throw new HttpError(400, "archived must be true or false");
    // Archiving leaves updated_at alone so the novel keeps its place on the shelf.
    const archivedAt = b.archived ? now() : null;
    await env.DB.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").bind(archivedAt, p.id).run();
    if (b.title === undefined) return json({ id: p.id, title: project.title, archived_at: archivedAt });
  }
  const title = cleanTitle(b.title, "Untitled novel");
  await env.DB.prepare("UPDATE projects SET title = ?, updated_at = ? WHERE id = ?")
    .bind(title, now(), p.id)
    .run();
  return json({ id: p.id, title });
};

const setTarget: Handler = async (req, env, p) => {
  await requireProject(env, p.id);
  const b = await body<{ target_words?: unknown; target_date?: unknown }>(req);
  const words = b.target_words ?? null;
  const date = b.target_date ?? null;
  if (words !== null && !(Number.isInteger(words) && (words as number) > 0 && (words as number) <= 10_000_000)) {
    throw new HttpError(400, "target_words must be a whole number above zero");
  }
  if (date !== null && !isDay(date)) throw new HttpError(400, "target_date must be YYYY-MM-DD");
  await env.DB.prepare("UPDATE projects SET target_words = ?, target_date = ? WHERE id = ?")
    .bind(words, words === null ? null : date, p.id)
    .run();
  return json({ target_words: words, target_date: words === null ? null : date });
};

const setDialect: Handler = async (req, env, p) => {
  await requireProject(env, p.id);
  const { dialect } = await body<{ dialect?: unknown }>(req);
  if (!DIALECTS.some((d) => d.id === dialect)) {
    throw new HttpError(400, `dialect must be one of ${DIALECTS.map((d) => d.id).join(", ")}`);
  }
  await env.DB.prepare("UPDATE projects SET dialect = ? WHERE id = ?").bind(dialect, p.id).run();
  return json({ dialect });
};

const deleteProject: Handler = async (_req, env, p) => {
  await requireProject(env, p.id);
  await env.DB.prepare("UPDATE projects SET deleted_at = ? WHERE id = ?").bind(now(), p.id).run();
  return json({ ok: true });
};

const listDeletedChapters: Handler = async (_req, env, p) => {
  await requireProject(env, p.id);
  const { results } = await env.DB.prepare(
    `SELECT id, title, word_count, deleted_at FROM chapters
      WHERE project_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT 200`,
  )
    .bind(p.id)
    .all<DeletedChapter>();
  return json(results);
};

// A restored chapter goes back at the end of the book; drag it where it belongs.
const restoreChapter: Handler = async (_req, env, p) => {
  const row = await env.DB.prepare(
    `SELECT project_id FROM chapters
      WHERE id = ? AND deleted_at IS NOT NULL
        AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)`,
  )
    .bind(p.id)
    .first<{ project_id: string }>();
  if (!row) throw new HttpError(404, "That chapter isn't in Recently deleted");
  const ts = now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE chapters SET deleted_at = NULL,
              position = (SELECT COALESCE(MAX(position), -1) + 1 FROM chapters
                           WHERE project_id = ? AND deleted_at IS NULL)
        WHERE id = ?`,
    ).bind(row.project_id, p.id),
    env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(ts, row.project_id),
  ]);
  return json(await getChapterRow(env, p.id));
};

const createChapter: Handler = async (req, env, p) => {
  await requireProject(env, p.id);
  const b = await body<{ title?: string }>(req);
  const chapter = await insertChapter(env, p.id, cleanTitle(b.title, "Untitled chapter"));
  return json(chapter, 201);
};

const reorderChapters: Handler = async (req, env, p) => {
  await requireProject(env, p.id);
  const b = await body<{ chapterIds?: unknown }>(req);
  if (!Array.isArray(b.chapterIds) || !b.chapterIds.every((x) => typeof x === "string")) {
    throw new HttpError(400, "chapterIds must be an array of ids");
  }
  const ids = b.chapterIds as string[];
  const { results } = await env.DB.prepare(
    "SELECT id FROM chapters WHERE project_id = ? AND deleted_at IS NULL",
  )
    .bind(p.id)
    .all<{ id: string }>();
  const existing = new Set(results.map((r) => r.id));
  if (ids.length !== existing.size || !ids.every((id) => existing.has(id))) {
    throw new HttpError(409, "Chapter list is out of date; reload and try again");
  }
  await env.DB.batch(
    ids.map((id, i) =>
      env.DB.prepare("UPDATE chapters SET position = ? WHERE id = ? AND project_id = ?").bind(i, id, p.id),
    ),
  );
  return json({ ok: true });
};

const listScenes: Handler = async (_req, env, p) => {
  await requireProject(env, p.id);
  const { results } = await env.DB.prepare(
    `SELECT ${SCENE_COLS} FROM scenes
      WHERE project_id = ? AND chapter_id IN (
        SELECT id FROM chapters WHERE deleted_at IS NULL
      )
      ORDER BY (SELECT position FROM chapters WHERE chapters.id = scenes.chapter_id), position`,
  )
    .bind(p.id)
    .all<SceneMeta>();
  return json(results);
};

const createScene: Handler = async (_req, env, p) => {
  const chapter = await getChapterRow(env, p.id);
  const max = await env.DB.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM scenes WHERE chapter_id = ?")
    .bind(chapter.id)
    .first<{ m: number }>();
  const ts = now();
  const scene: SceneMeta = {
    id: newId(),
    project_id: chapter.project_id,
    chapter_id: chapter.id,
    title: "New scene",
    summary: "",
    pov: "",
    location: "",
    status: "planned",
    position: (max?.m ?? -1) + 1,
    created_at: ts,
    updated_at: ts,
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO scenes (${SCENE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      scene.id, scene.project_id, scene.chapter_id, scene.title, scene.summary, scene.pov,
      scene.location, scene.status, scene.position, scene.created_at, scene.updated_at,
    ),
    env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(ts, scene.project_id),
  ]);
  return json(scene, 201);
};

const updateScene: Handler = async (req, env, p) => {
  const scene = await getSceneRow(env, p.id);
  const b = await body<{ title?: unknown; summary?: unknown; pov?: unknown; location?: unknown; status?: unknown }>(req);
  for (const field of ["title", "summary", "pov", "location"] as const) {
    if (b[field] !== undefined && typeof b[field] !== "string") {
      throw new HttpError(400, `${field} must be a string`);
    }
  }
  if (b.status !== undefined && b.status !== "planned" && b.status !== "drafted") {
    throw new HttpError(400, "status must be planned or drafted");
  }
  const updated: SceneMeta = {
    ...scene,
    title: b.title === undefined ? scene.title : cleanTitle(b.title, scene.title),
    summary: typeof b.summary === "string" ? b.summary.slice(0, 2000) : scene.summary,
    pov: typeof b.pov === "string" ? b.pov.slice(0, 120) : scene.pov,
    location: typeof b.location === "string" ? b.location.slice(0, 120) : scene.location,
    status: b.status === undefined ? scene.status : b.status,
    updated_at: now(),
  };
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE scenes SET title = ?, summary = ?, pov = ?, location = ?, status = ?, updated_at = ? WHERE id = ?",
    ).bind(updated.title, updated.summary, updated.pov, updated.location, updated.status, updated.updated_at, scene.id),
    env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(updated.updated_at, scene.project_id),
  ]);
  return json(updated);
};

const deleteScene: Handler = async (_req, env, p) => {
  const scene = await getSceneRow(env, p.id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM scenes WHERE id = ?").bind(scene.id),
    env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(now(), scene.project_id),
  ]);
  return json({ ok: true });
};

const reorderScenes: Handler = async (req, env, p) => {
  await requireProject(env, p.id);
  const b = await body<{ chapterId?: unknown; sceneIds?: unknown }>(req);
  if (typeof b.chapterId !== "string" || !Array.isArray(b.sceneIds) || !b.sceneIds.every((x) => typeof x === "string")) {
    throw new HttpError(400, "chapterId and sceneIds are required");
  }
  const chapter = await getChapterRow(env, b.chapterId);
  if (chapter.project_id !== p.id) throw new HttpError(404, "Chapter not found");
  const { results } = await env.DB.prepare("SELECT id FROM scenes WHERE chapter_id = ?")
    .bind(chapter.id)
    .all<{ id: string }>();
  const existing = new Set(results.map((r) => r.id));
  const ids = b.sceneIds as string[];
  if (ids.length !== existing.size || !ids.every((id) => existing.has(id)) || new Set(ids).size !== ids.length) {
    throw new HttpError(409, "Scene list is out of date; reload and try again");
  }
  await env.DB.batch([
    ...ids.map((id, i) => env.DB.prepare("UPDATE scenes SET position = ? WHERE id = ?").bind(i, id)),
    env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(now(), p.id),
  ]);
  return json({ ok: true });
};

const getChapter: Handler = async (_req, env, p) => {
  const row = await getChapterRow(env, p.id);
  const obj = await env.BUCKET.get(chapterKey(row.project_id, row.id));
  const content = obj ? await obj.text() : "";
  return json({ ...row, content });
};

const saveChapter: Handler = async (req, env, p) => {
  const b = await body<{ content?: unknown; baseVersion?: unknown; snapshot?: unknown; day?: unknown }>(req);
  if (typeof b.content !== "string") throw new HttpError(400, "content must be a string");
  const reason: SnapshotReason =
    b.snapshot === "restore" || b.snapshot === "conflict" ? b.snapshot : "auto";
  if (typeof b.baseVersion !== "number") throw new HttpError(400, "baseVersion must be a number");
  if (new TextEncoder().encode(b.content).length > MAX_CHAPTER_BYTES) {
    throw new HttpError(413, "Chapter is too large (5 MB limit)");
  }
  const row = await getChapterRow(env, p.id);
  const ts = now();
  const words = countWords(b.content);

  // Claim the next version only if nobody else saved in the meantime.
  const claim = await env.DB.prepare(
    `UPDATE chapters SET version = version + 1, word_count = ?, updated_at = ?
      WHERE id = ? AND version = ? AND deleted_at IS NULL`,
  )
    .bind(words, ts, row.id, b.baseVersion)
    .run();
  if (!claim.meta.changes) {
    const current = await getChapterRow(env, p.id);
    throw new HttpError(409, "conflict", { version: current.version });
  }

  // History is a safety net, so a failure here never blocks the save itself.
  try {
    await snapshotBeforeSave(env, row, reason);
  } catch (e) {
    console.error("snapshot failed", e);
  }

  try {
    await env.BUCKET.put(chapterKey(row.project_id, row.id), b.content, MARKDOWN);
  } catch (e) {
    // Roll the version back so the client's next attempt still lines up.
    await env.DB.prepare(
      "UPDATE chapters SET version = ?, word_count = ? WHERE id = ? AND version = ?",
    )
      .bind(b.baseVersion, row.word_count, row.id, b.baseVersion + 1)
      .run();
    throw e;
  }
  // Count the words this save added (or removed) toward the writer's day.
  // Putting back an old version from History isn't writing, so it doesn't count.
  const day = isDay(b.day) ? b.day : ts.slice(0, 10);
  const delta = reason === "restore" ? 0 : words - row.word_count;
  await env.DB.batch([
    env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(ts, row.project_id),
    env.DB.prepare(
      `INSERT INTO daily_words (day, project_id, words) VALUES (?, ?, ?)
         ON CONFLICT (day, project_id) DO UPDATE SET words = words + excluded.words`,
    ).bind(day, row.project_id, delta),
  ]);
  const today = await env.DB.prepare("SELECT COALESCE(SUM(words), 0) AS w FROM daily_words WHERE day = ?")
    .bind(day)
    .first<{ w: number }>();

  return json({ version: b.baseVersion + 1, word_count: words, updated_at: ts, today_words: today?.w ?? 0 });
};

const updateChapter: Handler = async (req, env, p) => {
  const row = await getChapterRow(env, p.id);
  const b = await body<{ title?: string; synopsis?: string }>(req);
  const title = b.title === undefined ? row.title : cleanTitle(b.title, row.title);
  const synopsis = typeof b.synopsis === "string" ? b.synopsis.slice(0, 2000) : row.synopsis;
  await env.DB.prepare("UPDATE chapters SET title = ?, synopsis = ? WHERE id = ?")
    .bind(title, synopsis, row.id)
    .run();
  return json({ ...row, title, synopsis });
};

const deleteChapter: Handler = async (_req, env, p) => {
  const row = await getChapterRow(env, p.id);
  await env.DB.prepare("UPDATE chapters SET deleted_at = ? WHERE id = ?").bind(now(), row.id).run();
  return json({ ok: true });
};

const listHistory: Handler = async (_req, env, p) => {
  const row = await getChapterRow(env, p.id);
  const { results } = await env.DB.prepare(
    `SELECT id, version, word_count, reason, created_at FROM chapter_snapshots
      WHERE chapter_id = ? ORDER BY created_at DESC LIMIT 500`,
  )
    .bind(row.id)
    .all<Snapshot>();
  return json(results);
};

const getSnapshot: Handler = async (_req, env, p) => {
  const row = await getChapterRow(env, p.id);
  const snap = await env.DB.prepare(
    "SELECT id, version, word_count, reason, created_at FROM chapter_snapshots WHERE id = ? AND chapter_id = ?",
  )
    .bind(p.snapshotId, row.id)
    .first<Snapshot>();
  if (!snap) throw new HttpError(404, "That version wasn't found");
  const obj = await env.BUCKET.get(snapshotKey(row.project_id, row.id, snap.id));
  if (!obj) throw new HttpError(404, "That version's text is missing from storage");
  return json({ ...snap, content: await obj.text() });
};

// ---------- story bible ----------

const MAX_BIBLE_BODY = 200_000;
const BIBLE_COLS = "id, project_id, kind, name, aliases, body, created_at, updated_at";
type BibleRow = Omit<BibleEntry, "aliases"> & { aliases: string };

const toEntry = (r: BibleRow): BibleEntry => {
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

const listBible: Handler = async (_req, env, p) => {
  await requireProject(env, p.id);
  const { results } = await env.DB.prepare(
    `SELECT ${BIBLE_COLS} FROM bible_entries WHERE project_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE`,
  )
    .bind(p.id)
    .all<BibleRow>();
  return json(results.map(toEntry));
};

const createEntry: Handler = async (req, env, p) => {
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

const updateEntry: Handler = async (req, env, p) => {
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

const deleteEntry: Handler = async (_req, env, p) => {
  const entry = await requireEntry(env, p.id);
  await env.DB.prepare("UPDATE bible_entries SET deleted_at = ? WHERE id = ?").bind(now(), entry.id).run();
  return json({ ok: true });
};

// ---------- goals and streaks ----------

const DAY_MS = 86_400_000;
const shiftDay = (day: string, by: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS).toISOString().slice(0, 10);

function isDay(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

async function dailyGoal(env: Env): Promise<number | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'daily_goal'").first<{ value: string }>();
  const n = row ? Number(row.value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

const getStats: Handler = async (req, env) => {
  const q = new URL(req.url).searchParams.get("today");
  const today = isDay(q) ? q : now().slice(0, 10);
  const goal = await dailyGoal(env);
  // A year back is plenty for the streak; the calendar shows the last 12 weeks.
  const { results } = await env.DB.prepare(
    `SELECT day, SUM(words) AS words FROM daily_words
      WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day`,
  )
    .bind(shiftDay(today, -400), today)
    .all<{ day: string; words: number }>();
  const byDay = new Map(results.map((r) => [r.day, r.words]));
  const met = (d: string) => (byDay.get(d) ?? 0) >= (goal ?? 1);

  // Today only adds to the streak once it's met; until then it can't break it.
  let streak = 0;
  for (let d = met(today) ? today : shiftDay(today, -1); met(d); d = shiftDay(d, -1)) streak++;

  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const r of results) {
    if (r.words < (goal ?? 1)) {
      run = 0;
    } else {
      run = prev !== null && shiftDay(prev, 1) === r.day && run > 0 ? run + 1 : 1;
      best = Math.max(best, run);
    }
    prev = r.day;
  }

  const since = shiftDay(today, -83);
  const stats: Stats = {
    daily_goal: goal,
    today: byDay.get(today) ?? 0,
    streak,
    best_streak: Math.max(best, streak),
    days: results.filter((r) => r.day >= since && r.words !== 0),
  };
  return json(stats);
};

const setGoal: Handler = async (req, env) => {
  const b = await body<{ daily_goal?: unknown }>(req);
  const goal = b.daily_goal ?? null;
  if (goal !== null && !(Number.isInteger(goal) && (goal as number) > 0 && (goal as number) <= 1_000_000)) {
    throw new HttpError(400, "daily_goal must be a whole number above zero");
  }
  if (goal === null) {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'daily_goal'").run();
  } else {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('daily_goal', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
      .bind(String(goal))
      .run();
  }
  return json({ daily_goal: goal });
};

// ---------- Claude ----------

const getAiStatus: Handler = async (_req, env) => json(await aiStatus(env));

// A tiny call to confirm the key works. It goes through every safeguard and
// counts toward the limits like any other call.
const testAi: Handler = async (_req, env) => {
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
const checkChapterHandler: Handler = async (req, env, p) => {
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
const draftBibleEntryHandler: Handler = async (req, env, p) => {
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
const checkBook: Handler = async (req, env, p) => {
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

const lastBookCheck: Handler = async (_req, env, p) => {
  await requireProject(env, p.id);
  const row = await env.DB.prepare("SELECT result FROM book_checks WHERE project_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(p.id)
    .first<{ result: string }>();
  return json(row ? (JSON.parse(row.result) as BookCheckResult) : null);
};

// ---------- router ----------

const routes: Array<[string, string, Handler]> = [
  ["GET", "/api/projects", listProjects],
  ["GET", "/api/stats", getStats],
  ["GET", "/api/ai/status", getAiStatus],
  ["POST", "/api/ai/test", testAi],
  ["POST", "/api/chapters/:id/check", checkChapterHandler],
  ["POST", "/api/chapters/:id/draft-entry", draftBibleEntryHandler],
  ["POST", "/api/projects/:id/check-book", checkBook],
  ["GET", "/api/projects/:id/check-book", lastBookCheck],
  ["GET", "/api/projects/:id/bible", listBible],
  ["GET", "/api/projects/:id/scenes", listScenes],
  ["PUT", "/api/projects/:id/scenes/order", reorderScenes],
  ["POST", "/api/chapters/:id/scenes", createScene],
  ["PATCH", "/api/scenes/:id", updateScene],
  ["DELETE", "/api/scenes/:id", deleteScene],
  ["POST", "/api/projects/:id/bible", createEntry],
  ["PATCH", "/api/bible/:id", updateEntry],
  ["DELETE", "/api/bible/:id", deleteEntry],
  ["PUT", "/api/goal", setGoal],
  ["PUT", "/api/projects/:id/target", setTarget],
  ["PUT", "/api/projects/:id/dialect", setDialect],
  ["GET", "/api/trash/projects", listDeletedProjects],
  ["POST", "/api/projects/:id/restore", restoreProject],
  ["GET", "/api/projects/:id/trash", listDeletedChapters],
  ["POST", "/api/chapters/:id/restore", restoreChapter],
  ["POST", "/api/projects", createProject],
  ["GET", "/api/projects/:id", getProject],
  ["PATCH", "/api/projects/:id", updateProject],
  ["DELETE", "/api/projects/:id", deleteProject],
  ["POST", "/api/projects/:id/chapters", createChapter],
  ["PUT", "/api/projects/:id/order", reorderChapters],
  ["GET", "/api/chapters/:id", getChapter],
  ["PUT", "/api/chapters/:id", saveChapter],
  ["PATCH", "/api/chapters/:id", updateChapter],
  ["DELETE", "/api/chapters/:id", deleteChapter],
  ["GET", "/api/chapters/:id/history", listHistory],
  ["GET", "/api/chapters/:id/history/:snapshotId", getSnapshot],
];

const compiled = routes.map(([method, path, handler]) => {
  const names: string[] = [];
  const pattern = path.replace(/:(\w+)/g, (_, n) => {
    names.push(n);
    return "([^/]+)";
  });
  return { method, re: new RegExp(`^${pattern}$`), names, handler };
});

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(req);

    try {
      await authorize(req, env);
      for (const r of compiled) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params: Params = {};
        r.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
        return await r.handler(req, env, params);
      }
      return json({ error: "Not found" }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
      if (e instanceof AiError) return json({ error: e.message, code: e.code }, e.status);
      console.error(e);
      return json({ error: "Server error" }, 500);
    }
  },
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      createBackup(env).catch((e) => {
        console.error("scheduled backup failed", e);
        throw e;
      }),
    );
  },
} satisfies ExportedHandler<Env>;
