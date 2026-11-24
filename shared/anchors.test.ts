import { describe, expect, it } from "vitest";
import { findAnchor, makeAnchor } from "./anchors";

describe("text anchors", () => {
  it("captures exact text and up to 32 characters of context", () => {
    const text = `${"a".repeat(40)}😀 hello ${"b".repeat(40)}`;
    const from = text.indexOf("hello");
    const anchor = makeAnchor(text, from, from + 5);
    expect(anchor).toEqual({ quote: "hello", prefix: text.slice(from - 32, from), suffix: text.slice(from + 5, from + 37) });
    expect(findAnchor(text, anchor)).toEqual({ from, to: from + 5 });
  });

  it("rejects empty, out-of-bounds, noninteger and too-long selections", () => {
    for (const [from, to] of [[0, 0], [-1, 1], [0, 2001], [0.5, 1], [0, 3000]]) {
      expect(() => makeAnchor("x".repeat(2001), from, to)).toThrow(RangeError);
    }
    expect(makeAnchor("x".repeat(2000), 0, 2000).quote).toHaveLength(2000);
  });

  it("breaks duplicate and overlapping matches by both sides of their context", () => {
    expect(findAnchor("red fish blue; red fish green", { quote: "fish", prefix: "red ", suffix: " green" }))
      .toEqual({ from: 19, to: 23 });
    expect(findAnchor("ababa", { quote: "aba", prefix: "ab", suffix: "" })).toEqual({ from: 2, to: 5 });
  });

  it("returns null for a tie or a missing passage", () => {
    expect(findAnchor("x and x", { quote: "x", prefix: "", suffix: "" })).toBeNull();
    expect(findAnchor("something else", { quote: "missing", prefix: "", suffix: "" })).toBeNull();
    expect(findAnchor("text", { quote: "", prefix: "", suffix: "" })).toBeNull();
  });

  it("maps collapsed whitespace matches back to original UTF-16 offsets", () => {
    const text = "😀 start one \n\t two end";
    const anchor = { quote: "one two", prefix: "start ", suffix: " end" };
    const found = findAnchor(text, anchor);
    expect(found).toEqual({ from: text.indexOf("one"), to: text.indexOf(" end") });
    expect(text.slice(found!.from, found!.to)).toBe("one \n\t two");
    expect(findAnchor("A one\n two x; B one\t two y", { quote: "one two", prefix: "B ", suffix: " y" }))
      .toEqual({ from: 16, to: 24 });
    expect(findAnchor("a\n b; a\t b", { quote: "a b", prefix: "", suffix: "" })).toBeNull();
  });
});
