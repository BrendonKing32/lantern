import { describe, expect, it } from "vitest";
import type { ChapterMeta } from "../shared/types";
import { findBookMatches, replaceBookText } from "./search";

const chapters: ChapterMeta[] = [
  { id: "one", project_id: "book", title: "First", synopsis: "", position: 0, word_count: 0, version: 0, updated_at: "", act_id: null, revision_status: "drafting" },
  { id: "two", project_id: "book", title: "Second", synopsis: "", position: 1, word_count: 0, version: 0, updated_at: "", act_id: null, revision_status: "drafting" },
];

describe("whole-book search", () => {
  it("finds literal matches in chapter order and gives each a context excerpt", () => {
    const found = findBookMatches(chapters, new Map([["one", "Mara met Mara."], ["two", "Mara left."]]), "Mara");
    expect(found.map(({ chapterTitle, text }) => [chapterTitle, text])).toEqual([
      ["First", "Mara"], ["First", "Mara"], ["Second", "Mara"],
    ]);
    expect(found[0].excerpt).toContain("Mara met Mara.");
  });

  it("supports case sensitivity and caps the result count", () => {
    expect(findBookMatches(chapters, new Map([["one", "mara Mara"]]), "Mara", true)).toHaveLength(1);
    expect(findBookMatches(chapters, new Map([["one", "x x x"]]), "x", false, 2)).toHaveLength(2);
  });

  it("does not interpret punctuation in the query as a pattern", () => {
    expect(findBookMatches(chapters, new Map([["one", "a+b aab"]]), "a+b")).toHaveLength(1);
  });

  it("replaces literal matches, honoring case and replacement characters", () => {
    expect(replaceBookText("Mara met mara.", "mara", "$&", false)).toEqual({
      content: "$& met $&.",
      count: 2,
    });
    expect(replaceBookText("Mara met mara.", "mara", "Mara", true)).toEqual({
      content: "Mara met Mara.",
      count: 1,
    });
  });

  it("does nothing for an empty query", () => {
    expect(replaceBookText("Keep this.", "", "changed")).toEqual({ content: "Keep this.", count: 0 });
  });
});
