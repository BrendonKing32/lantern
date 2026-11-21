import { describe, expect, it } from "vitest";
import { selectChapter } from "./resume";

const chapters = [{ id: "first" }, { id: "last" }];

describe("chapter selection", () => {
  it("resumes the remembered chapter when no chapter is specified", () => {
    expect(selectChapter(chapters, undefined, "last")).toEqual(chapters[1]);
  });

  it("prefers an explicit chapter, including when the remembered chapter differs", () => {
    expect(selectChapter(chapters, "first", "last")).toEqual(chapters[0]);
  });

  it("falls back to the first chapter when the requested or remembered chapter is missing", () => {
    expect(selectChapter(chapters, undefined, "deleted")).toEqual(chapters[0]);
    expect(selectChapter(chapters, "deleted", "last")).toEqual(chapters[0]);
    expect(selectChapter(chapters, undefined, null)).toEqual(chapters[0]);
    expect(selectChapter([], undefined, "deleted")).toBeUndefined();
  });
});
