import type { ChapterMeta } from "../shared/types";

export interface SearchMatch {
  chapterId: string;
  chapterTitle: string;
  excerpt: string;
  text: string;
  index: number;
}

export function replaceBookText(
  content: string,
  query: string,
  replacement: string,
  caseSensitive = false,
): { content: string; count: number } {
  if (!query) return { content, count: 0 };
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escaped, caseSensitive ? "gu" : "giu");
  let count = 0;
  const replaced = content.replace(pattern, () => {
    count++;
    return replacement;
  });
  return { content: replaced, count };
}

export function findBookMatches(
  chapters: ChapterMeta[],
  contents: Map<string, string>,
  query: string,
  caseSensitive = false,
  limit = 500,
): SearchMatch[] {
  if (!query) return [];
  const matches: SearchMatch[] = [];
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(escaped, caseSensitive ? "gu" : "giu");
  for (const chapter of chapters) {
    const content = contents.get(chapter.id) ?? "";
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while (matches.length < limit && (match = pattern.exec(content)) !== null) {
      const index = match.index;
      const end = index + match[0].length;
      const left = Math.max(0, index - 55);
      const right = Math.min(content.length, end + 75);
      matches.push({
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        excerpt: `${left ? "…" : ""}${content.slice(left, right).replace(/\s+/g, " ")}${right < content.length ? "…" : ""}`,
        text: content.slice(index, end),
        index,
      });
    }
    if (matches.length >= limit) break;
  }
  return matches;
}
