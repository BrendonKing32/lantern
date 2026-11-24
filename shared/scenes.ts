import { Lexer, type Token } from "marked";
import { countWords } from "./wordcount";
import { stripLinks } from "./wikilinks";

export interface Passage {
  /** 0-based order within the chapter. */
  index: number;
  /** Offset of the break line that opens this passage in the normalized text; null for the first passage. */
  breakStart: number | null;
  /** The break line as written, trimmed (e.g. "***", "* * *", "---", "#"); null for the first passage. */
  breakLine: string | null;
  /** Offset where the passage body starts (just after the break line's newline; 0 for the first). */
  start: number;
  /** Offset after a matching chapter-title heading and its following blank lines, or `start`. */
  lead: number;
  /** Offset (exclusive) where the next break line starts, or the text length. */
  end: number;
  /** countWords() of the body. */
  words: number;
  /** Normalized anchors (see 4.2). Empty string when the body has no prose. */
  head: string;
  tail: string;
  /** Up to 120 characters of the body's first prose, plain text, for display. */
  excerpt: string;
}

export interface MatchCard {
  id: string;
  in_text: boolean;
  anchor_head: string | null;
  anchor_tail: string | null;
  /** Current order among the chapter's cards. */
  position: number;
}

export interface MatchResult {
  /** cardId → passage index, for every card that ends up in the text. */
  pairs: Map<string, number>;
  /** Passage indexes with no card (placeholders), ascending. */
  placeholders: number[];
  /** Ids of cards that were in the text before this match and aren't now. */
  leftText: string[];
}

interface PassageBreak {
  offset: number;
  start: number;
  line: string;
}

let warnedAboutTokenMismatch = false;

export function normalizeText(markdown: string): string {
  return markdown.replace(/\r\n?/g, "\n");
}

function inlineText(tokens: Token[] | undefined): string {
  return (tokens ?? []).map((token) => {
    switch (token.type) {
      case "text":
        return token.tokens?.length ? inlineText(token.tokens) : token.text;
      case "strong":
      case "em":
      case "del":
      case "link":
        return inlineText(token.tokens);
      case "codespan":
      case "image":
      case "escape":
        return token.text;
      case "br":
        return " ";
      default:
        return "text" in token ? String(token.text) : "";
    }
  }).join("");
}

function firstProse(tokens: Token[]): string {
  for (const token of tokens) {
    if (token.type === "paragraph" || token.type === "heading" || token.type === "text") {
      const prose = inlineText("tokens" in token && token.tokens ? token.tokens : [token]).trim();
      if (prose) return prose;
    }
    if (token.type === "blockquote") {
      const prose = firstProse(token.tokens ?? []);
      if (prose) return prose;
    }
    if (token.type === "list") {
      for (const item of token.items) {
        const prose = firstProse(item.tokens ?? []);
        if (prose) return prose;
      }
    }
    if (token.type === "table") {
      const prose = [...token.header, ...token.rows.flat()].map((cell) => cell.text).join(" ");
      if (prose.trim()) return prose;
    }
  }
  return "";
}

export function normalizeAnchor(prose: string): string {
  return stripLinks(prose)
    .replace(/[#>*_`~]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function headingText(token: Token): string {
  const parsed = new Lexer().lex(stripLinks(token.raw));
  const heading = parsed.find((part) => part.type === "heading");
  return heading?.type === "heading" ? inlineText(heading.tokens).trim() : "";
}

function makePassage(
  text: string,
  index: number,
  start: number,
  end: number,
  breakStart: number | null,
  breakLine: string | null,
  ignoredHeading?: { start: number; end: number },
  lead = start,
): Passage {
  const body = text.slice(start, end);
  const proseBody = ignoredHeading
    ? body.slice(0, ignoredHeading.start - start) + body.slice(ignoredHeading.end - start)
    : body;
  const anchor = normalizeAnchor(proseBody);
  const proseTokens = new Lexer().lex(stripLinks(proseBody));
  return {
    index,
    breakStart,
    breakLine,
    start,
    lead,
    end,
    words: countWords(body),
    head: anchor.slice(0, 160),
    tail: anchor.slice(-160),
    excerpt: firstProse(proseTokens).slice(0, 120),
  };
}

function fallbackPassage(text: string): Passage[] {
  if (!warnedAboutTokenMismatch) {
    warnedAboutTokenMismatch = true;
    console.warn("Could not split chapter text because marked tokens did not match the source");
  }
  return [makePassage(text, 0, 0, text.length, null, null)];
}

export function splitScenes(markdown: string, chapterTitle?: string): Passage[] {
  const text = normalizeText(markdown);
  const tokens = new Lexer().lex(text);
  if (tokens.map((token) => token.raw).join("") !== text) return fallbackPassage(text);

  const breaks: PassageBreak[] = [];
  let offset = 0;
  let titleHeading: { start: number; end: number } | undefined;
  let titleLead: number | undefined;
  let foundFirstBlock = false;

  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
    const token = tokens[tokenIndex];
    if (!foundFirstBlock && token.type !== "space") {
      foundFirstBlock = true;
      if (
        chapterTitle !== undefined &&
        token.type === "heading" &&
        headingText(token).toLowerCase() === chapterTitle.trim().toLowerCase()
      ) {
        titleHeading = { start: offset, end: offset + token.raw.length };
        titleLead = offset + token.raw.length;
        for (let following = tokenIndex + 1; tokens[following]?.type === "space"; following++) {
          titleLead += tokens[following].raw.length;
        }
      }
    }
    if (token.type === "hr" || (token.type === "heading" && token.text.trim() === "")) {
      const rawEnd = offset + token.raw.length;
      breaks.push({
        offset,
        start: rawEnd + (text[rawEnd] === "\n" ? 1 : 0),
        line: token.raw.trim(),
      });
    }
    offset += token.raw.length;
  }

  const passages: Passage[] = [];
  let start = 0;
  let breakStart: number | null = null;
  let breakLine: string | null = null;
  for (let index = 0; index <= breaks.length; index++) {
    const nextBreak = breaks[index];
    const end = nextBreak?.offset ?? text.length;
    passages.push(makePassage(
      text,
      index,
      start,
      end,
      breakStart,
      breakLine,
      index === 0 ? titleHeading : undefined,
      index === 0 ? titleLead : undefined,
    ));
    if (nextBreak) {
      start = nextBreak.start;
      breakStart = nextBreak.offset;
      breakLine = nextBreak.line;
    }
  }
  return passages;
}

function usualBreak(passages: Passage[]): string {
  const counts = new Map<string, number>();
  let mostUsed = "***";
  let maximum = 0;
  for (const passage of passages) {
    if (!passage.breakLine) continue;
    const count = (counts.get(passage.breakLine) ?? 0) + 1;
    counts.set(passage.breakLine, count);
    if (count > maximum) {
      maximum = count;
      mostUsed = passage.breakLine;
    }
  }
  return mostUsed;
}

function passageBodies(text: string, passages: Passage[]): string[] {
  return passages.map((passage, index) =>
    text.slice(index === 0 ? passage.lead : passage.start, passage.end),
  );
}

function renderPassages(
  bodies: string[],
  breakLines: Array<string | null>,
  originalEndedWithNewline: boolean,
  prefix = "",
): string {
  if (bodies.length === 0) {
    return prefix ? prefix.trimEnd() + (originalEndedWithNewline ? "\n" : "") : "";
  }
  const firstBody = bodies[0].trimStart();
  let text = prefix
    ? `${prefix.trimEnd()}${firstBody ? `\n\n${firstBody}` : ""}`
    : firstBody;
  for (let index = 1; index < bodies.length; index++) {
    const line = breakLines[index] ?? "***";
    text = `${text.trimEnd()}\n\n${line}\n\n${bodies[index].trimStart()}`;
  }
  return text.replace(/\n+$/, "") + (originalEndedWithNewline ? "\n" : "");
}

function validateOrder(passages: Passage[], order: number[]): void {
  if (
    order.length !== passages.length ||
    new Set(order).size !== passages.length ||
    order.some((index) => !Number.isInteger(index) || index < 0 || index >= passages.length)
  ) {
    throw new RangeError("order must be a permutation of passage indexes");
  }
}

/**
 * Rebuild a chapter with its passages in a new order.
 * `order` is a permutation of passage indexes. Returns normalized text.
 */
export function arrangeText(text: string, passages: Passage[], order: number[]): string {
  const normalized = normalizeText(text);
  validateOrder(passages, order);
  const prefix = passages[0]?.lead > passages[0]?.start
    ? normalized.slice(0, passages[0].lead)
    : "";
  const bodies = passageBodies(normalized, passages);
  const breakStyle = usualBreak(passages);
  const arrangedBodies = order.map((index) => bodies[index]);
  const breakLines: Array<string | null> = [null];
  for (let index = 1; index < order.length; index++) {
    const passage = passages[order[index]];
    breakLines.push(passage.breakLine ?? breakStyle);
  }
  return renderPassages(arrangedBodies, breakLines, normalized.endsWith("\n"), prefix);
}

function validatePassageIndex(passages: Passage[], index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= passages.length) {
    throw new RangeError("passage index is out of range");
  }
}

/** Remove passage `index` from a chapter. Returns the remaining text and the removed body. */
export function takePassage(
  text: string,
  passages: Passage[],
  index: number,
): { rest: string; body: string } {
  const normalized = normalizeText(text);
  validatePassageIndex(passages, index);
  const prefix = passages[0].lead > passages[0].start
    ? normalized.slice(0, passages[0].lead)
    : "";
  const bodies = passageBodies(normalized, passages);
  const removed = bodies[index].trim();
  const remaining = passages
    .map((passage, passageIndex) => ({ passage, body: bodies[passageIndex], passageIndex }))
    .filter((entry) => entry.passageIndex !== index);
  return {
    rest: renderPassages(
      remaining.map((entry) => entry.body),
      remaining.map((entry, remainingIndex) => remainingIndex === 0 ? null : entry.passage.breakLine),
      normalized.endsWith("\n"),
      prefix,
    ),
    body: removed,
  };
}

/** Insert a body as a new passage before passage `beforeIndex` (or at the end when null). */
export function insertPassage(
  text: string,
  passages: Passage[],
  body: string,
  beforeIndex: number | null,
): string {
  const normalized = normalizeText(text);
  if (beforeIndex !== null) validatePassageIndex(passages, beforeIndex);
  if (!normalized.trim()) return normalizeText(body);

  const prefix = passages[0]?.lead > passages[0]?.start
    ? normalized.slice(0, passages[0].lead)
    : "";
  const bodies = passageBodies(normalized, passages);
  const breakStyle = usualBreak(passages);
  const insertionIndex = beforeIndex ?? passages.length;
  bodies.splice(insertionIndex, 0, normalizeText(body));
  const breakLines: Array<string | null> = [null];
  for (let index = 1; index < bodies.length; index++) {
    if (index === insertionIndex) {
      breakLines.push(breakStyle);
    } else {
      const originalIndex = index < insertionIndex ? index : index - 1;
      breakLines.push(passages[originalIndex]?.breakLine ?? breakStyle);
    }
  }
  return renderPassages(bodies, breakLines, normalized.endsWith("\n"), prefix);
}

export function matchScenes(passages: Passage[], cards: MatchCard[]): MatchResult {
  const activeCards = cards.filter((card) => card.in_text);
  const pairs = new Map<string, number>();
  const pairedPassages = new Set<number>();
  const pairedCards = new Set<string>();

  const pairUniqueAnchors = (
    cardAnchor: (card: MatchCard) => string | null,
    passageAnchor: (passage: Passage) => string,
  ) => {
    const passageCounts = new Map<string, number>();
    const cardCounts = new Map<string, number>();
    for (const passage of passages) {
      if (pairedPassages.has(passage.index)) continue;
      const anchor = passageAnchor(passage);
      if (anchor) passageCounts.set(anchor, (passageCounts.get(anchor) ?? 0) + 1);
    }
    for (const card of activeCards) {
      if (pairedCards.has(card.id)) continue;
      const anchor = cardAnchor(card);
      if (anchor) cardCounts.set(anchor, (cardCounts.get(anchor) ?? 0) + 1);
    }
    for (const card of activeCards) {
      if (pairedCards.has(card.id)) continue;
      const anchor = cardAnchor(card);
      if (!anchor || cardCounts.get(anchor) !== 1 || passageCounts.get(anchor) !== 1) continue;
      const passage = passages.find((candidate) =>
        !pairedPassages.has(candidate.index) && passageAnchor(candidate) === anchor,
      );
      if (passage && !pairedPassages.has(passage.index)) {
        pairs.set(card.id, passage.index);
        pairedCards.add(card.id);
        pairedPassages.add(passage.index);
      }
    }
  };

  pairUniqueAnchors((card) => card.anchor_head, (passage) => passage.head);
  pairUniqueAnchors((card) => card.anchor_tail, (passage) => passage.tail);

  const anchored = [...pairs.entries()]
    .map(([cardId, passageIndex]) => ({
      passageIndex,
      position: activeCards.find((card) => card.id === cardId)!.position,
    }))
    .sort((a, b) => a.passageIndex - b.passageIndex);
  const boundaries: Array<{ passageIndex: number; position: number } | null> = [null, ...anchored, null];
  for (let gap = 0; gap < boundaries.length - 1; gap++) {
    const before = boundaries[gap];
    const after = boundaries[gap + 1];
    if (before && after && before.position >= after.position) continue;

    const gapPassages = passages
      .filter((passage) =>
        !pairedPassages.has(passage.index) &&
        passage.index > (before?.passageIndex ?? -1) &&
        passage.index < (after?.passageIndex ?? passages.length),
      )
      .sort((a, b) => a.index - b.index);
    const gapCards = activeCards
      .filter((card) =>
        !pairedCards.has(card.id) &&
        card.position > (before?.position ?? -Infinity) &&
        card.position < (after?.position ?? Infinity),
      )
      .sort((a, b) => a.position - b.position);
    if (gapPassages.length === 0 || gapPassages.length !== gapCards.length) continue;
    for (let index = 0; index < gapPassages.length; index++) {
      pairs.set(gapCards[index].id, gapPassages[index].index);
      pairedCards.add(gapCards[index].id);
      pairedPassages.add(gapPassages[index].index);
    }
  }

  return {
    pairs,
    placeholders: passages
      .filter((passage) => !pairedPassages.has(passage.index))
      .map((passage) => passage.index)
      .sort((a, b) => a - b),
    leftText: activeCards.filter((card) => !pairedCards.has(card.id)).map((card) => card.id),
  };
}
