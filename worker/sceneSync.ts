import { matchScenes, splitScenes, type MatchCard } from "../shared/scenes";
import type { ChapterMeta, SceneStatus } from "../shared/types";
import type { Env } from "./env";

export interface SceneSyncRow {
  id: string;
  chapter_id: string;
  position: number;
  status: SceneStatus;
  in_text: number;
  anchor_head: string | null;
  anchor_tail: string | null;
  word_count: number;
  unlinked_at: string | null;
  unconfirmed: number;
}

export function matchCards(rows: SceneSyncRow[]): MatchCard[] {
  return rows.map((row) => ({ ...row, in_text: !!row.in_text }));
}

/** Match a chapter's scene cards to text just written. Never throws. */
export async function afterChapterWrite(env: Env, chapter: ChapterMeta, text: string, version: number): Promise<void> {
  try {
    const state = await env.DB.prepare("SELECT scenes_version FROM chapters WHERE id = ? AND version = ?")
      .bind(chapter.id, version).first<{ scenes_version: number }>();
    if (!state) return;
    const { results: rows } = await env.DB.prepare(
      "SELECT id, chapter_id, position, status, in_text, anchor_head, anchor_tail, word_count, unlinked_at, unconfirmed FROM scenes WHERE chapter_id = ? ORDER BY position",
    ).bind(chapter.id).all<SceneSyncRow>();
    const passages = splitScenes(text, chapter.title);
    const initial = state.scenes_version === 0 && rows.length > 0 && rows.length === passages.length &&
      rows.every((row) => !row.in_text);
    const cards = matchCards(rows);
    if (initial) cards.forEach((card, i) => {
      card.in_text = true;
      card.anchor_head = passages[i].head;
      card.anchor_tail = passages[i].tail;
    });
    const match = initial
      ? { pairs: new Map(rows.map((row, i) => [row.id, i])), placeholders: [] as number[], leftText: [] as string[] }
      : matchScenes(passages, cards);
    const followed: SceneSyncRow[] = [];
    for (const index of match.placeholders) {
      const head = passages[index].head;
      if (!head || passages.filter((passage) => passage.head === head).length !== 1) continue;
      const { results } = await env.DB.prepare(
        `SELECT id, chapter_id, position, status, in_text, anchor_head, anchor_tail, word_count, unlinked_at, unconfirmed
         FROM scenes WHERE project_id = ? AND chapter_id != ? AND in_text = 0 AND anchor_head = ?
           AND unlinked_at >= ?`,
      ).bind(chapter.project_id, chapter.id, head, new Date(Date.now() - 3600000).toISOString()).all<SceneSyncRow>();
      if (results.length === 1 && !followed.some((row) => row.id === results[0].id)) {
        followed.push(results[0]);
        match.pairs.set(results[0].id, index);
      }
    }
    const all = [...rows, ...followed];
    const slots = rows.filter((row) => row.in_text || match.pairs.has(row.id)).map((row) => row.position).sort((a, b) => a - b);
    let nextSlot = Math.max(-1, ...rows.map((row) => row.position)) + 1;
    while (slots.length < match.pairs.size) slots.push(nextSlot++);
    const ordered = [...match.pairs.entries()].sort((a, b) => a[1] - b[1]);
    const positions = new Map(ordered.map(([id], i) => [id, slots[i]]));
    const timestamp = new Date().toISOString();
    const changes: D1PreparedStatement[] = [];
    for (const row of all) {
      const index = match.pairs.get(row.id);
      const passage = index === undefined ? undefined : passages[index];
      const left = match.leftText.includes(row.id);
      if (!passage && !left) continue;
      const values = {
        chapter_id: passage ? chapter.id : row.chapter_id,
        in_text: passage ? 1 : 0,
        anchor_head: passage ? passage.head : row.anchor_head,
        anchor_tail: passage ? passage.tail : row.anchor_tail,
        word_count: passage ? passage.words : 0,
        unlinked_at: passage ? null : timestamp,
        unconfirmed: initial ? 1 : left ? 0 : row.unconfirmed,
        status: passage && !row.in_text && row.status === "planned" ? "drafted" : row.status,
        position: passage ? positions.get(row.id)! : row.position,
      };
      if (Object.entries(values).every(([key, value]) => row[key as keyof SceneSyncRow] === value)) continue;
      changes.push(env.DB.prepare(
        `UPDATE scenes SET chapter_id = ?, in_text = ?, anchor_head = ?, anchor_tail = ?, word_count = ?,
          unlinked_at = ?, unconfirmed = ?, status = ?, position = ?
         WHERE id = ? AND chapter_id = ? AND in_text = ? AND
           EXISTS (SELECT 1 FROM chapters WHERE id = ? AND version = ?)`,
      ).bind(values.chapter_id, values.in_text, values.anchor_head, values.anchor_tail, values.word_count,
        values.unlinked_at, values.unconfirmed, values.status, values.position, row.id, row.chapter_id, row.in_text, chapter.id, version));
    }
    changes.push(env.DB.prepare("UPDATE chapters SET scenes_version = ? WHERE id = ? AND version = ?")
      .bind(version, chapter.id, version));
    await env.DB.batch(changes);
  } catch (e) {
    console.error("scene sync failed", e);
  }
}
