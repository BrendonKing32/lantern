import { describe, expect, it } from "vitest";
import { minimalChange } from "./minimalChange";

const apply = (a: string, c: { from: number; to: number; insert: string }) => a.slice(0, c.from) + c.insert + a.slice(c.to);

describe("minimalChange", () => {
  it("replaces only the changed span", () => {
    const a = "The lamp was lit.\nMara waited.";
    const b = "The lamp was dark.\nMara waited.";
    const c = minimalChange(a, b);
    expect(c).toEqual({ from: 13, to: 16, insert: "dark" });
    expect(apply(a, c)).toBe(b);
  });

  it("handles insertions, deletions, and identical or empty text", () => {
    for (const [a, b] of [["abc", "abXc"], ["abXc", "abc"], ["", "new"], ["old", ""], ["same", "same"], ["aaa", "aaaa"]]) {
      expect(apply(a, minimalChange(a, b))).toBe(b);
    }
    expect(minimalChange("same", "same")).toEqual({ from: 4, to: 4, insert: "" });
  });
});
