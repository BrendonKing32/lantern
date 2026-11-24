import type { ChapterMeta, MilestoneChapter } from "../shared/types";

export function classifyMilestoneChapters(then: MilestoneChapter[], now: ChapterMeta[]) {
  const old = new Map(then.map((chapter) => [chapter.chapter_id, chapter]));
  const current = new Map(now.map((chapter) => [chapter.id, chapter]));
  const oldOrder = then.filter((chapter) => current.has(chapter.chapter_id)).map((chapter) => chapter.chapter_id);
  const newOrder = now.filter((chapter) => old.has(chapter.id)).map((chapter) => chapter.id);
  return {
    rows: [
      ...now.map((chapter) => ({ before: old.get(chapter.id), now: chapter })),
      ...then.filter((chapter) => !current.has(chapter.chapter_id)).map((chapter) => ({ before: chapter, now: undefined })),
    ],
    added: now.filter((chapter) => !old.has(chapter.id)).length,
    removed: then.filter((chapter) => !current.has(chapter.chapter_id)).length,
    renamed: now.filter((chapter) => old.has(chapter.id) && old.get(chapter.id)!.title !== chapter.title).length,
    reordered: oldOrder.some((id, i) => id !== newOrder[i]),
  };
}
