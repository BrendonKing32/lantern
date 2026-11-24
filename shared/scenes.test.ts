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

describe("normalizeAnchor", () => {
  it("strips wiki links, markdown marks, case, and repeated whitespace", () => {
    expect(normalizeAnchor("  **[[Mara|her]]**\n *lantern*  ")).toBe("her lantern");
  });
});

describe("splitScenes", () => {
  it.each(["***", "* * *", "---", "___", "#", "##"])("splits on a top-level %s break", (breakLine) => {
    const passages = splitScenes(`First passage.\n\n${breakLine}\n\nSecond passage.`);
    expect(passages).toHaveLength(2);
    expect(passages[0].breakLine).toBeNull();
    expect(passages[1].breakLine).toBe(breakLine);
    expect(passages[1].breakStart).toBeGreaterThan(passages[0].start);
    expect(passages.map((passage) => passage.words)).toEqual([2, 2]);
  });

  it("does not split a setext heading, fenced code, or a block quote", () => {
    expect(splitScenes("A paragraph\n---\n\nAnother paragraph")).toHaveLength(1);
    expect(splitScenes("```md\n***\n```\n\nAfter the code")).toHaveLength(1);
    expect(splitScenes("> Quoted text\n>\n> ---\n\nOutside the quote")).toHaveLength(1);
  });

  it("keeps a chapter without breaks as one passage", () => {
    expect(splitScenes("One complete scene.")).toHaveLength(1);
  });

  it("keeps empty leading, trailing, and adjacent passages", () => {
    const leadingAndTrailing = splitScenes("***\n\nBody.\n\n---\n");
    expect(leadingAndTrailing).toHaveLength(3);
    expect(leadingAndTrailing[0].words).toBe(0);
    expect(leadingAndTrailing[1].words).toBe(1);
    expect(leadingAndTrailing[2].words).toBe(0);

    const adjacent = splitScenes("Before.\n\n***\n\n---\n\nAfter.");
    expect(adjacent).toHaveLength(3);
    expect(adjacent[1].words).toBe(0);
    expect(adjacent[1].head).toBe("");
    expect(adjacent[1].tail).toBe("");
  });

  it("normalizes CRLF offsets before splitting", () => {
    const source = "First.\r\n\r\n***\r\n\r\nSecond.\r\n";
    const text = normalizeText(source);
    const passages = splitScenes(source);
    expect(passages[1].breakStart).toBe(text.indexOf("***"));
    expect(passages[1].start).toBe(text.indexOf("***") + "***\n".length);
    expect(passages[1].end).toBe(text.length);
  });

  it("omits a matching first title heading from anchors and excerpt", () => {
    const passages = splitScenes("# The **Title**\n\nMara sees [[the lantern|her]].", "the title");
    expect(passages[0].head).toBe("mara sees her.");
    expect(passages[0].excerpt).toBe("Mara sees her.");
    expect(passages[0].words).toBe(7);
    expect(splitScenes("# [[Mara|her]]\n\nThe scene begins.", "her")[0].head).toBe("the scene begins.");
  });

  it("normalizes wiki-link display text in anchors", () => {
    expect(splitScenes("Mara gave [[the lantern|her]] to Ivo.")[0].head).toBe("mara gave her to ivo.");
  });

  it("matches parseChapter break counts across varied chapter markdown", () => {
    const chapters = [
      "Opening paragraph.\n\n***\n\nClosing paragraph.",
      "Opening paragraph.\n\n* * *\n\nClosing paragraph.",
      "Opening paragraph.\n\n---\n\nClosing paragraph.",
      "Opening paragraph.\n\n___\n\nClosing paragraph.",
      "# Chapter title\n\nOpening paragraph.\n\n***\n\nClosing paragraph.",
      "A setext heading\n===\n\nOpening paragraph\n\n***\n\nClosing paragraph.",
      "```md\n***\n```\n\nOpening paragraph\n\n---\n\nClosing paragraph.",
      "> Quoted paragraph\n\nOpening paragraph\n\n***\n\nClosing paragraph.",
      "- A list item\n\n***\n\nA paragraph.",
      "Opening paragraph\n\n#\n\nClosing paragraph.",
      "Opening paragraph\n\n##\n\nClosing paragraph.",
      "Opening paragraph\n\nAnother paragraph.",
    ];

    expect(chapters.length).toBeGreaterThanOrEqual(10);
    for (const [index, markdown] of chapters.entries()) {
      const expected = parseChapter(`Chapter ${index}`, markdown).blocks.filter((block) => block.kind === "break").length;
      expect(splitScenes(markdown, `Chapter ${index}`).length - 1, `chapter ${index}: ${markdown}`).toBe(expected);
    }
  });
});

function cardFromPassage(id: string, passage: Passage, position: number): MatchCard {
  return {
    id,
    in_text: true,
    anchor_head: passage.head,
    anchor_tail: passage.tail,
    position,
  };
}

interface MatchCase {
  name: string;
  original: string;
  current: string;
  cardPassageIndexes: number[];
  expectedPairs: [string, number][];
  expectedPlaceholders: number[];
  expectedLeftText: string[];
}

const longScene = (opening: string, ending: string) => `${opening}${"x".repeat(200)}${ending}`;

describe("matchScenes", () => {
  const cases: MatchCase[] = [
    {
      name: "type inside a scene",
      original: "The door was open.\nShe waited.",
      current: "The door was ajar.\nShe waited.",
      cardPassageIndexes: [0],
      expectedPairs: [["card-0", 0]],
      expectedPlaceholders: [],
      expectedLeftText: [],
    },
    {
      name: "split a scene",
      original: "Once Mara entered the room.",
      current: "Once Mara entered the room.\n\n***\n\nShe closed the door.",
      cardPassageIndexes: [0],
      expectedPairs: [["card-0", 0]],
      expectedPlaceholders: [1],
      expectedLeftText: [],
    },
    {
      name: "merge two scenes",
      original: `${longScene("First opening. ", " first ending.")}\n\n***\n\n${longScene("Second opening. ", " second ending.")}`,
      current: `${longScene("First opening. ", " first ending.")}\n\n${longScene("Second opening. ", " second ending.")}`,
      cardPassageIndexes: [0, 1],
      expectedPairs: [["card-0", 0]],
      expectedPlaceholders: [],
      expectedLeftText: ["card-1"],
    },
    {
      name: "swap two scenes",
      original: "Alpha passage.\n\n***\n\nBeta passage.",
      current: "Beta passage.\n\n***\n\nAlpha passage.",
      cardPassageIndexes: [0, 1],
      expectedPairs: [["card-0", 1], ["card-1", 0]],
      expectedPlaceholders: [],
      expectedLeftText: [],
    },
    {
      name: "rewrite one scene opening",
      original: longScene("Old opening. ", " ending stays."),
      current: longScene("New opening. ", " ending stays."),
      cardPassageIndexes: [0],
      expectedPairs: [["card-0", 0]],
      expectedPlaceholders: [],
      expectedLeftText: [],
    },
    {
      name: "rewrite an opening and add a break elsewhere",
      original: `${longScene("Old opening. ", " first ending.")}\n\n***\n\n${longScene("Second opening. ", " second ending.")}`,
      current: `${longScene("New opening. ", " first ending.")}\n\n***\n\n${longScene("Second opening. ", " second ending.")}\n\n---\n\nThird passage.`,
      cardPassageIndexes: [0, 1],
      expectedPairs: [["card-0", 0], ["card-1", 1]],
      expectedPlaceholders: [2],
      expectedLeftText: [],
    },
    {
      name: "disambiguate identical openings with tails",
      original: `${longScene("Common opening. ", " first ending.")}\n\n***\n\n${longScene("Common opening. ", " second ending.")}`,
      current: `${longScene("Common opening. ", " first ending.")}\n\n***\n\n${longScene("Common opening. ", " second ending.")}`,
      cardPassageIndexes: [0, 1],
      expectedPairs: [["card-0", 0], ["card-1", 1]],
      expectedPlaceholders: [],
      expectedLeftText: [],
    },
    {
      name: "leave a new break near the top as a placeholder without shifting cards",
      original: longScene("Original opening. ", " ending."),
      current: `New uncarded passage.\n\n***\n\n${longScene("Original opening. ", " ending.")}`,
      cardPassageIndexes: [0],
      expectedPairs: [["card-0", 1]],
      expectedPlaceholders: [0],
      expectedLeftText: [],
    },
    {
      name: "leave all passages as placeholders when every card is planned",
      original: "A planned scene.",
      current: "A planned scene.",
      cardPassageIndexes: [],
      expectedPairs: [],
      expectedPlaceholders: [0],
      expectedLeftText: [],
    },
  ];

  it.each(cases)("$name", ({ original, current, cardPassageIndexes, expectedPairs, expectedPlaceholders, expectedLeftText }) => {
    const originalPassages = splitScenes(original);
    const cards = cardPassageIndexes.map((index) => cardFromPassage(`card-${index}`, originalPassages[index], index));
    if (cardPassageIndexes.length === 0) {
      cards.push({
        id: "planned",
        in_text: false,
        anchor_head: null,
        anchor_tail: null,
        position: 0,
      });
    }

    const result = matchScenes(splitScenes(current), cards);
    expect([...result.pairs.entries()].sort(([a], [b]) => a.localeCompare(b))).toEqual(
      [...expectedPairs].sort(([a], [b]) => a.localeCompare(b)),
    );
    expect(result.placeholders).toEqual(expectedPlaceholders);
    expect(result.leftText).toEqual(expectedLeftText);
  });
});

describe("arrangeText, takePassage, and insertPassage", () => {
  it("keeps each passage's break line when rearranging", () => {
    const text = "Alpha.\n\n***\n\nBeta.\n\n---\n\nGamma.\n";
    expect(arrangeText(text, splitScenes(text), [0, 2, 1])).toBe(
      "Alpha.\n\n---\n\nGamma.\n\n***\n\nBeta.\n",
    );
  });

  it("removes the new first break and gives the old first the usual break", () => {
    const text = "Alpha.\n\n---\n\nBeta.";
    expect(arrangeText(text, splitScenes(text), [1, 0])).toBe("Beta.\n\n---\n\nAlpha.");
  });

  it("uses *** when inserting into a chapter with no existing break style", () => {
    const text = "Alpha.";
    expect(insertPassage(text, splitScenes(text), "New scene.", 0)).toBe("New scene.\n\n***\n\nAlpha.");
  });

  it("uses the first break style when the chapter's styles are tied", () => {
    const text = "Alpha.\n\n---\n\nBeta.\n\n***\n\nGamma.";
    expect(arrangeText(text, splitScenes(text), [1, 2, 0])).toBe(
      "Beta.\n\n***\n\nGamma.\n\n---\n\nAlpha.",
    );
  });

  it("preserves identity order after normalizing spacing", () => {
    const text = " Alpha. \r\n\r\n***\r\n\r\n Beta. \r\n";
    const normalizedSpacing = (value: string) =>
      normalizeText(value).replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n+/g, "\n").trim();
    const passages = splitScenes(text);
    expect(normalizedSpacing(arrangeText(text, passages, passages.map((passage) => passage.index)))).toBe(
      normalizedSpacing(text),
    );
  });

  it("takes a passage while preserving the other break styles", () => {
    const text = "Alpha.\n\n***\n\nBeta.\n\n---\n\nGamma.\n";
    const result = takePassage(text, splitScenes(text), 1);
    expect(result.body.trim()).toBe("Beta.");
    expect(result.rest).toBe("Alpha.\n\n---\n\nGamma.\n");
  });

  it("inserts a passage using the chapter's usual break style", () => {
    const text = "Alpha.\n\n***\n\nBeta.\n";
    expect(insertPassage(text, splitScenes(text), "New scene.", 1)).toBe(
      "Alpha.\n\n***\n\nNew scene.\n\n***\n\nBeta.\n",
    );
  });

  it("inserts into an empty chapter without a break", () => {
    expect(insertPassage("", splitScenes(""), "New scene.\n", null)).toBe("New scene.\n");
  });
});
