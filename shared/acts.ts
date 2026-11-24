// Book order with acts: chapters that belong to no act come first, then each
// act's chapters in act order. Within a group, chapters keep their order.

interface Placed {
  id: string;
  act_id: string | null;
  position: number;
}

/** The chapters in book order, renumbered 0, 1, 2… An unknown act counts as none. */
export function arrangeChapters<C extends Placed>(chapters: C[], acts: { id: string; position: number }[]): C[] {
  const rank = new Map([...acts].sort((a, b) => a.position - b.position).map((a, i) => [a.id, i + 1]));
  const group = (c: C) => (c.act_id ? (rank.get(c.act_id) ?? 0) : 0);
  return chapters
    .map((c, i) => ({ c, i }))
    .sort((a, b) => group(a.c) - group(b.c) || a.c.position - b.c.position || a.i - b.i)
    .map(({ c }, i) => ({ ...c, act_id: group(c) ? c.act_id : null, position: i }));
}
