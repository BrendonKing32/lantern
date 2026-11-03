import { createRemoteJWKSet, jwtVerify } from "jose";
import { countWords } from "../shared/wordcount";
import type { ChapterMeta } from "../shared/types";

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  DEV_BYPASS?: string;
}

const MAX_CHAPTER_BYTES = 5 * 1024 * 1024;
const CHAPTER_COLS =
  "id, project_id, title, synopsis, position, word_count, version, updated_at";

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

async function requireProject(env: Env, id: string) {
  const row = await env.DB.prepare("SELECT id, title, created_at, updated_at FROM projects WHERE id = ? AND deleted_at IS NULL")
    .bind(id)
    .first<{ id: string; title: string; created_at: string; updated_at: string }>();
  if (!row) throw new HttpError(404, "Project not found");
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
  await env.BUCKET.put(chapterKey(projectId, id), "", {
    httpMetadata: { contentType: "text/markdown; charset=utf-8" },
  });
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

// ---------- handlers ----------

type Params = Record<string, string>;
type Handler = (req: Request, env: Env, p: Params) => Promise<Response>;

const listProjects: Handler = async (_req, env) => {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.title, p.created_at, p.updated_at, p.archived_at,
            COUNT(c.id) AS chapter_count, COALESCE(SUM(c.word_count), 0) AS word_count
       FROM projects p
       LEFT JOIN chapters c ON c.project_id = p.id AND c.deleted_at IS NULL
      WHERE p.deleted_at IS NULL
      GROUP BY p.id
      ORDER BY p.updated_at DESC`,
  ).all();
  return json(results);
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

const deleteProject: Handler = async (_req, env, p) => {
  await requireProject(env, p.id);
  await env.DB.prepare("UPDATE projects SET deleted_at = ? WHERE id = ?").bind(now(), p.id).run();
  return json({ ok: true });
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

const getChapter: Handler = async (_req, env, p) => {
  const row = await getChapterRow(env, p.id);
  const obj = await env.BUCKET.get(chapterKey(row.project_id, row.id));
  const content = obj ? await obj.text() : "";
  return json({ ...row, content });
};

const saveChapter: Handler = async (req, env, p) => {
  const b = await body<{ content?: unknown; baseVersion?: unknown }>(req);
  if (typeof b.content !== "string") throw new HttpError(400, "content must be a string");
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

  try {
    await env.BUCKET.put(chapterKey(row.project_id, row.id), b.content, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
  } catch (e) {
    // Roll the version back so the client's next attempt still lines up.
    await env.DB.prepare(
      "UPDATE chapters SET version = ?, word_count = ? WHERE id = ? AND version = ?",
    )
      .bind(b.baseVersion, row.word_count, row.id, b.baseVersion + 1)
      .run();
    throw e;
  }
  await env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(ts, row.project_id).run();

  return json({ version: b.baseVersion + 1, word_count: words, updated_at: ts });
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

// ---------- router ----------

const routes: Array<[string, string, Handler]> = [
  ["GET", "/api/projects", listProjects],
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
      console.error(e);
      return json({ error: "Server error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
