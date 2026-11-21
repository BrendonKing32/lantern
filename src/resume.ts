export function selectChapter<T extends { id: string }>(
  chapters: T[],
  chapterId: string | undefined,
  lastChapterId: string | null,
): T | undefined {
  const requested = chapterId ?? lastChapterId;
  return chapters.find((chapter) => chapter.id === requested) ?? chapters[0];
}
