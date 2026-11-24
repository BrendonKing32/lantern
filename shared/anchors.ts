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

function collapse(text: string): { text: string; starts: number[]; ends: number[] } {
  let result = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (/\s/.test(text[i])) {
      if (i > 0 && /\s/.test(text[i - 1])) {
        ends[ends.length - 1] = i + 1;
        continue;
      }
      result += " ";
    } else {
      result += text[i];
    }
    starts.push(i);
    ends.push(i + 1);
  }
  return { text: result, starts, ends };
}

function match(text: string, anchor: TextAnchor): { from: number; to: number } | null | undefined {
  const positions: number[] = [];
  for (let at = text.indexOf(anchor.quote); at !== -1; at = text.indexOf(anchor.quote, at + 1)) {
    positions.push(at);
  }
  if (!positions.length) return undefined;
  if (positions.length === 1) return { from: positions[0], to: positions[0] + anchor.quote.length };

  let best = -1;
  let winner: number | null = null;
  for (const at of positions) {
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

export function findAnchor(text: string, anchor: TextAnchor): { from: number; to: number } | null {
  if (!anchor.quote || anchor.quote.length > 2000) return null;
  const exact = match(text, anchor);
  if (exact !== undefined) return exact;
  const normalized = collapse(text);
  const found = match(normalized.text, {
    quote: collapse(anchor.quote).text,
    prefix: collapse(anchor.prefix).text,
    suffix: collapse(anchor.suffix).text,
  });
  return found ? { from: normalized.starts[found.from], to: normalized.ends[found.to - 1] } : null;
}
