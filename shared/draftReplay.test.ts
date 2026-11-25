import { describe, expect, it } from "vitest";
import { replayDraft } from "./draftReplay";

describe("replayDraft", () => {
  it("applies dependent edits and appends in order", () => {
    expect(replayDraft("one two", [
      { kind: "replace", old_text: "one", new_text: "three" },
      { kind: "replace", old_text: "three two", new_text: "four" },
      { kind: "append", text: "five" },
    ])).toEqual({ text: "four\n\nfive\n", applied: 3, failed: [] });
  });

  it("skips missing and ambiguous edits, and continues", () => {
    const ops = [
      { kind: "replace" as const, old_text: "missing", new_text: "x" },
      { kind: "replace" as const, old_text: "one", new_text: "x" },
      { kind: "replace" as const, old_text: "two", new_text: "three" },
    ];
    expect(replayDraft("one one two", ops)).toEqual({
      text: "one one three", applied: 1,
      failed: [{ index: 0, op: ops[0], reason: "missing" }, { index: 1, op: ops[1], reason: "ambiguous" }],
    });
  });

  it("sets only an empty chapter", () => {
    const op = { kind: "set" as const, text: "opening\n" };
    expect(replayDraft(" \n", [op])).toEqual({ text: "opening\n", applied: 1, failed: [] });
    expect(replayDraft("writing", [op])).toEqual({
      text: "writing", applied: 0, failed: [{ index: 0, op, reason: "missing" }],
    });
  });

  it("matches normalized lines and preserves the chapter's CRLF", () => {
    expect(replayDraft("first\r\nsecond\r\n", [
      { kind: "replace", old_text: "first\nsecond", new_text: "new\nwords" },
      { kind: "append", text: "last\nline" },
    ]).text).toBe("new\r\nwords\r\n\r\nlast\r\nline\r\n");
  });
});
