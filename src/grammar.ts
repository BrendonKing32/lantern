// Grammar and spelling checks in the editor, powered by Harper
// (https://writewithharper.com). Harper runs entirely on this device in a web
// worker, so chapter text never leaves the browser for these checks.
//
// The checker is loaded the first time a chapter is checked: the WebAssembly
// binary is large (~20 MB), so it's kept out of the main bundle, and the
// service worker keeps a copy after the first download.

import { forceLinting, linter, type Action, type Diagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import type { Lint, WorkerLinter } from "harper.js";
import { findLinks } from "../shared/wikilinks";
import type { BibleEntry } from "../shared/types";

const DICTIONARY_KEY = "lantern-dictionary";
const IGNORED_KEY = "lantern-grammar-ignored";
const ENABLED_KEY = "lantern-grammar";

/** Harper rules that don't suit fiction. */
const RULES_OFF = [
  "UseTitleCase", // chapter headings needn't be in title case
];

/** Most suggestions offered for one problem. */
const MAX_SUGGESTIONS = 3;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or blocked: the word still counts for this session.
  }
}

/** Whether grammar checking is on for this device. On unless turned off. */
export function grammarEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setGrammarEnabled(on: boolean) {
  try {
    localStorage.setItem(ENABLED_KEY, on ? "on" : "off");
  } catch {
    // Not remembered, but still applies until the page closes.
  }
}

let harper: Promise<WorkerLinter> | null = null;

/** The shared Harper instance, started on first use. */
function loadHarper(): Promise<WorkerLinter> {
  harper ??= (async () => {
    const [{ WorkerLinter, Dialect, createBinaryModuleFromUrl }, { binary: bundled }] = await Promise.all([
      import("harper.js"),
      import("harper.js/binary"),
    ]);
    // Both this page and the linter's worker load the binary. Loading it here
    // first lets the worker take it from the cache instead of downloading the
    // same 20 MB at the same moment. A fresh module each attempt, so a failed
    // download isn't remembered.
    const binary = createBinaryModuleFromUrl(String(bundled.url), "full");
    await binary.setup();
    const h = new WorkerLinter({ binary, dialect: Dialect.American });
    await h.setup();

    const config = await h.getLintConfig();
    for (const rule of RULES_OFF) if (rule in config) config[rule] = false;
    await h.setLintConfig(config);

    const words = readJson<string[]>(DICTIONARY_KEY, []);
    if (words.length) await h.importWords(words);
    const ignored = readJson<string | null>(IGNORED_KEY, null);
    if (ignored) await h.importIgnoredLints(ignored).catch(() => {});
    return h;
  })();
  // A failed download can be retried on the next check.
  harper.catch(() => {
    harper = null;
  });
  return harper;
}

async function addToDictionary(word: string) {
  const h = await loadHarper();
  const words = readJson<string[]>(DICTIONARY_KEY, []);
  if (!words.includes(word)) writeJson(DICTIONARY_KEY, [...words, word]);
  await h.importWords([word]);
}

async function ignore(source: string, lint: Lint) {
  const h = await loadHarper();
  await h.ignoreLint(source, lint);
  writeJson(IGNORED_KEY, await h.exportIgnoredLints());
}

/** Lowercased words from the story bible's names and aliases, which are never misspellings. */
function bibleWords(entries: BibleEntry[]): Set<string> {
  const words = new Set<string>();
  for (const e of entries) {
    for (const name of [e.name, ...e.aliases]) {
      for (const w of name.toLowerCase().split(/[^\p{L}\p{N}'’-]+/u)) if (w) words.add(w);
    }
  }
  return words;
}

const SPELLING = new Set(["Spelling", "Typo"]);
const STYLE = new Set(["Style", "Readability", "Enhancement", "Redundancy", "Repetition", "Formatting"]);

function category(kind: string): "spelling" | "grammar" | "style" {
  if (SPELLING.has(kind)) return "spelling";
  if (STYLE.has(kind)) return "style";
  return "grammar";
}

export interface GrammarHost {
  /** The novel's bible entries, read fresh on each check. */
  entries: () => BibleEntry[];
}

/** A CodeMirror extension that underlines Harper's findings and offers its fixes. */
export function grammar(host: GrammarHost) {
  return linter(
    async (view) => {
      const source = view.state.doc.toString();
      if (!source.trim()) return [];
      let h: WorkerLinter;
      try {
        h = await loadHarper();
      } catch (e) {
        console.warn("Lantern couldn't start the grammar checker", e);
        return [];
      }
      const lints = await h.lint(source, { language: "markdown" });
      const names = bibleWords(host.entries());
      const links = findLinks(source);

      const out: Diagnostic[] = [];
      for (const lint of lints) {
        const { start: from, end: to } = lint.span();
        const kind = lint.lint_kind();
        const problem = lint.get_problem_text();
        const cat = category(kind);
        // Names from the story bible, and [[links]] to it, aren't errors.
        if (cat === "spelling" && names.has(problem.toLowerCase())) continue;
        if (links.some((l) => from < l.to && to > l.from)) continue;

        const actions: Action[] = lint
          .suggestions()
          .slice(0, MAX_SUGGESTIONS)
          .map((s) => {
            const text = s.get_replacement_text();
            const k = s.kind(); // 0 replace, 1 remove, 2 insert after
            return {
              name: k === 1 ? "Remove" : k === 2 ? `Add “${text}”` : text || "Remove",
              apply: (v: EditorView, f: number, t: number) => {
                v.dispatch(
                  k === 2
                    ? { changes: { from: t, insert: text } }
                    : { changes: { from: f, to: t, insert: k === 1 ? "" : text } },
                );
              },
            };
          });
        if (cat === "spelling" && /^[\p{L}'’-]+$/u.test(problem)) {
          actions.push({
            name: "Add to dictionary",
            markClass: "cm-grammar-quiet",
            apply: (v) => void addToDictionary(problem).then(() => forceLinting(v)),
          });
        }
        actions.push({
          name: "Ignore",
          markClass: "cm-grammar-quiet",
          apply: (v) => void ignore(source, lint).then(() => forceLinting(v)),
        });

        out.push({
          from,
          to,
          severity: cat === "style" ? "info" : "warning",
          markClass: `cm-grammar-${cat}`,
          source: lint.lint_kind_pretty(),
          message: lint.message(),
          actions,
        });
      }
      return out;
    },
    { delay: 1000 },
  );
}
