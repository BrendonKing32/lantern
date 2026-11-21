import type { ShareComment } from "../../shared/types";
import { chapterKey, requireProject } from "../db";
import type { Env } from "../env";
import { body, HttpError, json, newId, now, type Handler } from "../http";

async function shareTokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function findActiveShare(env: Env, token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new HttpError(404, "Review link not found");
  const hash = await shareTokenHash(token);
  const share = await env.DB.prepare(
    `SELECT id, project_id FROM project_shares
      WHERE token_hash = ? AND revoked_at IS NULL`,
  )
    .bind(hash)
    .first<{ id: string; project_id: string }>();
  if (!share) throw new HttpError(404, "Review link not found");
  return share;
}

export const getShareStatus: Handler = async (_req, env, p, email = "") => {
  await requireProject(env, p.id);
  if (!email || email === "unknown") throw new HttpError(403, "A verified email is required to manage review links");
  const share = await env.DB.prepare(
    `SELECT created_at FROM project_shares
      WHERE project_id = ? AND owner_email = ? AND revoked_at IS NULL`,
  )
    .bind(p.id, email)
    .first<{ created_at: string }>();
  if (share) return json({ active: true, created_at: share.created_at });
  const otherOwner = await env.DB.prepare(
    "SELECT id FROM project_shares WHERE project_id = ? AND revoked_at IS NULL",
  )
    .bind(p.id)
    .first<{ id: string }>();
  if (otherOwner) throw new HttpError(403, "Only the person who created this review link can manage it");
  return json({ active: false, created_at: null });
};

export const createShare: Handler = async (_req, env, p, email = "") => {
  await requireProject(env, p.id);
  if (!email || email === "unknown") throw new HttpError(403, "A verified email is required to create a review link");
  const active = await env.DB.prepare(
    "SELECT owner_email FROM project_shares WHERE project_id = ? AND revoked_at IS NULL",
  )
    .bind(p.id)
    .first<{ owner_email: string }>();
  if (active) {
    if (active.owner_email !== email) throw new HttpError(403, "Only the person who created this review link can manage it");
    throw new HttpError(409, "A review link is already active. Revoke it before creating another.");
  }
  const id = newId();
  const token = `${newId().replaceAll("-", "")}${newId().replaceAll("-", "")}`;
  const createdAt = now();
  await env.DB.prepare(
    "INSERT INTO project_shares (id, project_id, owner_email, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, p.id, email, await shareTokenHash(token), createdAt)
    .run();
  return json({ active: true, token, created_at: createdAt }, 201);
};

export const revokeShare: Handler = async (_req, env, p, email = "") => {
  await requireProject(env, p.id);
  if (!email || email === "unknown") throw new HttpError(403, "A verified email is required to revoke a review link");
  const share = await env.DB.prepare(
    "SELECT id FROM project_shares WHERE project_id = ? AND owner_email = ? AND revoked_at IS NULL",
  )
    .bind(p.id, email)
    .first<{ id: string }>();
  if (!share) {
    const otherOwner = await env.DB.prepare(
      "SELECT id FROM project_shares WHERE project_id = ? AND revoked_at IS NULL",
    )
      .bind(p.id)
      .first<{ id: string }>();
    if (otherOwner) throw new HttpError(403, "Only the person who created this review link can manage it");
    return json({ ok: true });
  }
  await env.DB.prepare("UPDATE project_shares SET revoked_at = ? WHERE id = ?")
    .bind(now(), share.id)
    .run();
  return json({ ok: true });
};

export const listShareComments: Handler = async (_req, env, p, email = "") => {
  await requireProject(env, p.id);
  if (!email || email === "unknown") throw new HttpError(403, "A verified email is required to read feedback");
  const { results } = await env.DB.prepare(
    `SELECT comments.id, comments.chapter_id, chapters.title AS chapter_title,
            comments.display_name, comments.body, comments.created_at
       FROM share_comments AS comments
       JOIN project_shares AS shares ON shares.id = comments.share_id
       JOIN chapters ON chapters.id = comments.chapter_id
      WHERE shares.project_id = ? AND shares.owner_email = ?
      ORDER BY comments.created_at DESC LIMIT 500`,
  )
    .bind(p.id, email)
    .all<ShareComment>();
  return json(results);
};

export const deleteShareComment: Handler = async (_req, env, p, email = "") => {
  if (!email || email === "unknown") throw new HttpError(403, "A verified email is required to delete feedback");
  const result = await env.DB.prepare(
    `DELETE FROM share_comments WHERE id = ? AND share_id IN (
       SELECT id FROM project_shares WHERE project_id = ? AND owner_email = ?
     )`,
  )
    .bind(p.commentId, p.id, email)
    .run();
  if (!result.meta.changes) throw new HttpError(404, "Feedback not found");
  return json({ ok: true });
};

export const getSharedProject: Handler = async (_req, env, p) => {
  const share = await findActiveShare(env, p.token);
  const project = await env.DB.prepare(
    "SELECT title FROM projects WHERE id = ? AND deleted_at IS NULL",
  )
    .bind(share.project_id)
    .first<{ title: string }>();
  if (!project) throw new HttpError(404, "Review link not found");
  const { results } = await env.DB.prepare(
    `SELECT id, title, word_count FROM chapters
      WHERE project_id = ? AND deleted_at IS NULL ORDER BY position`,
  )
    .bind(share.project_id)
    .all<{ id: string; title: string; word_count: number }>();
  return json({ project, chapters: results });
};

export const getSharedChapter: Handler = async (_req, env, p) => {
  const share = await findActiveShare(env, p.token);
  const chapter = await env.DB.prepare(
    `SELECT id, title FROM chapters
      WHERE id = ? AND project_id = ? AND deleted_at IS NULL
        AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)`,
  )
    .bind(p.chapterId, share.project_id)
    .first<{ id: string; title: string }>();
  if (!chapter) throw new HttpError(404, "Chapter not found");
  const obj = await env.BUCKET.get(chapterKey(share.project_id, chapter.id));
  return json({ ...chapter, content: obj ? await obj.text() : "" });
};

export const createShareComment: Handler = async (req, env, p) => {
  const share = await findActiveShare(env, p.token);
  const b = await body<{ chapterId?: unknown; displayName?: unknown; body?: unknown }>(req);
  if (typeof b.chapterId !== "string" || typeof b.body !== "string") {
    throw new HttpError(400, "chapterId and comment body are required");
  }
  const comment = b.body.trim();
  if (!comment || comment.length > 5000) throw new HttpError(400, "Comments must be between 1 and 5,000 characters");
  if (b.displayName !== undefined && typeof b.displayName !== "string") {
    throw new HttpError(400, "displayName must be text");
  }
  const displayName = typeof b.displayName === "string" ? b.displayName.trim().slice(0, 80) : "";
  const chapter = await env.DB.prepare(
    `SELECT id FROM chapters
      WHERE id = ? AND project_id = ? AND deleted_at IS NULL
        AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)`,
  )
    .bind(b.chapterId, share.project_id)
    .first<{ id: string }>();
  if (!chapter) throw new HttpError(404, "Chapter not found");
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const count = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM share_comments WHERE share_id = ? AND created_at >= ?",
  )
    .bind(share.id, since)
    .first<{ count: number }>();
  if ((count?.count ?? 0) >= 50) throw new HttpError(429, "This review link has received a lot of comments. Try again later.");
  await env.DB.prepare(
    "INSERT INTO share_comments (id, share_id, chapter_id, display_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(newId(), share.id, chapter.id, displayName, comment, now())
    .run();
  return json({ ok: true }, 201);
};
