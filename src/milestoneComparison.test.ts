import { describe, expect, it } from "vitest";
import type { ChapterMeta, MilestoneChapter } from "../shared/types";
import { countChangedWords } from "./historyDiff";
import { classifyMilestoneChapters } from "./milestoneComparison";

describe("milestone comparison", () => {
  it("matches chapters by id and identifies additions, removals, renames and reordering", () => {
    const before = [
      { chapter_id: "a", title: "Old" }, { chapter_id: "b", title: "B" }, { chapter_id: "gone", title: "Gone" },
    ] as MilestoneChapter[];
    const now = [
      { id: "b", title: "B" }, { id: "a", title: "New" }, { id: "new", title: "New chapter" },
    ] as ChapterMeta[];
    expect(classifyMilestoneChapters(before, now)).toMatchObject({ added: 1, removed: 1, renamed: 1, reordered: true });
  });

  it("counts inserted and deleted words rather than net length", () => {
    expect(countChangedWords("one old word", "one new word here")).toEqual({ added: 2, removed: 1 });
    expect(countChangedWords("same", "same")).toEqual({ added: 0, removed: 0 });
  });
});
