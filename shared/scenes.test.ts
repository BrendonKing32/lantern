import { describe, expect, it } from "vitest";
import { parseChapter } from "../src/export/model";
import {
  arrangeText,
  insertPassage,
  matchScenes,
  normalizeAnchor,
  normalizeText,
  splitScenes,
  takePassage,
  type MatchCard,
  type Passage,
} from "./scenes";

describe("normalizeText and splitScenes", () => {
  it.each(["***", "* * *", "---", "___", "#", "##"])("splits on %s", (breakLine) => {
    const passages = splitScenes(`Before the break.\n\n${breakLine}\n\nAfter the break.`);
    expect(passages).toHaveLength(2);
    expect(passages.map((passage) => passage.breakLine)).toEqual([null, breakLine]);
    expect(passages.map((passage) => passage.words)).toEqual([3, 3]);
  });

  it("does not split a setext heading, fenced code, or a block quote", () => {
    expect(splitScenes("A setext heading\n---\n\nParagraph.")).toHaveLength(1);
    expect(splitScenes("Before.\n\n```md\n***\n```\n\nAfter.")).toHaveLength(1);
    expect(splitScenes("Before.\n\n> ---\n\nAfter.")).toHaveLength(1);
  });

  it("keeps a chapter without breaks as one passage", () => {
    const [passage] = splitScenes("A single scene.");
    expect(passage).toMatchObject({ index: 0, breakStart: null, breakLine: null, start: 0, end: 15 });
    expect(passage.words).toBe(3);
  });

  it("keeps leading, trailing, and consecutive breaks as empty passages", () => {
    const leadingAndTrailing = splitScenes("***\n\nMiddle passage.\n\n---");
    expect(leadingAndTrailing).toHaveLength(3);
    expect(leadingAndTrailing[0]).toMatchObject({ words: 0, head: "", tail: "" });
    expect(leadingAndTrailing[2]).toMatchObject({ words: 0, head: "", tail: "" });

    const consecutive = splitScenes("First passage.\n\n***\n\n---\n\nLast passage.");
    expect(consecutive).toHaveLength(3);
    expect(consecutive[1]).toMatchObject({ words: 0, head: "", tail: "", excerpt: "" });
  });

  it("normalizes line endings before calculating offsets", () => {
    const source = "First passage.\r\n\r\n***\r\n\r\nSecond passage.";
    const normalized = normalizeText(source);
    const passages = splitScenes(source);
    expect(normalized).toBe("First passage.\n\n***\n\nSecond passage.");
    expect(passages[1].breakStart).toBe(normalized.indexOf("***"));
    expect(passages[1].start).toBe(normalized.indexOf("***") + 4);
  });

  it("leaves a duplicate chapter-title heading out of anchors and excerpts", () => {
    const [passage] = splitScenes("# Chapter One\n\nThe story begins here.", "chapter one");
    expect(passage.head).toBe("the story begins here.");
    expect(passage.excerpt).toBe("The story begins here.");
    expect(passage.words).toBe(6);
  });

  it("uses the displayed text of wikilinks in anchors and excerpts", () => {
    expect(normalizeAnchor("[[Mara|her]] crossed the room.")).toBe("her crossed the room.");
    const [passage] = splitScenes("[[Mara|her]] crossed the room.");
    expect(passage.head).toBe("her crossed the room.");
    expect(passage.excerpt).toBe("her crossed the room.");
  });

  it("agrees with parseChapter about top-level scene breaks across varied chapters", () => {
    const corpus = [
      ["One", "A paragraph."],
      ["Two", "# Heading\n\nA paragraph."],
      ["Three", "A\n\n***\n\nB"],
      ["Four", "A\n\n* * *\n\nB\n\n---\n\nC"],
      ["Five", "A\n\n___\n\nB"],
      ["Six", "A\n\n#\n\nB\n\n##\n\nC"],
      ["Seven", "A setext heading\n---\n\nB"],
      ["Eight", "A\n\n```md\n***\n```\n\nB"],
      ["Nine", "A paragraph with **formatting** and a [link](https://example.com)."],
      ["Ten", "A\n\n***\n\nB\n\nAnother paragraph."],
      ["Eleven", "A paragraph.\n\n- One\n- Two"],
      ["Twelve", "A paragraph.\n\n> A quoted paragraph."],
    ];

    for (const [title, markdown] of corpus) {
      const expectedBreaks = parseChapter(title, markdown).blocks.filter((block) => block.kind === "break").length;
      expect(splitScenes(markdown, title).length - 1, title).toBe(expectedBreaks);
    }
  });
});

function cardFrom(passage: Passage, id: string, position: number): MatchCard {
  return {
    id,
    in_text: true,
    anchor_head: passage.head,
    anchor_tail: passage.tail,
    position,
  };
}

function longPassage(opening: string, ending: string): string {
  return `${opening} ${"middle words stay in place ".repeat(12)}${ending}`;
}

interface MatchCase {
  name: string;
  original: string;
  current: string;
  cardPassages: number[];
  cardStates?: boolean[];
  expectedPairs: Record<string, number>;
  placeholders: number[];
  leftText: string[];
}

const matchCases: MatchCase[] = [
  {
    name: "typing inside a scene",
    original: "The scene opens here. Then the writer adds another sentence.",
    current: "The scene opens here. Then the writer adds another sentence. A new line.",
    cardPassages: [0],
    expectedPairs: { "scene-0": 0 },
    placeholders: [],
    leftText: [],
  },
  {
    name: "splitting a scene",
    original: longPassage("The opening stays the same.", "The ending stays the same."),
    current: `${longPassage("The opening stays the same.", "The ending stays the same.")}\n\n***\n\nA new scene.`,
    cardPassages: [0],
    expectedPairs: { "scene-0": 0 },
    placeholders: [1],
    leftText: [],
  },
  {
    name: "merging two scenes",
    original: `${longPassage("The first passage begins.", "The first passage ends.")}\n\n***\n\n${longPassage("The second passage begins.", "The second passage ends.")}`,
    current: `${longPassage("The first passage begins.", "The first passage ends.")}\n\n${longPassage("The second passage begins.", "The second passage ends.")}`,
    cardPassages: [0, 1],
    expectedPairs: { "scene-0": 0 },
    placeholders: [],
    leftText: ["scene-1"],
  },
  {
    name: "swapping two scenes",
    original: `${longPassage("The first scene begins.", "The first scene ends.")}\n\n***\n\n${longPassage("The second scene begins.", "The second scene ends.")}`,
    current: `${longPassage("The second scene begins.", "The second scene ends.")}\n\n***\n\n${longPassage("The first scene begins.", "The first scene ends.")}`,
    cardPassages: [0, 1],
    expectedPairs: { "scene-0": 1, "scene-1": 0 },
    placeholders: [],
    leftText: [],
  },
  {
    name: "rewriting one scene opening",
    original: longPassage("The old opening.", "The ending remains unchanged."),
    current: longPassage("A rewritten opening.", "The ending remains unchanged."),
    cardPassages: [0],
    expectedPairs: { "scene-0": 0 },
    placeholders: [],
    leftText: [],
  },
  {
    name: "rewriting an opening and adding a break elsewhere",
    original: `${longPassage("The old opening.", "The first ending remains unchanged.")}\n\n***\n\n${longPassage("The second opening.", "The second ending remains unchanged.")}`,
    current: `${longPassage("A rewritten opening.", "The first ending remains unchanged.")}\n\n***\n\n${longPassage("The second opening.", "The second ending remains unchanged.")}\n\n---\n\nA new passage.`,
    cardPassages: [0, 1],
    expectedPairs: { "scene-0": 0, "scene-1": 1 },
    placeholders: [2],
    leftText: [],
  },
  {
    name: "two scenes with identical openings",
    original: `${longPassage("The repeated opening.", "The first ending is distinct.")}\n\n***\n\n${longPassage("The repeated opening.", "The second ending is distinct.")}`,
    current: `${longPassage("The repeated opening.", "The first ending is distinct.")}\n\n***\n\n${longPassage("The repeated opening.", "The second ending is distinct.")}`,
    cardPassages: [0, 1],
    expectedPairs: { "scene-0": 0, "scene-1": 1 },
    placeholders: [],
    leftText: [],
  },
  {
    name: "adding a new break near the top",
    original: longPassage("The existing passage begins.", "The existing passage ends."),
    current: `A new passage.\n\n***\n\n${longPassage("The existing passage begins.", "The existing passage ends.")}`,
    cardPassages: [0],
    expectedPairs: { "scene-0": 1 },
    placeholders: [0],
    leftText: [],
  },
  {
    name: "all cards are planned",
    original: "A first passage.\n\n***\n\nA second passage.",
    current: "A first passage.\n\n***\n\nA second passage.",
    cardPassages: [0, 1],
    cardStates: [false, false],
    expectedPairs: {},
    placeholders: [0, 1],
    leftText: [],
  },
];

describe("matchScenes", () => {
  it.each(matchCases)("$name", (scenario) => {
    const originalPassages = splitScenes(scenario.original);
    const passages = splitScenes(scenario.current);
    const cards = scenario.cardPassages.map((passageIndex, index) => ({
      ...cardFrom(originalPassages[passageIndex], `scene-${index}`, index),
      in_text: scenario.cardStates?.[index] ?? true,
    }));

    const result = matchScenes(passages, cards);
    expect(Object.fromEntries(result.pairs)).toEqual(scenario.expectedPairs);
    expect(result.placeholders).toEqual(scenario.placeholders);
    expect(result.leftText).toEqual(scenario.leftText);
  });
});

describe("passage text edits", () => {
  it("keeps break lines and gives the former first passage the usual break", () => {
    const text = "First passage.\n\n---\n\nSecond passage.\n\n* * *\n\nThird passage.";
    const passages = splitScenes(text);
    expect(arrangeText(text, passages, [1, 2, 0])).toBe(
      "Second passage.\n\n* * *\n\nThird passage.\n\n---\n\nFirst passage.",
    );
  });

  it("uses the first break style to settle a tie", () => {
    const text = "First.\n\n---\n\nSecond.\n\n***\n\nThird.";
    const passages = splitScenes(text);
    expect(arrangeText(text, passages, [2, 0, 1])).toBe("Third.\n\n---\n\nFirst.\n\n---\n\nSecond.");

    const tiedCounts = "Zero.\n\n***\n\nOne.\n\n---\n\nTwo.\n\n---\n\nThree.\n\n***\n\nFour.\n";
    expect(arrangeText(tiedCounts, splitScenes(tiedCounts), [1, 0, 2, 3, 4])).toBe(
      "One.\n\n***\n\nZero.\n\n---\n\nTwo.\n\n---\n\nThree.\n\n***\n\nFour.\n",
    );
  });

  it("round-trips an identity order with normalized spacing and final newline", () => {
    const text = "First passage.\n\n\n***\n\n\nSecond passage.\n\n";
    const passages = splitScenes(text);
    expect(arrangeText(text, passages, [0, 1])).toBe("First passage.\n\n***\n\nSecond passage.\n");
  });

  it("takes a passage while preserving the other passage's break", () => {
    const text = "First passage.\n\n---\n\nSecond passage.\n\n* * *\n\nThird passage.\n";
    const passages = splitScenes(text);
    expect(takePassage(text, passages, 1)).toEqual({
      rest: "First passage.\n\n* * *\n\nThird passage.\n",
      body: "Second passage.",
    });
  });

  it("inserts into an empty chapter without a break", () => {
    expect(insertPassage("", splitScenes(""), "A new scene.", null)).toBe("A new scene.");
  });

  it("inserts a passage before the requested passage", () => {
    const text = "First passage.\n\n---\n\nLast passage.";
    expect(insertPassage(text, splitScenes(text), "Inserted passage.", 1)).toBe(
      "First passage.\n\n---\n\nInserted passage.\n\n---\n\nLast passage.",
    );
  });

  it("preserves indentation when arranging, taking, and inserting a passage", () => {
    const text = "Intro.\n\n***\n\n    indented code line\n\nAfter.\n";
    const passages = splitScenes(text);
    const arranged = arrangeText(text, passages, [1, 0]);
    expect(arranged).toBe("    indented code line\n\nAfter.\n\n***\n\nIntro.\n");

    const taken = takePassage(text, passages, 1);
    expect(taken.body).toBe("    indented code line\n\nAfter.");
    expect(taken.body.startsWith("    ")).toBe(true);

    const destination = "Existing.\n\n---\n\nEnd.";
    const inserted = insertPassage(destination, splitScenes(destination), taken.body, 1);
    expect(inserted).toBe(
      "Existing.\n\n---\n\n    indented code line\n\nAfter.\n\n---\n\nEnd.",
    );
    expect(inserted).toContain("\n    indented code line");
  });

  it("keeps a matching chapter-title heading pinned while rearranging passages", () => {
    const text = "# Title\n\nAlpha here.\n\n#\n\nBeta here.\n\n---\n\nGamma here.\n";
    const passages = splitScenes(text, "Title");
    expect(passages[0].lead).toBe(text.indexOf("Alpha here."));

    const arranged = arrangeText(text, passages, [2, 1, 0]);
    expect(arranged.startsWith("# Title\n")).toBe(true);
    expect(splitScenes(arranged, "Title").map((passage) => passage.head)).toEqual([
      "gamma here.",
      "beta here.",
      "alpha here.",
    ]);
  });

  it("keeps a matching chapter-title heading pinned when inserting at passage zero", () => {
    const text = "# Title\n\nAlpha here.\n\n#\n\nBeta here.\n\n---\n\nGamma here.\n";
    const inserted = insertPassage(text, splitScenes(text, "Title"), "Inserted.", 0);
    expect(inserted.startsWith("# Title\n")).toBe(true);
    expect(splitScenes(inserted, "Title").map((passage) => passage.head)).toEqual([
      "inserted.",
      "alpha here.",
      "beta here.",
      "gamma here.",
    ]);
  });

  it("keeps a matching chapter-title heading pinned when taking passage zero", () => {
    const text = "# Title\n\nAlpha here.\n\n#\n\nBeta here.\n\n---\n\nGamma here.\n";
    const taken = takePassage(text, splitScenes(text, "Title"), 0);
    expect(taken.body).toBe("Alpha here.");
    expect(taken.rest.startsWith("# Title\n")).toBe(true);
    expect(splitScenes(taken.rest, "Title").map((passage) => passage.head)).toEqual([
      "beta here.",
      "gamma here.",
    ]);
  });
});
