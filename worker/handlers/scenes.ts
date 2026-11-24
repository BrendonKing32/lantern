import { arrangeText, insertPassage, matchScenes, normalizeAnchor, normalizeText, splitScenes, takePassage } from "../../shared/scenes";
import type { SceneMeta, ScenePlaceholder } from "../../shared/types";
import { countWords } from "../../shared/wordcount";
import { assertChapterUnlocked, chapterKey, chapterMoveToken, chapterPut, chapterTextVersion, getChapterRow, MAX_CHAPTER_BYTES, MOVE_LOCK_MS, reconcileChapter, requireProject } from "../db";
import type { Env } from "../env";
import { body, cleanTitle, HttpError, json, newId, now, type Handler } from "../http";
import { afterChapterWrite, matchCards, type SceneSyncRow } from "../sceneSync";
import { writeChapter } from "./chapters";
import { snapshotBeforeSave } from "./history";

// Scene cards belong to a novel. A chapter is optional: a scene with no
// chapter is "unassigned" and can be placed in (or taken out of) a chapter
// later. Positions count within a scene's group (one chapter, or the
// unassigned scenes).

const SCENE_COLS =
  "id, project_id, chapter_id, title, summary, pov, location, status, position, created_at, updated_at, in_text, anchor_head, anchor_tail, word_count, unlinked_at, unconfirmed";

type SceneRow = Omit<SceneMeta, "in_text" | "unconfirmed" | "excerpt" | "passage_index" | "merged_into"> &
  Omit<SceneSyncRow, "chapter_id"> & { chapter_id: string | null };

function sceneMeta(row: SceneRow, passage?: { index: number; excerpt: string }, mergedInto: string | null = null): SceneMeta {
  const { anchor_head: _head, anchor_tail: _tail, ...scene } = row;
  return { ...scene, in_text: !!row.in_text, unconfirmed: !!row.unconfirmed,
    excerpt: passage?.excerpt ?? "", passage_index: passage?.index ?? null, merged_into: mergedInto };
}

// A scene is visible while its novel is, and, when it has a chapter, while
// that chapter is. Scenes of a deleted chapter come back if it's restored.
const VISIBLE = `project_id IN (SELECT id FROM projects WHERE deleted_at IS NULL)
  AND (chapter_id IS NULL OR chapter_id IN (SELECT id FROM chapters WHERE deleted_at IS NULL))`;

async function getSceneRow(env: Env, id: string): Promise<SceneRow> {
  const row = await env.DB.prepare(`SELECT ${SCENE_COLS} FROM scenes WHERE id = ? AND ${VISIBLE}`)
    .bind(id)
    .first<SceneRow>();
  if (!row) throw new HttpError(404, "Scene not found");
  return row;
}

async function nextPosition(env: Env, projectId: string, chapterId: string | null): Promise<number> {
  const max = chapterId === null
    ? await env.DB.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM scenes WHERE project_id = ? AND chapter_id IS NULL")
      .bind(projectId)
      .first<{ m: number }>()
    : await env.DB.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM scenes WHERE chapter_id = ?")
      .bind(chapterId)
      .first<{ m: number }>();
  return (max?.m ?? -1) + 1;
}

/** Check a chapter id from a request belongs to the novel; null means no chapter. */
async function chapterIn(env: Env, projectId: string, chapterId: unknown): Promise<string | null> {
  if (chapterId === null) return null;
  if (typeof chapterId !== "string") throw new HttpError(400, "chapterId must be a chapter id or null");
  const chapter = await getChapterRow(env, chapterId);
  if (chapter.project_id !== projectId) throw new HttpError(404, "Chapter not found");
  return chapter.id;
}

export const listScenes: Handler = async (_req, env, p) => {
  await requireProject(env, p.id);
  const chapterIds = await env.DB.prepare(
    "SELECT id, scenes_version, version, moving_until FROM chapters WHERE project_id = ? AND deleted_at IS NULL ORDER BY position",
  ).bind(p.id).all<{ id: string; scenes_version: number; version: number; moving_until: string | null }>();
  const chapters = await Promise.all(chapterIds.results.map(async (state) => {
    const chapter = await getChapterRow(env, state.id);
    const object = await env.BUCKET.get(chapterKey(p.id, state.id));
    const text = object ? await object.text() : "";
    const textVersion = chapterTextVersion(object, chapter.version);
    const locked = !!state.moving_until && state.moving_until > now();
    if (!locked && state.scenes_version < chapter.version && textVersion !== null) await afterChapterWrite(env, chapter, text, textVersion);
    return { chapter, text: normalizeText(text), textVersion, passages: splitScenes(text, chapter.title), stale: state.scenes_version < chapter.version, locked };
  }));
  if (chapters.some((chapter) => chapter.stale)) {
    for (const { chapter, text, textVersion, locked } of chapters) {
      if (!locked && textVersion !== null) await afterChapterWrite(env, chapter, text, textVersion);
    }
  }
  const { results } = await env.DB.prepare(
    `SELECT ${SCENE_COLS} FROM scenes
      WHERE project_id = ? AND ${VISIBLE}
      ORDER BY chapter_id IS NOT NULL,
        (SELECT position FROM chapters WHERE chapters.id = scenes.chapter_id), position`,
  )
    .bind(p.id)
    .all<SceneRow>();
  const passagesByScene = new Map<string, { index: number; excerpt: string }>();
  const mergedInto = new Map<string, string>();
  const placeholders: ScenePlaceholder[] = [];
  for (const { chapter, text, passages } of chapters) {
    const cards = results.filter((row) => row.chapter_id === chapter.id);
    const matched = matchScenes(passages, matchCards(cards as SceneSyncRow[]));
    for (const [id, index] of matched.pairs) passagesByScene.set(id, passages[index]);
    for (const row of cards) {
      if (row.in_text || !row.unlinked_at || Date.now() - Date.parse(row.unlinked_at) >= 86400000) continue;
      const previous = cards.filter((card) => card.position < row.position && matched.pairs.has(card.id))
        .sort((a, b) => b.position - a.position)[0];
      if (!previous) continue;
      const passage = passages[matched.pairs.get(previous.id)!];
      const prose = normalizeAnchor(text.slice(passage.start, passage.end));
      if ((row.anchor_head && prose.includes(row.anchor_head)) || (row.anchor_tail && prose.includes(row.anchor_tail))) {
        mergedInto.set(row.id, previous.title);
      }
    }
    for (const index of matched.placeholders) {
      placeholders.push({ chapter_id: chapter.id, passage_index: index, words: passages[index].words, excerpt: passages[index].excerpt });
    }
  }
  return json({ scenes: results.map((row) => sceneMeta(row, passagesByScene.get(row.id), mergedInto.get(row.id))), placeholders });
};

async function insertScene(env: Env, projectId: string, chapterId: string | null): Promise<SceneMeta> {
  if (chapterId) await assertChapterUnlocked(env, chapterId);
  const ts = now();
  const scene: SceneMeta = {
    id: newId(),
    project_id: projectId,
    chapter_id: chapterId,
    title: "New scene",
    summary: "",
    pov: "",
    location: "",
    status: "planned",
    position: await nextPosition(env, projectId, chapterId),
    in_text: false,
    word_count: 0,
    excerpt: "",
    passage_index: null,
    unconfirmed: false,
    unlinked_at: null,
    merged_into: null,
    created_at: ts,
    updated_at: ts,
  };
  const result = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO scenes (id, project_id, chapter_id, title, summary, pov, location, status, position, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ? IS NULL OR EXISTS (SELECT 1 FROM chapters WHERE id = ? AND deleted_at IS NULL
         AND (moving_until IS NULL OR moving_until <= ?))`,
    ).bind(
      scene.id, scene.project_id, scene.chapter_id, scene.title, scene.summary, scene.pov,
      scene.location, scene.status, scene.position, scene.created_at, scene.updated_at, chapterId, chapterId, ts,
    ),
    env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(ts, scene.project_id),
  ]);
  if (!result[0].meta.changes && chapterId) {
    await assertChapterUnlocked(env, chapterId);
    throw new HttpError(409, sceneListError);
  }
  return scene;
}

/** POST /api/projects/:id/scenes — a new scene, unassigned unless the body names a chapterId. */
export const createProjectScene: Handler = async (req, env, p) => {
  await requireProject(env, p.id);
  // The body is optional: no body makes an unassigned scene.
  const b = ((await body<{ chapterId?: unknown } | null>(req).catch(() => null)) ?? {}) as { chapterId?: unknown };
  const chapterId = b.chapterId === undefined ? null : await chapterIn(env, p.id, b.chapterId);
  return json(await insertScene(env, p.id, chapterId), 201);
};

/** POST /api/chapters/:id/scenes — a new scene at the end of that chapter. */
export const createScene: Handler = async (_req, env, p) => {
  const chapter = await getChapterRow(env, p.id);
  return json(await insertScene(env, chapter.project_id, chapter.id), 201);
};

export const updateScene: Handler = async (req, env, p) => {
  const scene = await getSceneRow(env, p.id);
  const b = await body<{
    title?: unknown; summary?: unknown; pov?: unknown; location?: unknown; status?: unknown; chapter_id?: unknown;
    link?: unknown; unlink?: unknown; confirm?: unknown;
  }>(req);
  for (const field of ["title", "summary", "pov", "location"] as const) {
    if (b[field] !== undefined && typeof b[field] !== "string") {
      throw new HttpError(400, `${field} must be a string`);
    }
  }
  if (b.status !== undefined && b.status !== "planned" && b.status !== "drafted") {
    throw new HttpError(400, "status must be planned or drafted");
  }
  const chapterId = b.chapter_id === undefined ? scene.chapter_id : await chapterIn(env, scene.project_id, b.chapter_id);
  await Promise.all([...new Set([scene.chapter_id, chapterId].filter((id): id is string => id !== null))]
    .map((id) => assertChapterUnlocked(env, id)));
  const moved = chapterId !== scene.chapter_id;
  if (moved && scene.in_text) throw new HttpError(400, "Move scenes that are in the text with the move action");
  if (b.unlink !== undefined && b.unlink !== true) throw new HttpError(400, "unlink must be true");
  if (b.confirm !== undefined && b.confirm !== true) throw new HttpError(400, "confirm must be true");
  if ([b.link !== undefined, b.unlink === true, b.confirm === true].filter(Boolean).length > 1) {
    throw new HttpError(400, "Choose one scene action");
  }
  let linkedPassage: ReturnType<typeof splitScenes>[number] | undefined;
  let positions: D1PreparedStatement[] = [];
  let linkVersion: number | undefined;
  let linkSnapshot = "";
  if (b.link !== undefined) {
    if (scene.in_text || !chapterId || moved || typeof b.link !== "object" || b.link === null ||
      !Number.isInteger((b.link as { passage_index?: unknown }).passage_index)) {
      throw new HttpError(400, "Choose a planned card and a passage in its chapter");
    }
    const chapter = await getChapterRow(env, chapterId);
    const object = await env.BUCKET.get(chapterKey(scene.project_id, chapterId));
    const text = object ? await object.text() : "";
    const textVersion = chapterTextVersion(object, chapter.version);
    if (textVersion !== chapter.version) throw new HttpError(409, "Chapter is changing; reload and try again");
    const state = await env.DB.prepare("SELECT scenes_version FROM chapters WHERE id = ?")
      .bind(chapter.id).first<{ scenes_version: number }>();
    if (state && state.scenes_version < chapter.version) await afterChapterWrite(env, chapter, text, textVersion);
    const passages = splitScenes(text, chapter.title);
    const rows = await env.DB.prepare(`SELECT ${SCENE_COLS} FROM scenes WHERE chapter_id = ? ORDER BY position`)
      .bind(chapterId).all<SceneRow>();
    if (rows.results.find((row) => row.id === scene.id)?.in_text) throw new HttpError(409, "That card is already in the text");
    const match = matchScenes(passages, matchCards(rows.results as SceneSyncRow[]));
    const index = (b.link as { passage_index: number }).passage_index;
    if (!passages[index]) throw new HttpError(400, "Passage not found");
    if (!match.placeholders.includes(index)) throw new HttpError(409, "That passage already has a card");
    linkedPassage = passages[index];
    linkVersion = chapter.version;
    linkSnapshot = JSON.stringify([...rows.results].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      .map((row) => [row.id, row.position, row.in_text, row.anchor_head, row.anchor_tail]));
    const next = [...match.pairs.entries()].filter(([, i]) => i > index).sort((a, b) => a[1] - b[1])[0];
    const reordered = rows.results.filter((row) => row.id !== scene.id);
    const insertAt = next ? reordered.findIndex((row) => row.id === next[0]) : reordered.length;
    reordered.splice(insertAt, 0, scene);
    positions = reordered.map((row, i) => env.DB.prepare(
      `UPDATE scenes SET position = ? WHERE id = ? AND chapter_id = ? AND EXISTS
       (SELECT 1 FROM scenes WHERE id = ? AND chapter_id = ? AND in_text = 1 AND anchor_head = ? AND anchor_tail = ?)
       AND EXISTS (SELECT 1 FROM chapters WHERE id = ? AND (moving_until IS NULL OR moving_until <= ?))`,
    ).bind(i, row.id, chapterId, scene.id, chapterId, linkedPassage!.head, linkedPassage!.tail, chapterId, now()));
    scene.position = insertAt;
  }
  if (b.unlink && !scene.in_text) throw new HttpError(400, "This card is not in the text");
  const updated: SceneMeta = {
    ...sceneMeta(scene, linkedPassage),
    title: b.title === undefined ? scene.title : cleanTitle(b.title, scene.title),
    summary: typeof b.summary === "string" ? b.summary.slice(0, 2000) : scene.summary,
    pov: typeof b.pov === "string" ? b.pov.slice(0, 120) : scene.pov,
    location: typeof b.location === "string" ? b.location.slice(0, 120) : scene.location,
    chapter_id: chapterId,
    // A scene placed in another chapter (or unassigned) goes to the end of its new group.
    position: moved ? await nextPosition(env, scene.project_id, chapterId) : scene.position,
    updated_at: now(),
    in_text: linkedPassage ? true : b.unlink ? false : !!scene.in_text,
    word_count: linkedPassage ? linkedPassage.words : b.unlink ? 0 : scene.word_count,
    unlinked_at: linkedPassage || b.unlink ? null : scene.unlinked_at,
    unconfirmed: linkedPassage || b.confirm || b.unlink ? false : !!scene.unconfirmed,
    status: linkedPassage && scene.status === "planned" ? "drafted" : b.status === undefined ? scene.status : b.status,
  };
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  const field = (name: string, value: string | number | null) => { fields.push(`${name} = ?`); values.push(value); };
  if (b.title !== undefined) field("title", updated.title);
  if (b.summary !== undefined) field("summary", updated.summary);
  if (b.pov !== undefined) field("pov", updated.pov);
  if (b.location !== undefined) field("location", updated.location);
  if (b.status !== undefined || linkedPassage) field("status", updated.status);
  if (moved) field("chapter_id", updated.chapter_id);
  if (moved || linkedPassage) field("position", updated.position);
  if (linkedPassage || b.unlink) {
    field("in_text", +updated.in_text);
    field("word_count", updated.word_count);
    field("unlinked_at", updated.unlinked_at);
    field("unconfirmed", +updated.unconfirmed);
    if (linkedPassage) {
      field("anchor_head", linkedPassage.head);
      field("anchor_tail", linkedPassage.tail);
    }
  } else if (b.confirm) field("unconfirmed", 0);
  field("updated_at", updated.updated_at);
  let guard = " AND chapter_id IS ? AND in_text = ?";
  const guardValues: (string | number | null)[] = [scene.chapter_id, scene.in_text];
  for (const id of new Set([scene.chapter_id, chapterId].filter((value): value is string => value !== null))) {
    guard += ` AND EXISTS (SELECT 1 FROM chapters WHERE id = ? AND deleted_at IS NULL
      AND (moving_until IS NULL OR moving_until <= ?))`;
    guardValues.push(id, now());
  }
  if (moved) { guard += " AND in_text = 0 AND chapter_id IS ?"; guardValues.push(scene.chapter_id); }
  if (linkedPassage) {
    guard += ` AND in_text = 0 AND chapter_id = ?
      AND EXISTS (SELECT 1 FROM chapters WHERE id = ? AND version = ?)
      AND (SELECT json_group_array(json_array(id, position, in_text, anchor_head, anchor_tail))
           FROM (SELECT id, position, in_text, anchor_head, anchor_tail FROM scenes WHERE chapter_id = ? ORDER BY id)) = ?`;
    guardValues.push(chapterId, chapterId, linkVersion!, chapterId, linkSnapshot);
  }
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE scenes SET ${fields.join(", ")} WHERE id = ?${guard}`).bind(...values, scene.id, ...guardValues),
    ...positions,
    env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(updated.updated_at, scene.project_id),
  ]);
  if (!result[0].meta.changes) {
    await Promise.all([...new Set([scene.chapter_id, chapterId].filter((id): id is string => id !== null))]
      .map((id) => assertChapterUnlocked(env, id)));
    if (moved) throw new HttpError(400, "Move scenes that are in the text with the move action");
    throw new HttpError(409, "Scene list is out of date; reload and try again");
  }
  const fresh = await getSceneRow(env, scene.id);
  if (fresh.in_text && fresh.chapter_id) {
    const chapter = await getChapterRow(env, fresh.chapter_id);
    const object = await env.BUCKET.get(chapterKey(fresh.project_id, chapter.id));
    const passages = splitScenes(object ? await object.text() : "", chapter.title);
    const rows = await env.DB.prepare(`SELECT ${SCENE_COLS} FROM scenes WHERE chapter_id = ? ORDER BY position`)
      .bind(chapter.id).all<SceneRow>();
    const index = matchScenes(passages, matchCards(rows.results as SceneSyncRow[])).pairs.get(fresh.id);
    return json(sceneMeta(fresh, index === undefined ? undefined : passages[index]));
  }
  return json(sceneMeta(fresh));
};

export const deleteScene: Handler = async (_req, env, p) => {
  const scene = await getSceneRow(env, p.id);
  if (scene.chapter_id) await assertChapterUnlocked(env, scene.chapter_id);
  const result = await env.DB.batch([
    env.DB.prepare(`DELETE FROM scenes WHERE id = ? AND chapter_id IS ? AND
      (chapter_id IS NULL OR EXISTS (SELECT 1 FROM chapters WHERE id = scenes.chapter_id
        AND (moving_until IS NULL OR moving_until <= ?)))`).bind(scene.id, scene.chapter_id, now()),
    env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(now(), scene.project_id),
  ]);
  if (!result[0].meta.changes) {
    if (scene.chapter_id) await assertChapterUnlocked(env, scene.chapter_id);
    throw new HttpError(409, sceneListError);
  }
  return json({ ok: true });
};

/** PUT /api/projects/:id/scenes/order — reorder one group; chapterId null means the unassigned scenes. */
export const reorderScenes: Handler = async (req, env, p) => {
  await requireProject(env, p.id);
  const b = await body<{ chapterId?: unknown; sceneIds?: unknown }>(req);
  if (b.chapterId === undefined || !Array.isArray(b.sceneIds) || !b.sceneIds.every((x) => typeof x === "string")) {
    throw new HttpError(400, "chapterId and sceneIds are required");
  }
  const chapterId = await chapterIn(env, p.id, b.chapterId);
  if (chapterId) await assertChapterUnlocked(env, chapterId);
  const { results } = await (chapterId === null
    ? env.DB.prepare("SELECT id FROM scenes WHERE project_id = ? AND chapter_id IS NULL").bind(p.id)
    : env.DB.prepare("SELECT id FROM scenes WHERE chapter_id = ?").bind(chapterId)
  ).all<{ id: string }>();
  const existing = new Set(results.map((r) => r.id));
  const ids = b.sceneIds as string[];
  if (ids.length !== existing.size || !ids.every((id) => existing.has(id)) || new Set(ids).size !== ids.length) {
    throw new HttpError(409, "Scene list is out of date; reload and try again");
  }
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE scenes SET position = (SELECT CAST(key AS INTEGER) FROM json_each(?) WHERE value = scenes.id)
      WHERE project_id = ? AND chapter_id IS ? AND id IN (SELECT value FROM json_each(?))
      AND (? IS NULL OR EXISTS (SELECT 1 FROM chapters WHERE id = ? AND (moving_until IS NULL OR moving_until <= ?)))
      AND (SELECT COUNT(*) FROM scenes WHERE project_id = ? AND chapter_id IS ?) = ?`)
      .bind(JSON.stringify(ids), p.id, chapterId, JSON.stringify(ids), chapterId, chapterId, now(), p.id, chapterId, ids.length),
    env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(now(), p.id),
  ]);
  if (result[0].meta.changes !== ids.length) {
    if (chapterId) await assertChapterUnlocked(env, chapterId);
    throw new HttpError(409, sceneListError);
  }
  return json({ ok: true });
};

const sceneListError = "Scene list is out of date; reload and try again";
const sceneSnapshot = (rows: SceneSyncRow[]) => JSON.stringify([...rows]
  .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  .map((row) => [row.id, row.position, row.in_text, row.anchor_head, row.anchor_tail]));

/** Move one identified passage without ever removing its only copy. */
export const moveScene: Handler = async (req, env, p) => {
  const b = await body<{ toChapterId?: unknown; expectedFromChapterId?: unknown; beforePassageIndex?: unknown; baseVersions?: { from?: unknown; to?: unknown } }>(req);
  if (!b || typeof b.toChapterId !== "string" ||
      (b.expectedFromChapterId !== undefined && typeof b.expectedFromChapterId !== "string") ||
      !(b.beforePassageIndex === null || (Number.isSafeInteger(b.beforePassageIndex) && (b.beforePassageIndex as number) >= 0)) ||
      !b.baseVersions || !Number.isSafeInteger(b.baseVersions.from) || (b.baseVersions.from as number) < 0 ||
      !Number.isSafeInteger(b.baseVersions.to) || (b.baseVersions.to as number) < 0) {
    throw new HttpError(400, "Choose a destination, passage and chapter versions");
  }
  const scene = await getSceneRow(env, p.id);
  if (!scene.in_text || !scene.chapter_id) throw new HttpError(400, "Only scenes in the text can be moved this way");
  if (b.expectedFromChapterId !== undefined && scene.chapter_id !== b.expectedFromChapterId) {
    throw new HttpError(409, "This scene moved elsewhere. Reload the scene list and try again.");
  }
  if (scene.chapter_id === b.toChapterId) throw new HttpError(400, "Choose a different chapter");
  let from = await getChapterRow(env, scene.chapter_id);
  let to = await getChapterRow(env, b.toChapterId);
  if (to.project_id !== from.project_id) throw new HttpError(404, "Chapter not found");
  [from, to] = await Promise.all([reconcileChapter(env, from), reconcileChapter(env, to)]);
  const [fromToken, toToken] = await Promise.all([chapterMoveToken(env, from.id), chapterMoveToken(env, to.id)]);
  const lockUntil = new Date(Date.now() + MOVE_LOCK_MS).toISOString();
  const acquiredAt = now();
  const releasedToken = (token: string | null) =>
    new Date(token === null ? Date.now() - 1 : Date.parse(token) - 1).toISOString();
  const fromReleased = releasedToken(fromToken);
  const toReleased = releasedToken(toToken);
  const release = () => env.DB.batch([
    env.DB.prepare("UPDATE chapters SET moving_until = ? WHERE id = ? AND moving_until = ?")
      .bind(fromReleased, from.id, lockUntil),
    env.DB.prepare("UPDATE chapters SET moving_until = ? WHERE id = ? AND moving_until = ?")
      .bind(toReleased, to.id, lockUntil),
  ]);
  const conflict = async () => {
    const [a, z] = await Promise.all([from.id, to.id].map((id) => env.DB.prepare(
      "SELECT version, moving_until FROM chapters WHERE id = ?",
    ).bind(id).first<{ version: number; moving_until: string | null }>()));
    return new HttpError(409, "conflict", { from: a, to: z });
  };
  if (from.version !== b.baseVersions.from || to.version !== b.baseVersions.to) throw await conflict();
  const claim = await env.DB.batch([
    env.DB.prepare(`UPDATE chapters SET moving_until = ? WHERE id = ? AND version = ? AND moving_until IS ?
      AND (moving_until IS NULL OR moving_until <= ?) AND deleted_at IS NULL`)
      .bind(lockUntil, from.id, b.baseVersions.from, fromToken, acquiredAt),
    env.DB.prepare(`UPDATE chapters SET moving_until = ? WHERE id = ? AND version = ? AND moving_until IS ?
      AND (moving_until IS NULL OR moving_until <= ?) AND deleted_at IS NULL`)
      .bind(lockUntil, to.id, b.baseVersions.to, toToken, acquiredAt),
  ]);
  if (claim.some((result) => result.meta.changes !== 1)) {
    const cleanup: D1PreparedStatement[] = [];
    if (claim[0].meta.changes) cleanup.push(env.DB.prepare(
      "UPDATE chapters SET moving_until = ? WHERE id = ? AND moving_until = ?",
    ).bind(fromReleased, from.id, lockUntil));
    if (claim[1].meta.changes) cleanup.push(env.DB.prepare(
      "UPDATE chapters SET moving_until = ? WHERE id = ? AND moving_until = ?",
    ).bind(toReleased, to.id, lockUntil));
    if (cleanup.length) await env.DB.batch(cleanup);
    throw await conflict();
  }
  const enoughTime = async () => {
    const threshold = new Date(Date.now() + 30_000).toISOString();
    const locks = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM chapters WHERE id IN (?, ?) AND moving_until = ? AND moving_until >= ?",
    ).bind(from.id, to.id, lockUntil, threshold).first<{ n: number }>();
    if (locks?.n !== 2) throw new HttpError(503, "The move took too long; nothing was changed. Try again.");
  };
  let destinationWritten = false;
  try {
  const [fromObject, toObject] = await Promise.all([
    env.BUCKET.get(chapterKey(from.project_id, from.id)),
    env.BUCKET.get(chapterKey(to.project_id, to.id)),
  ]);
  if ((from.version > 0 && !fromObject?.customMetadata?.version) ||
      (to.version > 0 && !toObject?.customMetadata?.version) ||
      chapterTextVersion(fromObject, from.version) !== from.version ||
      chapterTextVersion(toObject, to.version) !== to.version) throw await conflict();
  const [fromText, toText] = await Promise.all([fromObject?.text() ?? "", toObject?.text() ?? ""]);
  const readRows = async (id: string) => (await env.DB.prepare(
    "SELECT id, chapter_id, position, status, in_text, anchor_head, anchor_tail, word_count, unlinked_at, unconfirmed FROM scenes WHERE chapter_id = ? ORDER BY position",
  ).bind(id).all<SceneSyncRow>()).results;
  const [fromRows, toRows] = await Promise.all([readRows(from.id), readRows(to.id)]);
  const fromPassages = splitScenes(fromText, from.title);
  const toPassages = splitScenes(toText, to.title);
  const fromMatch = matchScenes(fromPassages, matchCards(fromRows));
  const toMatch = matchScenes(toPassages, matchCards(toRows));
  const fromIndex = fromMatch.pairs.get(scene.id);
  if (fromIndex === undefined || fromMatch.leftText.length || toMatch.leftText.length) throw new HttpError(409, sceneListError);
  const before = b.beforePassageIndex as number | null;
  if (before !== null && !toPassages[before]) throw new HttpError(400, "Passage not found");
  const emptyDestination = !toText.trim();
  if (emptyDestination && toMatch.pairs.size) throw new HttpError(409, sceneListError);
  const { rest, body: movedBody } = takePassage(fromText, fromPassages, fromIndex);
  const destination = insertPassage(toText, toPassages, movedBody, before);
  if (new TextEncoder().encode(destination).length > MAX_CHAPTER_BYTES ||
      new TextEncoder().encode(rest).length > MAX_CHAPTER_BYTES) {
    throw new HttpError(413, "Chapter is too large (5 MB limit)");
  }
  const insertion = emptyDestination ? 0 : before ?? toPassages.length;
  const newFromPassages = splitScenes(rest, from.title);
  const newToPassages = splitScenes(destination, to.title);
  const fromPairs = new Map([...fromMatch.pairs].filter(([id]) => id !== scene.id)
    .map(([id, index]) => [id, index > fromIndex ? index - 1 : index]));
  const toPairs = new Map([...toMatch.pairs].map(([id, index]) => [id, index >= insertion ? index + 1 : index]));
  toPairs.set(scene.id, insertion);
  if ([...fromPairs.values()].some((index) => !newFromPassages[index]) ||
      [...toPairs.values()].some((index) => !newToPassages[index])) throw new HttpError(409, sceneListError);
  const next = [...toMatch.pairs].filter(([, index]) => index >= insertion).sort((a, b) => a[1] - b[1])[0];
  const orderedTo = [...toRows];
  const insertAt = next ? orderedTo.findIndex((row) => row.id === next[0]) : orderedTo.length;
  const movedRow = fromRows.find((row) => row.id === scene.id)!;
  orderedTo.splice(insertAt, 0, movedRow);

    try {
      await enoughTime();
      await snapshotBeforeSave(env, from, "move", fromText);
      await enoughTime();
      await snapshotBeforeSave(env, to, "move", toText);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      console.error("move snapshot failed", e);
      throw new HttpError(500, "Could not keep a copy in History, so nothing was moved");
    }
    await enoughTime();
    try {
      await chapterPut(env, to, destination, to.version + 1);
    } catch {
      throw new HttpError(500, "The move may have completed. Reload and check both chapters.");
    }
    destinationWritten = true;
    try {
      await enoughTime();
      await chapterPut(env, from, rest, from.version + 1);
    } catch (e) {
      let sourceConfirmedOriginal = false;
      try {
        // A failed put can be ambiguous. Restore only if the original source is still present.
        const source = await env.BUCKET.get(chapterKey(from.project_id, from.id));
        if ((source ? await source.text() : "") !== fromText) throw new Error("Source write may have succeeded");
        sourceConfirmedOriginal = true;
        // Restore the extra copy even if the remaining lease fell below the write budget.
        const held = await env.DB.prepare("SELECT moving_until FROM chapters WHERE id = ?")
          .bind(to.id).first<{ moving_until: string | null }>();
        if (held?.moving_until !== lockUntil || lockUntil <= now()) throw new Error("Move lock expired");
        await chapterPut(env, to, toText, to.version);
        destinationWritten = false;
      } catch {
        if (!sourceConfirmedOriginal) {
          throw new HttpError(500, "The move may have completed. Reload and check both chapters.");
        }
        const held = await env.DB.prepare("SELECT moving_until FROM chapters WHERE id = ?")
          .bind(to.id).first<{ moving_until: string | null }>();
        if (held?.moving_until !== lockUntil || lockUntil <= now()) {
          throw new HttpError(500, "The move may have completed. Reload and check both chapters.");
        }
        try {
          const current = await env.BUCKET.get(chapterKey(to.project_id, to.id));
          if (!current || await current.text() !== destination) {
            throw new Error("Destination restore may have succeeded");
          }
        } catch {
          throw new HttpError(500, "The move may have completed. Reload and check both chapters.");
        }
        await env.DB.prepare(`UPDATE chapters SET version = ?, word_count = ?, updated_at = ?
          WHERE id = ? AND version = ? AND moving_until = ? AND moving_until > ?`)
          .bind(to.version + 1, countWords(destination), now(), to.id, to.version, lockUntil, now()).run();
        throw new HttpError(500, "The scene is now in both chapters. Delete one copy.");
      }
      if (e instanceof HttpError) throw e;
      throw new HttpError(500, "The scene could not be moved. Try again.");
    }
    const ts = now();
    const fromWords = countWords(rest);
    const toWords = countWords(destination);
    const updatedCards = (rows: SceneSyncRow[], pairs: Map<string, number>, passages: typeof fromPassages, chapterId: string) =>
      rows.map((row, position) => {
        const index = pairs.get(row.id);
        const passage = index === undefined ? undefined : passages[index];
        return { ...row, chapter_id: chapterId, position: chapterId === to.id ? position : row.position,
          anchor_head: passage?.head ?? row.anchor_head, anchor_tail: passage?.tail ?? row.anchor_tail,
          word_count: passage?.words ?? row.word_count, unlinked_at: passage ? null : row.unlinked_at };
      });
    const finalFrom = updatedCards(fromRows.filter((row) => row.id !== scene.id), fromPairs, newFromPassages, from.id);
    const finalTo = updatedCards(orderedTo, toPairs, newToPassages, to.id);
    const updates = JSON.stringify([...finalFrom, ...finalTo]);
    const snapshotGuard = `(SELECT json_group_array(json_array(id, position, in_text, anchor_head, anchor_tail))
      FROM (SELECT id, position, in_text, anchor_head, anchor_tail FROM scenes WHERE chapter_id = ? ORDER BY id)) = ?`;
    const result = await env.DB.batch([
      env.DB.prepare(`UPDATE scenes SET
        chapter_id = (SELECT json_extract(value, '$.chapter_id') FROM json_each(?) WHERE json_extract(value, '$.id') = scenes.id),
        position = (SELECT json_extract(value, '$.position') FROM json_each(?) WHERE json_extract(value, '$.id') = scenes.id),
        anchor_head = (SELECT json_extract(value, '$.anchor_head') FROM json_each(?) WHERE json_extract(value, '$.id') = scenes.id),
        anchor_tail = (SELECT json_extract(value, '$.anchor_tail') FROM json_each(?) WHERE json_extract(value, '$.id') = scenes.id),
        word_count = (SELECT json_extract(value, '$.word_count') FROM json_each(?) WHERE json_extract(value, '$.id') = scenes.id),
        unlinked_at = (SELECT json_extract(value, '$.unlinked_at') FROM json_each(?) WHERE json_extract(value, '$.id') = scenes.id)
        WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?))
        AND (SELECT COUNT(*) FROM chapters WHERE id IN (?, ?) AND moving_until = ? AND moving_until > ?) = 2
        AND ${snapshotGuard} AND ${snapshotGuard}`)
        .bind(updates, updates, updates, updates, updates, updates, updates, from.id, to.id, lockUntil, ts,
          from.id, sceneSnapshot(fromRows), to.id, sceneSnapshot(toRows)),
      env.DB.prepare(`UPDATE chapters SET version = ?, word_count = ?, updated_at = ?, moving_until = ?
        WHERE id = ? AND version = ? AND moving_until = ? AND moving_until > ?
        AND ${snapshotGuard} AND ${snapshotGuard}`)
        .bind(from.version + 1, fromWords, ts, fromReleased, from.id, from.version, lockUntil, ts,
          from.id, sceneSnapshot(finalFrom), to.id, sceneSnapshot(finalTo)),
      env.DB.prepare(`UPDATE chapters SET version = ?, word_count = ?, updated_at = ?, moving_until = ?
        WHERE id = ? AND version = ? AND moving_until = ? AND moving_until > ?
        AND ${snapshotGuard} AND ${snapshotGuard}`)
        .bind(to.version + 1, toWords, ts, toReleased, to.id, to.version, lockUntil, ts,
          from.id, sceneSnapshot(finalFrom), to.id, sceneSnapshot(finalTo)),
      env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(ts, from.project_id),
    ]);
    if (result[0].meta.changes !== finalFrom.length + finalTo.length ||
        result[1].meta.changes !== 1 || result[2].meta.changes !== 1) {
      throw new Error("Move lock expired during finalization");
    }
    await afterChapterWrite(env, to, destination, to.version + 1, { snapshot: sceneSnapshot(finalTo), pairs: toPairs });
    await afterChapterWrite(env, from, rest, from.version + 1, { snapshot: sceneSnapshot(finalFrom), pairs: fromPairs });
    const fresh = await getSceneRow(env, scene.id);
    return json({
      from: { version: from.version + 1, word_count: fromWords },
      to: { version: to.version + 1, word_count: toWords },
      scene: sceneMeta(fresh, newToPassages[insertion]),
      from_passage_index: fromIndex,
    });
  } catch (e) {
    if (destinationWritten && !(e instanceof HttpError)) {
      console.error("scene move partially completed", e);
      throw new HttpError(500, "The move may have completed. Reload and check both chapters.");
    }
    throw e;
  } finally {
    await release();
  }
};

/** Reorder cards and their passages, leaving uncarded passages with their preceding passage. */
export const arrangeScenes: Handler = async (req, env, p) => {
  const b = await body<{ baseVersion?: unknown; sceneIds?: unknown }>(req);
  if (!Number.isSafeInteger(b.baseVersion) || (b.baseVersion as number) < 0 ||
      !Array.isArray(b.sceneIds) || !b.sceneIds.every((id) => typeof id === "string")) {
    throw new HttpError(400, "baseVersion and sceneIds are required");
  }
  const baseVersion = b.baseVersion as number;
  const ids = b.sceneIds as string[];
  const chapter = await reconcileChapter(env, await getChapterRow(env, p.id));
  await assertChapterUnlocked(env, chapter.id);
  if (chapter.version !== baseVersion) throw new HttpError(409, "conflict", { version: chapter.version });
  const object = await env.BUCKET.get(chapterKey(chapter.project_id, chapter.id));
  if (chapterTextVersion(object, chapter.version) !== baseVersion) {
    throw new HttpError(409, "Chapter is changing; reload and try again");
  }
  const text = object ? await object.text() : "";
  const { results: rows } = await env.DB.prepare(
    "SELECT id, chapter_id, position, status, in_text, anchor_head, anchor_tail, word_count, unlinked_at, unconfirmed FROM scenes WHERE chapter_id = ? ORDER BY position",
  ).bind(chapter.id).all<SceneSyncRow>();
  const existing = new Set(rows.map((row) => row.id));
  if (ids.length !== existing.size || new Set(ids).size !== ids.length || ids.some((id) => !existing.has(id))) {
    throw new HttpError(409, sceneListError);
  }
  const passages = splitScenes(text, chapter.title);
  const match = matchScenes(passages, matchCards(rows));
  if (match.leftText.length) throw new HttpError(409, sceneListError);
  const snapshot = sceneSnapshot(rows);
  const paired = new Set(match.pairs.values());
  const groups = new Map<number, number[]>();
  const leading: number[] = [];
  let group: number[] = leading;
  for (const passage of passages) {
    if (paired.has(passage.index)) {
      group = [passage.index];
      groups.set(passage.index, group);
    } else group.push(passage.index);
  }
  const order = [...leading, ...ids.flatMap((id) => {
    const index = match.pairs.get(id);
    return index === undefined ? [] : groups.get(index)!;
  })];
  const changed = order.some((index, i) => index !== i);
  let result = { version: chapter.version, word_count: chapter.word_count, updated_at: chapter.updated_at };
  const arranged = changed ? arrangeText(text, passages, order) : text;
  if (changed) {
    if (new TextEncoder().encode(arranged).length > MAX_CHAPTER_BYTES) {
      throw new HttpError(413, "Chapter is too large (5 MB limit)");
    }
    result = await writeChapter(env, chapter, arranged, baseVersion, "move", { sceneSnapshot: snapshot });
  }
  try {
    if (changed) {
      const pairs = new Map([...match.pairs].map(([id, index]) => [id, order.indexOf(index)]));
      await afterChapterWrite(env, chapter, arranged, result.version, { snapshot, pairs });
      const sync = await env.DB.prepare("SELECT version, scenes_version FROM chapters WHERE id = ?")
        .bind(chapter.id).first<{ version: number; scenes_version: number }>();
      if (!sync || sync.version !== result.version || sync.scenes_version !== result.version) {
        throw new Error("Scene sync did not finish");
      }
    }
    // One guarded statement makes the list check and every position update atomic.
    const currentRows = changed
      ? (await env.DB.prepare(
        "SELECT id, chapter_id, position, status, in_text, anchor_head, anchor_tail, word_count, unlinked_at, unconfirmed FROM scenes WHERE chapter_id = ? ORDER BY position",
      ).bind(chapter.id).all<SceneSyncRow>()).results
      : rows;
    if (currentRows.length !== ids.length || currentRows.some((row) => !existing.has(row.id))) {
      throw new HttpError(409, sceneListError);
    }
    if (ids.length) {
      const positions = await env.DB.prepare(
        `UPDATE scenes SET position = (SELECT CAST(key AS INTEGER) FROM json_each(?) WHERE value = scenes.id)
         WHERE chapter_id = ? AND EXISTS (SELECT 1 FROM chapters WHERE id = ? AND version = ? AND deleted_at IS NULL
           AND (moving_until IS NULL OR moving_until <= ?))
         AND (SELECT json_group_array(json_array(id, position, in_text, anchor_head, anchor_tail))
              FROM (SELECT id, position, in_text, anchor_head, anchor_tail FROM scenes WHERE chapter_id = ? ORDER BY id)) = ?`,
      ).bind(JSON.stringify(ids), chapter.id, chapter.id, result.version, now(), chapter.id, sceneSnapshot(currentRows)).run();
      if (positions.meta.changes !== ids.length) {
        await assertChapterUnlocked(env, chapter.id);
        const current = await getChapterRow(env, chapter.id);
        if (current.version !== result.version) throw new HttpError(409, "conflict", { version: current.version });
        throw new HttpError(409, sceneListError);
      }
    } else {
      await assertChapterUnlocked(env, chapter.id);
      const current = await getChapterRow(env, chapter.id);
      if (current.version !== baseVersion) throw new HttpError(409, "conflict", { version: current.version });
      const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM scenes WHERE chapter_id = ?")
        .bind(chapter.id).first<{ n: number }>();
      if (count?.n) throw new HttpError(409, sceneListError);
    }
    await env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(now(), chapter.project_id).run();
    return json(result);
  } catch (e) {
    if (!changed) throw e;
    console.error("scene arrangement partially completed", e);
    throw new HttpError(500, "The chapter text was moved, but the scene cards could not be updated. Reload and check the chapter.", { version: result.version });
  }
};
