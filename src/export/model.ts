// A small, format-neutral model of a manuscript, parsed from each chapter's
// markdown. The Word and EPUB writers both render from this, so a book looks
// the same in either.

import { Lexer, type Token, type Tokens } from "marked";
import { stripLinks } from "../../shared/wikilinks";

export interface Run {
  text: string;
  italic?: boolean;
  bold?: boolean;
  strike?: boolean;
  code?: boolean;
  /** A hard line break (two spaces or a backslash at the end of a line). */
  br?: boolean;
}

export type Block =
  | { kind: "heading"; level: number; runs: Run[] }
  | { kind: "para"; runs: Run[]; style?: "quote" | "code" | "item" }
  | { kind: "break" }; // a scene break

export interface Chapter {
  title: string;
  /** Set on the first chapter of an act: the act's title, shown on a page of its own before it. */
  part?: string;
  blocks: Block[];
}

export interface Book {
  id: string;
  title: string;
  author: string;
  words: number;
  chapters: Chapter[];
}

type Style = Omit<Run, "text" | "br">;

function inline(tokens: Token[] | undefined, style: Style, out: Run[]) {
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "em":
        inline((t as Tokens.Em).tokens, { ...style, italic: !style.italic }, out);
        break;
      case "strong":
        inline((t as Tokens.Strong).tokens, { ...style, bold: true }, out);
        break;
      case "del":
        inline((t as Tokens.Del).tokens, { ...style, strike: true }, out);
        break;
      case "codespan":
        out.push({ ...style, code: true, text: (t as Tokens.Codespan).text });
        break;
      case "br":
        out.push({ text: "", br: true });
        break;
      case "link":
        inline((t as Tokens.Link).tokens, style, out);
        break;
      case "image":
        out.push({ ...style, text: (t as Tokens.Image).text });
        break;
      case "text": {
        const tt = t as Tokens.Text;
        if (tt.tokens?.length) inline(tt.tokens, style, out);
        // A single newline inside a paragraph is just a space.
        else out.push({ ...style, text: tt.text.replace(/\s*\n\s*/g, " ") });
        break;
      }
      default:
        // escape, html and anything unexpected: keep the characters as written.
        out.push({ ...style, text: "text" in t ? String(t.text) : t.raw });
    }
  }
}

const runsOf = (tokens: Token[] | undefined) => {
  const out: Run[] = [];
  inline(tokens, {}, out);
  return out;
};

export const plain = (runs: Run[]) => runs.map((r) => (r.br ? " " : r.text)).join("").trim();

function blocks(tokens: Token[], out: Block[], style?: "quote") {
  for (const t of tokens) {
    switch (t.type) {
      case "heading": {
        const runs = runsOf((t as Tokens.Heading).tokens);
        // An empty heading (a lone "#") is a common way to mark a scene break.
        out.push(plain(runs) ? { kind: "heading", level: (t as Tokens.Heading).depth, runs } : { kind: "break" });
        break;
      }
      case "paragraph":
        out.push({ kind: "para", runs: runsOf((t as Tokens.Paragraph).tokens), style });
        break;
      case "text": // loose text at block level, e.g. inside list items
        out.push({ kind: "para", runs: runsOf([t]), style });
        break;
      case "hr":
        out.push({ kind: "break" });
        break;
      case "blockquote":
        blocks((t as Tokens.Blockquote).tokens, out, "quote");
        break;
      case "list": {
        const list = t as Tokens.List;
        list.items.forEach((item, i) => {
          const marker = list.ordered ? `${Number(list.start || 1) + i}. ` : "• ";
          const inner: Block[] = [];
          blocks(item.tokens, inner);
          const first = inner.find((b) => b.kind === "para");
          if (first && first.kind === "para") first.runs.unshift({ text: marker });
          for (const b of inner) out.push(b.kind === "para" ? { ...b, style: "item" } : b);
        });
        break;
      }
      case "code":
        for (const line of (t as Tokens.Code).text.split("\n")) {
          out.push({ kind: "para", style: "code", runs: [{ text: line, code: true }] });
        }
        break;
      case "html":
        if ((t as Tokens.HTML).text.trim()) out.push({ kind: "para", runs: [{ text: (t as Tokens.HTML).text.trim() }], style });
        break;
      case "table": {
        const table = t as Tokens.Table;
        for (const row of [table.header, ...table.rows]) {
          out.push({ kind: "para", runs: [{ text: row.map((c) => c.text).join(" | ") }] });
        }
        break;
      }
      default:
        break; // space and the like
    }
  }
}

export function parseChapter(title: string, markdown: string): Chapter {
  const out: Block[] = [];
  // [[Mara|her]] reads as "her" in a finished book.
  blocks(Lexer.lex(stripLinks(markdown), { gfm: true }), out);
  // Many writers start a chapter with its own title as a heading; the export
  // adds the chapter title itself, so drop the duplicate.
  const first = out[0];
  if (first?.kind === "heading" && plain(first.runs).toLowerCase() === title.trim().toLowerCase()) out.shift();
  // Scene breaks at the very start or end of a chapter add nothing.
  while (out[0]?.kind === "break") out.shift();
  while (out[out.length - 1]?.kind === "break") out.pop();
  return { title, blocks: out };
}

export function slug(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, " ");
  return s || "Untitled";
}

/**
 * The act title to show before each chapter: set on the first chapter of
 * each act, undefined elsewhere. Chapters must be in book order.
 */
export function partTitles(chapters: { act_id?: string | null }[], acts: { id: string; title: string }[]): (string | undefined)[] {
  const title = new Map(acts.map((a) => [a.id, a.title]));
  return chapters.map((c, i) => {
    const act = c.act_id && title.has(c.act_id) ? c.act_id : null;
    const prev = i > 0 ? chapters[i - 1].act_id : null;
    return act && act !== prev ? title.get(act) : undefined;
  });
}

/** "about 82,000 words", rounded the way manuscripts state length. */
export function aboutWords(n: number): string {
  if (n < 1000) return `${n.toLocaleString("en-US")} words`;
  const step = n < 10000 ? 100 : 1000;
  return `about ${(Math.round(n / step) * step).toLocaleString("en-US")} words`;
}
