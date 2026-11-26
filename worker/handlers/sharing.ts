import { chapterKey, milestoneKey, requireProject } from "../db";
import type { Env } from "../env";
import { body, HttpError, json, newId, now, type Handler } from "../http";

const ownerError = "Only the person who created this review link can manage it";
const missingChapter = "This chapter is no longer in the book. Your other feedback still reaches the author.";
type Link = { id: string; project_id: string; owner_email: string; milestone_id: string | null };

async function shareTokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function verified(email: string) {
  if (!email || email === "unknown") throw new HttpError(403, "A verified email is required to manage review links");
}

function labelValue(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 80) {
    throw new HttpError(400, "Give the review link a label of 80 characters or fewer.");
  }
  return value.trim();
}

function progressValue(value: unknown): number {
  if (typeof value !== "boolean") throw new HttpError(400, "The progress setting must be on or off.");
  return value ? 1 : 0;
}

async function findActiveShare(env: Env, token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new HttpError(404, "Review link not found");
  const share = await env.DB.prepare(
    `SELECT id, project_id, milestone_id, label FROM project_shares
      WHERE token_hash = ? AND revoked_at IS NULL`,
  ).bind(await shareTokenHash(token)).first<{ id: string; project_id: string; milestone_id: string | null; label: string }>();
  if (!share) throw new HttpError(404, "Review link not found");
  return share;
}

async function ownedShare(env: Env, id: string, email: string): Promise<Link> {
  verified(email);
  const share = await env.DB.prepare(
    `SELECT id, project_id, owner_email, milestone_id FROM project_shares
     WHERE id = ? AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)`,
  ).bind(id).first<Link>();
  if (!share) throw new HttpError(404, "Review link not found");
  if (share.owner_email !== email) throw new HttpError(403, ownerError);
  return share;
}

const linkSelect = `SELECT shares.id, shares.label, shares.milestone_id, milestones.name AS milestone_name,
  shares.track_progress, shares.created_at,
  (SELECT COUNT(*) FROM share_comments WHERE share_id = shares.id) AS feedback_count
  FROM project_shares AS shares LEFT JOIN milestones ON milestones.id = shares.milestone_id`;

export const listShares: Handler = async (_req, env, p, email = "") => {
  await requireProject(env, p.id);
  verified(email);
  const { results } = await env.DB.prepare(`${linkSelect}
    WHERE shares.project_id = ? AND shares.revoked_at IS NULL
    ORDER BY shares.created_at, shares.rowid`).bind(p.id).all();
  return json(results);
};

export const createShare: Handler = async (req, env, p, email = "") => {
  await requireProject(env, p.id);
  verified(email);
  const input = await body<{ label?: unknown; milestoneId?: unknown; trackProgress?: unknown }>(req);
  const label = labelValue(input.label);
  const track = input.trackProgress === undefined ? 1 : progressValue(input.trackProgress);
  if (input.milestoneId !== undefined && (typeof input.milestoneId !== "string" || !input.milestoneId)) {
    throw new HttpError(400, "Choose a milestone in this novel.");
  }
  const milestoneId = (input.milestoneId as string | undefined) ?? null;
  const id = newId();
  const token = `${newId().replaceAll("-", "")}${newId().replaceAll("-", "")}`;
  const createdAt = now();
  // The cap and milestone check are part of the insert so concurrent requests cannot bypass them.
  const result = await env.DB.prepare(
    `INSERT INTO project_shares (id, project_id, owner_email, token_hash, created_at, label, milestone_id, track_progress)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM project_shares WHERE project_id = ? AND revoked_at IS NULL) < 20
       AND (? IS NULL OR EXISTS (SELECT 1 FROM milestones WHERE id = ? AND project_id = ? AND complete = 1))`,
  ).bind(id, p.id, email, await shareTokenHash(token), createdAt, label, milestoneId, track,
    p.id, milestoneId, milestoneId, p.id).run();
  if (!result.meta.changes) {
    if (milestoneId) {
      const milestone = await env.DB.prepare("SELECT id FROM milestones WHERE id = ? AND project_id = ? AND complete = 1")
        .bind(milestoneId, p.id).first();
      if (!milestone) throw new HttpError(400, "Choose a milestone in this novel.");
    }
    throw new HttpError(409, "Revoke a link before creating another.");
  }
  const link = await env.DB.prepare(`${linkSelect} WHERE shares.id = ?`).bind(id).first();
  return json({ ...link, token }, 201);
};

export const updateShare: Handler = async (req, env, p, email = "") => {
  await ownedShare(env, p.id, email);
  const input = await body<{ label?: unknown; trackProgress?: unknown; milestoneId?: unknown }>(req);
  if (input.milestoneId !== undefined) throw new HttpError(400, "Create a new link to share a different milestone.");
  const label = input.label === undefined ? null : labelValue(input.label);
  const track = input.trackProgress === undefined ? null : progressValue(input.trackProgress);
  const result = await env.DB.prepare(
    "UPDATE project_shares SET label = COALESCE(?, label), track_progress = COALESCE(?, track_progress) WHERE id = ? AND revoked_at IS NULL",
  ).bind(label, track, p.id).run();
  if (!result.meta.changes) throw new HttpError(404, "Review link not found");
  return json(await env.DB.prepare(`${linkSelect} WHERE shares.id = ?`).bind(p.id).first());
};

export const revokeShare: Handler = async (_req, env, p, email = "") => {
  await ownedShare(env, p.id, email);
  await env.DB.prepare("UPDATE project_shares SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").bind(now(), p.id).run();
  return json({ ok: true });
};

export const listShareComments: Handler = async (req, env, p, email = "") => {
  await requireProject(env, p.id);
  verified(email);
  const shareId = new URL(req.url).searchParams.get("shareId");
  if (shareId) {
    const share = await ownedShare(env, shareId, email);
    if (share.project_id !== p.id) throw new HttpError(404, "Review link not found");
  }
  const { results } = await env.DB.prepare(
    `SELECT comments.id, comments.chapter_id, chapters.title AS chapter_title,
            comments.display_name, comments.body, comments.created_at,
            shares.id AS share_id, shares.label AS share_label
       FROM share_comments AS comments
       JOIN project_shares AS shares ON shares.id = comments.share_id
       JOIN chapters ON chapters.id = comments.chapter_id
      WHERE shares.project_id = ? AND shares.owner_email = ? AND (? IS NULL OR shares.id = ?)
      ORDER BY comments.created_at DESC, comments.rowid DESC`,
  ).bind(p.id, email, shareId, shareId).all();
  return json(results);
};

export const deleteShareComment: Handler = async (_req, env, p, email = "") => {
  verified(email);
  const comment = await env.DB.prepare(
    `SELECT shares.id, shares.project_id, shares.owner_email, shares.milestone_id
     FROM share_comments AS comments JOIN project_shares AS shares ON shares.id = comments.share_id
     WHERE comments.id = ? AND shares.project_id = ?`,
  ).bind(p.commentId, p.id).first<Link>();
  if (!comment) throw new HttpError(404, "Feedback not found");
  if (comment.owner_email !== email) throw new HttpError(403, ownerError);
  await env.DB.prepare("DELETE FROM share_comments WHERE id = ?").bind(p.commentId).run();
  return json({ ok: true });
};

export const getSharedProject: Handler = async (_req, env, p) => {
  const share = await findActiveShare(env, p.token);
  const project = await env.DB.prepare("SELECT title FROM projects WHERE id = ? AND deleted_at IS NULL")
    .bind(share.project_id).first<{ title: string }>();
  if (!project) throw new HttpError(404, "Review link not found");
  const query = share.milestone_id
    ? "SELECT chapter_id AS id, title, word_count FROM milestone_chapters WHERE milestone_id = ? ORDER BY position"
    : "SELECT id, title, word_count FROM chapters WHERE project_id = ? AND deleted_at IS NULL ORDER BY position";
  const { results } = await env.DB.prepare(query).bind(share.milestone_id ?? share.project_id).all();
  return json({ project, label: share.label ?? "", chapters: results });
};

export const getSharedChapter: Handler = async (_req, env, p) => {
  const share = await findActiveShare(env, p.token);
  const project = await env.DB.prepare("SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL").bind(share.project_id).first();
  if (!project) throw new HttpError(404, "Review link not found");
  const chapter = share.milestone_id
    ? await env.DB.prepare("SELECT chapter_id AS id, title FROM milestone_chapters WHERE milestone_id = ? AND chapter_id = ?")
      .bind(share.milestone_id, p.chapterId).first<{ id: string; title: string }>()
    : await env.DB.prepare("SELECT id, title FROM chapters WHERE id = ? AND project_id = ? AND deleted_at IS NULL")
      .bind(p.chapterId, share.project_id).first<{ id: string; title: string }>();
  if (!chapter) throw new HttpError(404, "Chapter not found");
  const key = share.milestone_id ? milestoneKey(share.project_id, share.milestone_id, chapter.id) : chapterKey(share.project_id, chapter.id);
  const obj = await env.BUCKET.get(key);
  if (!obj && share.milestone_id) throw new HttpError(404, "Milestone chapter text not found");
  return json({ ...chapter, content: obj ? await obj.text() : "" });
};

export const createShareComment: Handler = async (req, env, p) => {
  const share = await findActiveShare(env, p.token);
  const b = await body<{ chapterId?: unknown; displayName?: unknown; body?: unknown }>(req);
  if (typeof b.chapterId !== "string" || typeof b.body !== "string") throw new HttpError(400, "chapterId and comment body are required");
  const comment = b.body.trim();
  if (!comment || comment.length > 5000) throw new HttpError(400, "Comments must be between 1 and 5,000 characters");
  if (b.displayName !== undefined && typeof b.displayName !== "string") throw new HttpError(400, "displayName must be text");
  const displayName = typeof b.displayName === "string" ? b.displayName.trim().slice(0, 80) : "";
  const chapter = await env.DB.prepare(
    `SELECT id FROM chapters WHERE id = ? AND project_id = ? AND deleted_at IS NULL
     AND project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)
     AND (? IS NULL OR EXISTS (SELECT 1 FROM milestone_chapters WHERE milestone_id = ? AND chapter_id = chapters.id))`,
  ).bind(b.chapterId, share.project_id, share.milestone_id, share.milestone_id).first<{ id: string }>();
  if (!chapter) throw new HttpError(404, share.milestone_id ? missingChapter : "Chapter not found");
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM share_comments WHERE share_id = ? AND created_at >= ?")
    .bind(share.id, since).first<{ count: number }>();
  if ((count?.count ?? 0) >= 50) throw new HttpError(429, "This review link has received a lot of comments. Try again later.");
  await env.DB.prepare("INSERT INTO share_comments (id, share_id, chapter_id, display_name, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(newId(), share.id, chapter.id, displayName, comment, now()).run();
  return json({ ok: true }, 201);
};
