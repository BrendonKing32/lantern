import { Lexer, type Token, type Tokens } from "marked";
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

/** Line endings normalized to "\n". All offsets refer to this string. */
export function normalizeText(markdown: string): string {
  return markdown.replace(/\r\n?/g, "\n");
}

/** Compare plain heading text using the same rule as chapter export. */
export function isChapterTitle(headingText: string, chapterTitle: string): boolean {
  return stripLinks(headingText).trim().toLowerCase() === chapterTitle.trim().toLowerCase();
}

export function normalizeAnchor(prose: string): string {
  return stripLinks(prose)
    .replace(/[#>*_`~]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function inlineText(tokens: Token[] | undefined): string {
  let text = "";
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "em":
        text += inlineText((token as Tokens.Em).tokens);
        break;
      case "strong":
        text += inlineText((token as Tokens.Strong).tokens);
        break;
      case "del":
        text += inlineText((token as Tokens.Del).tokens);
        break;
      case "link":
        text += inlineText((token as Tokens.Link).tokens);
        break;
      case "codespan":
        text += (token as Tokens.Codespan).text;
        break;
      case "image":
        text += (token as Tokens.Image).text;
        break;
      case "br":
        text += " ";
        break;
      case "text": {
        const value = token as Tokens.Text;
        text += value.tokens?.length ? inlineText(value.tokens) : value.text.replace(/\s*\n\s*/g, " ");
        break;
      }
      default:
        text += "text" in token ? String(token.text) : token.raw;
    }
  }
  return text;
}

function firstProse(tokens: Token[]): string {
  for (const token of tokens) {
    switch (token.type) {
      case "paragraph": {
        const text = inlineText((token as Tokens.Paragraph).tokens);
        if (text.trim()) return text;
        break;
      }
      case "text": {
        const text = inlineText([token]);
        if (text.trim()) return text;
        break;
      }
      case "blockquote": {
        const text = firstProse((token as Tokens.Blockquote).tokens);
        if (text) return text;
        break;
      }
      case "list":
        for (const item of (token as Tokens.List).items) {
          const text = firstProse(item.tokens);
          if (text) return text;
        }
        break;
      default:
        break;
    }
  }
  return "";
}

function excerptOf(body: string): string {
  return stripLinks(firstProse(new Lexer().lex(body))).replace(/\s+/g, " ").trim().slice(0, 120);
}

function makePassage(
  index: number,
  breakStart: number | null,
  breakLine: string | null,
  start: number,
  end: number,
  body: string,
  anchorBody = body,
): Passage {
  const anchor = normalizeAnchor(anchorBody);
  return {
    index,
    breakStart,
    breakLine,
    start,
    end,
    words: countWords(body),
    head: anchor.slice(0, 160),
    tail: anchor.slice(-160),
    excerpt: excerptOf(anchorBody),
  };
}

interface PositionedToken {
  token: Token;
  start: number;
}

export function splitScenes(markdown: string, chapterTitle?: string): Passage[] {
  const text = normalizeText(markdown);
  const positioned: PositionedToken[] = [];
  let offset = 0;
  const tokens = new Lexer().lex(text);
  for (const token of tokens) {
    positioned.push({ token, start: offset });
    offset += token.raw.length;
  }

  if (offset !== text.length || tokens.map((token) => token.raw).join("") !== text) {
    console.warn("Could not map marked tokens to chapter text; treating it as one passage.");
    return [makePassage(0, null, null, 0, text.length, text)];
  }

  const breaks = positioned.filter(
    ({ token }) =>
      token.type === "hr" ||
      (token.type === "heading" && (token as Tokens.Heading).text.trim() === ""),
  );
  const passages: Passage[] = [];
  let start = 0;
  let openingBreak: { start: number; line: string } | null = null;

  const pushPassage = (end: number) => {
    const body = text.slice(start, end);
    let anchorBody = body;
    if (passages.length === 0 && chapterTitle !== undefined) {
      const first = positioned.find(
        ({ token, start: tokenStart }) => token.type !== "space" && tokenStart >= start && tokenStart < end,
      );
      if (first?.token.type === "heading") {
        const headingText = inlineText((first.token as Tokens.Heading).tokens);
        if (isChapterTitle(headingText, chapterTitle)) {
          const relativeStart = first.start - start;
          anchorBody = body.slice(0, relativeStart) + body.slice(relativeStart + first.token.raw.length);
        }
      }
    }
    passages.push(
      makePassage(
        passages.length,
        openingBreak?.start ?? null,
        openingBreak?.line ?? null,
        start,
        end,
        body,
        anchorBody,
      ),
    );
  };

  for (const { token, start: breakOffset } of breaks) {
    pushPassage(breakOffset);
    start = breakOffset + token.raw.length;
    if (!token.raw.endsWith("\n") && text[start] === "\n") start++;
    openingBreak = { start: breakOffset, line: token.raw.trim() };
  }
  pushPassage(text.length);
  return passages;
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

export function matchScenes(passages: Passage[], cards: MatchCard[]): MatchResult {
  const inTextCards = cards.filter((card) => card.in_text);
  const pairs = new Map<string, number>();
  const pairedPassages = new Set<number>();
  const pairedCards = new Set<string>();

  const pairUniqueAnchors = (field: "head" | "tail", cardField: "anchor_head" | "anchor_tail") => {
    const passageCounts = new Map<string, number>();
    for (const passage of passages) {
      if (pairedPassages.has(passage.index)) continue;
      const value = passage[field];
      if (value) passageCounts.set(value, (passageCounts.get(value) ?? 0) + 1);
    }

    const cardCounts = new Map<string, number>();
    for (const card of inTextCards) {
      if (pairedCards.has(card.id)) continue;
      const value = card[cardField];
      if (value) cardCounts.set(value, (cardCounts.get(value) ?? 0) + 1);
    }

    const uniqueCards = new Map<string, MatchCard>();
    for (const card of inTextCards) {
      if (pairedCards.has(card.id)) continue;
      const value = card[cardField];
      if (value && cardCounts.get(value) === 1) uniqueCards.set(value, card);
    }

    for (const passage of passages) {
      if (pairedPassages.has(passage.index)) continue;
      const value = passage[field];
      if (!value || passageCounts.get(value) !== 1) continue;
      const card = uniqueCards.get(value);
      if (!card || pairedCards.has(card.id)) continue;
      pairs.set(card.id, passage.index);
      pairedPassages.add(passage.index);
      pairedCards.add(card.id);
    }
  };

  pairUniqueAnchors("head", "anchor_head");
  pairUniqueAnchors("tail", "anchor_tail");

  const anchored = [...pairs.entries()]
    .map(([cardId, passageIndex]) => ({
      passageIndex,
      position: inTextCards.find((card) => card.id === cardId)!.position,
    }))
    .sort((a, b) => a.passageIndex - b.passageIndex);
  const gaps: { before: (typeof anchored)[number] | null; after: (typeof anchored)[number] | null }[] = [];
  if (anchored.length === 0) {
    gaps.push({ before: null, after: null });
  } else {
    gaps.push({ before: null, after: anchored[0] });
    for (let i = 1; i < anchored.length; i++) gaps.push({ before: anchored[i - 1], after: anchored[i] });
    gaps.push({ before: anchored[anchored.length - 1], after: null });
  }

  for (const gap of gaps) {
    if (gap.before && gap.after && gap.before.position > gap.after.position) continue;
    const lowPassage = gap.before?.passageIndex ?? -1;
    const highPassage = gap.after?.passageIndex ?? Number.POSITIVE_INFINITY;
    const unpairedPassages = passages
      .filter((passage) => !pairedPassages.has(passage.index) && passage.index > lowPassage && passage.index < highPassage)
      .sort((a, b) => a.index - b.index);
    const lowPosition = gap.before?.position ?? Number.NEGATIVE_INFINITY;
    const highPosition = gap.after?.position ?? Number.POSITIVE_INFINITY;
    const unpairedCards = inTextCards
      .filter((card) => !pairedCards.has(card.id) && card.position > lowPosition && card.position < highPosition)
      .sort((a, b) => a.position - b.position);

    if (unpairedPassages.length === 0 || unpairedPassages.length !== unpairedCards.length) continue;
    for (let i = 0; i < unpairedPassages.length; i++) {
      pairs.set(unpairedCards[i].id, unpairedPassages[i].index);
      pairedCards.add(unpairedCards[i].id);
      pairedPassages.add(unpairedPassages[i].index);
    }
  }

  return {
    pairs,
    placeholders: passages
      .filter((passage) => !pairedPassages.has(passage.index))
      .map((passage) => passage.index)
      .sort((a, b) => a - b),
    leftText: inTextCards.filter((card) => !pairedCards.has(card.id)).map((card) => card.id),
  };
}

interface PassagePiece {
  body: string;
  breakLine: string | null;
  wasFirst?: boolean;
  isNew?: boolean;
}

function usualBreak(passages: Passage[]): string {
  const counts = new Map<string, number>();
  for (const passage of passages) {
    if (passage.breakLine) counts.set(passage.breakLine, (counts.get(passage.breakLine) ?? 0) + 1);
  }
  let mostCommon = "***";
  let max = 0;
  for (const passage of passages) {
    const line = passage.breakLine;
    if (!line) continue;
    const count = counts.get(line)!;
    if (count > max) {
      mostCommon = line;
      max = count;
    }
  }
  return mostCommon;
}

function renderPieces(pieces: PassagePiece[], breakLine: string, endedWithNewline: boolean): string {
  if (pieces.length === 0) return "";
  let result = pieces[0].body.trim();
  for (let i = 1; i < pieces.length; i++) {
    const piece = pieces[i];
    const line = piece.wasFirst || piece.isNew ? breakLine : piece.breakLine ?? breakLine;
    result += `\n\n${line}\n\n${piece.body.trim()}`;
  }
  result = result.replace(/\n+$/, "");
  return endedWithNewline ? `${result}\n` : result;
}

function passageMap(passages: Passage[]): Map<number, Passage> {
  return new Map(passages.map((passage) => [passage.index, passage]));
}

function bodyOf(text: string, passage: Passage): string {
  return text.slice(passage.start, passage.end);
}

function piecesInOrder(text: string, passages: Passage[], order: number[]): PassagePiece[] {
  const byIndex = passageMap(passages);
  if (
    order.length !== passages.length ||
    new Set(order).size !== order.length ||
    order.some((index) => !byIndex.has(index)) ||
    byIndex.size !== passages.length
  ) {
    throw new RangeError("Passage order must be a permutation of the passage indexes.");
  }
  return order.map((index) => {
    const passage = byIndex.get(index)!;
    return {
      body: bodyOf(text, passage),
      breakLine: passage.breakLine,
      wasFirst: index === 0,
    };
  });
}

/**
 * Rebuild a chapter with its passages in a new order.
 * `order` is a permutation of passage indexes. Returns normalized text.
 */
export function arrangeText(text: string, passages: Passage[], order: number[]): string {
  const normalized = normalizeText(text);
  return renderPieces(
    piecesInOrder(normalized, passages, order),
    usualBreak(passages),
    normalized.endsWith("\n"),
  );
}

/** Remove passage `index` from a chapter. Returns the remaining text and the removed body. */
export function takePassage(
  text: string,
  passages: Passage[],
  index: number,
): { rest: string; body: string } {
  const normalized = normalizeText(text);
  const passage = passageMap(passages).get(index);
  if (!passage) throw new RangeError(`No passage at index ${index}.`);
  return {
    rest: renderPieces(
      passages
        .filter((candidate) => candidate.index !== index)
        .map((candidate) => ({
          body: bodyOf(normalized, candidate),
          breakLine: candidate.breakLine,
          wasFirst: candidate.index === 0,
        })),
      usualBreak(passages),
      normalized.endsWith("\n"),
    ),
    body: bodyOf(normalized, passage),
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
  const normalizedBody = normalizeText(body);
  const byIndex = passageMap(passages);
  if (beforeIndex !== null && !byIndex.has(beforeIndex)) {
    throw new RangeError(`No passage at index ${beforeIndex}.`);
  }
  if (!normalized.trim()) return normalizedBody;

  const order = passages.map((passage) => passage.index);
  const insertionIndex = beforeIndex === null ? order.length : order.indexOf(beforeIndex);
  order.splice(insertionIndex, 0, -1);
  const pieces: PassagePiece[] = order.map((index) => {
    if (index === -1) return { body: normalizedBody, breakLine: null, isNew: true };
    const passage = byIndex.get(index)!;
    return {
      body: bodyOf(normalized, passage),
      breakLine: passage.breakLine,
      wasFirst: index === 0,
    };
  });

  return renderPieces(pieces, usualBreak(passages), normalized.endsWith("\n"));
}
