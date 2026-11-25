import { describe, expect, it } from "vitest";
import { createAnchorMatcher, findAnchor, makeAnchor, type TextAnchor } from "./anchors";

function reference(text: string, anchor: TextAnchor): { from: number; to: number } | null {
  function collapse(value: string) {
    let result = "";
    const starts: number[] = [];
    const ends: number[] = [];
    for (let i = 0; i < value.length; i++) {
      if (/\s/.test(value[i]) && i > 0 && /\s/.test(value[i - 1])) {
        ends[ends.length - 1] = i + 1;
      } else {
        result += /\s/.test(value[i]) ? " " : value[i];
        starts.push(i);
        ends.push(i + 1);
      }
    }
    return { result, starts, ends };
  }
  function match(value: string, a: TextAnchor): { from: number; to: number } | null | undefined {
    const positions: number[] = [];
    for (let i = value.indexOf(a.quote); i !== -1; i = value.indexOf(a.quote, i + 1)) positions.push(i);
    if (!positions.length) return undefined;
    if (positions.length === 1) return { from: positions[0], to: positions[0] + a.quote.length };
    const scores = positions.map((at) => {
      let before = 0;
      while (before < a.prefix.length && at - before - 1 >= 0 &&
        value[at - before - 1] === a.prefix[a.prefix.length - before - 1]) before++;
      let after = 0;
      while (after < a.suffix.length && at + a.quote.length + after < value.length &&
        value[at + a.quote.length + after] === a.suffix[after]) after++;
      return before + after;
    });
    const best = Math.max(...scores);
    if (scores.filter((score) => score === best).length !== 1) return null;
    const from = positions[scores.indexOf(best)];
    return { from, to: from + a.quote.length };
  }
  if (!anchor.quote || anchor.quote.length > 2000) return null;
  const exact = match(text, anchor);
  if (exact !== undefined) return exact;
  const normalized = collapse(text);
  const found = match(normalized.result, {
    quote: collapse(anchor.quote).result,
    prefix: collapse(anchor.prefix).result,
    suffix: collapse(anchor.suffix).result,
  });
  return found ? { from: normalized.starts[found.from], to: normalized.ends[found.to - 1] } : null;
}

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

  it("maps whitespace at both boundaries and reuses a document matcher", () => {
    const text = "😀 \n\talpha \n beta  \t gamma\n\n end";
    const find = createAnchorMatcher(text);
    const first = { quote: " alpha beta ", prefix: "😀", suffix: "gamma" };
    const range = find(first)!;
    expect(text.slice(range.from, range.to)).toBe(" \n\talpha \n beta  \t ");
    expect(find({ quote: "gamma end", prefix: "", suffix: "" }))
      .toEqual({ from: text.indexOf("gamma"), to: text.length });
    expect(find({ quote: "missing", prefix: "", suffix: "" })).toBeNull();
    expect(find(first)).toEqual(range);
  });

  it("matches the original algorithm across whitespace, duplicate and UTF-16 cases", () => {
    let seed = 41;
    const random = (n: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed % n;
    };
    const chars = ["a", "b", " ", "\n", "\t", "\u00a0", "😀"];
    for (let test = 0; test < 500; test++) {
      let text = "";
      for (let i = 0; i < 80; i++) text += chars[random(chars.length)];
      const start = random(text.length - 10);
      const anchor = {
        quote: text.slice(start, start + 1 + random(10)).replace(/\s+/g, " "),
        prefix: text.slice(Math.max(0, start - 8), start),
        suffix: text.slice(start + 10, start + 18),
      };
      expect(findAnchor(text, anchor)).toEqual(reference(text, anchor));
    }
  });

  it("handles repeated missing passages in a large document", () => {
    const find = createAnchorMatcher("word \n ".repeat(150_000));
    for (let i = 0; i < 30; i++) {
      expect(find({ quote: `missing ${i}`, prefix: "", suffix: "" })).toBeNull();
    }
  });
});
