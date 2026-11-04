// [[Name]] and [[Name|shown text]] links from chapters to story bible entries.

import type { BibleEntry } from "./types";

/** Matches one link. Group 1 is the entry name, group 2 the optional shown text. */
export const WIKILINK = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]/g;

export interface Link {
  name: string;
  shown: string;
  from: number;
  to: number;
}

export function findLinks(text: string): Link[] {
  const out: Link[] = [];
  for (const m of text.matchAll(WIKILINK)) {
    const name = m[1].trim();
    if (!name) continue;
    out.push({ name, shown: (m[2] ?? m[1]).trim(), from: m.index!, to: m.index! + m[0].length });
  }
  return out;
}

/** The text a reader should see: [[Mara|her]] becomes "her", [[Mara]] becomes "Mara". */
export const stripLinks = (text: string) => text.replace(WIKILINK, (_m, name: string, shown?: string) => (shown ?? name).trim());

export const linkKey = (name: string) => name.trim().toLowerCase();

/** Every name and alias, lowercased, mapped to its entry. */
export function entryIndex(entries: BibleEntry[]): Map<string, BibleEntry> {
  const map = new Map<string, BibleEntry>();
  for (const e of entries) {
    map.set(linkKey(e.name), e);
    for (const a of e.aliases) if (!map.has(linkKey(a))) map.set(linkKey(a), e);
  }
  return map;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Entries a text links to with [[...]] or names in running text (by name or
 * alias, as whole words, ignoring case), in the order they first appear.
 */
export function entriesMentioned(text: string, entries: BibleEntry[]): BibleEntry[] {
  const index = entryIndex(entries);
  const found = new Map<string, { entry: BibleEntry; at: number }>();
  const note = (e: BibleEntry | undefined, at: number) => {
    if (e && (!found.has(e.id) || found.get(e.id)!.at > at)) found.set(e.id, { entry: e, at });
  };
  for (const l of findLinks(text)) note(index.get(linkKey(l.name)), l.from);
  const names = [...index.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  if (names.length) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escapeRe).join("|")})(?![\\p{L}\\p{N}])`, "giu");
    for (const m of text.matchAll(re)) note(index.get(m[0].toLowerCase()), m.index!);
  }
  return [...found.values()].sort((a, b) => a.at - b.at).map((f) => f.entry);
}
