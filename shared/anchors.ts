export interface TextAnchor {
  quote: string;
  prefix: string;
  suffix: string;
}

export function makeAnchor(text: string, from: number, to: number): TextAnchor {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > text.length || to <= from || to - from > 2000) {
    throw new RangeError("Choose a passage between 1 and 2,000 characters");
  }
  return {
    quote: text.slice(from, to),
    prefix: text.slice(Math.max(0, from - 32), from),
    suffix: text.slice(to, to + 32),
  };
}

const collapse = (text: string) => text.replace(/\s+/g, " ");

function match(text: string, anchor: TextAnchor): { from: number; to: number } | null | undefined {
  const first = text.indexOf(anchor.quote);
  if (first === -1) return undefined;
  if (text.indexOf(anchor.quote, first + 1) === -1) return { from: first, to: first + anchor.quote.length };

  let best = -1;
  let winner: number | null = null;
  for (let at = first; at !== -1; at = text.indexOf(anchor.quote, at + 1)) {
    let before = 0;
    while (before < anchor.prefix.length && at - before - 1 >= 0 &&
      text[at - before - 1] === anchor.prefix[anchor.prefix.length - before - 1]) before++;
    let after = 0;
    const end = at + anchor.quote.length;
    while (after < anchor.suffix.length && end + after < text.length &&
      text[end + after] === anchor.suffix[after]) after++;
    const score = before + after;
    if (score > best) {
      best = score;
      winner = at;
    } else if (score === best) {
      winner = null;
    }
  }
  return winner === null ? null : { from: winner, to: winner + anchor.quote.length };
}

function originalOffsets(text: string, from: number, to: number): { from: number; to: number } {
  let removed = 0;
  let originalFrom = from;
  let originalTo = to;
  for (const run of text.matchAll(/\s{2,}/g)) {
    const start = run.index - removed;
    if (start >= to) break;
    const extra = run[0].length - 1;
    if (start < from) originalFrom += extra;
    originalTo += extra;
    removed += extra;
  }
  return { from: originalFrom, to: originalTo };
}

/** Reuse the lazily normalized document while locating several notes on the same text. */
export function createAnchorMatcher(text: string): (anchor: TextAnchor) => { from: number; to: number } | null {
  let normalized: string | undefined;
  return (anchor) => {
    if (!anchor.quote || anchor.quote.length > 2000) return null;
    const exact = match(text, anchor);
    if (exact !== undefined) return exact;
    normalized ??= collapse(text);
    const found = match(normalized, {
      quote: collapse(anchor.quote),
      prefix: collapse(anchor.prefix),
      suffix: collapse(anchor.suffix),
    });
    return found ? originalOffsets(text, found.from, found.to) : null;
  };
}

export function findAnchor(text: string, anchor: TextAnchor): { from: number; to: number } | null {
  return createAnchorMatcher(text)(anchor);
}
