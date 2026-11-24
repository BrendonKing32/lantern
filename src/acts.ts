// The chapter list as rows: act headings with their chapters under them.
import type { Act, ChapterMeta } from "../shared/types";

export const ACT_ROW_PREFIX = "act:";

export type Row =
  | { kind: "act"; id: string; act: Act }
  | { kind: "chapter"; id: string; chapter: ChapterMeta };

/** Chapters with no act first, then each act's heading followed by its chapters. */
export function actRows(chapters: ChapterMeta[], acts: Act[]): Row[] {
  const known = new Set(acts.map((a) => a.id));
  const row = (chapter: ChapterMeta): Row => ({ kind: "chapter", id: chapter.id, chapter });
  return [
    ...chapters.filter((c) => !c.act_id || !known.has(c.act_id)).map(row),
    ...[...acts]
      .sort((a, b) => a.position - b.position)
      .flatMap((act) => [
        { kind: "act" as const, id: ACT_ROW_PREFIX + act.id, act },
        ...chapters.filter((c) => c.act_id === act.id).map(row),
      ]),
  ];
}

/** After a drag: the book in order, each chapter in the act whose heading it now sits under. */
export function arrangeFromRows(rowIds: string[]): { chapterIds: string[]; chapterActs: Record<string, string | null> } {
  const chapterIds: string[] = [];
  const chapterActs: Record<string, string | null> = {};
  let act: string | null = null;
  for (const id of rowIds) {
    if (id.startsWith(ACT_ROW_PREFIX)) {
      act = id.slice(ACT_ROW_PREFIX.length);
    } else {
      chapterIds.push(id);
      chapterActs[id] = act;
    }
  }
  return { chapterIds, chapterActs };
}
