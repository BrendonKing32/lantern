// CodeMirror support for [[wikilinks]] to the story bible: links are marked
// (dotted when no entry has that name yet), typing [[ suggests entries, and
// clicking a link asks the app to show that entry.

import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { entryIndex, findLinks, linkKey } from "../shared/wikilinks";
import type { BibleEntry } from "../shared/types";

export interface WikilinkHost {
  /** The novel's bible entries, read fresh each time. */
  entries: () => BibleEntry[];
  /** Called with the linked name when a link is clicked. */
  open: (name: string) => void;
}

/** Dispatch this after the entries change so links are re-checked. */
export const entriesChanged = StateEffect.define<null>();

const known = Decoration.mark({ class: "cm-wikilink" });
const missing = Decoration.mark({ class: "cm-wikilink cm-wikilink-missing" });

function decorate(view: EditorView, host: WikilinkHost): DecorationSet {
  const index = entryIndex(host.entries());
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    // Links never span lines, so scanning whole visible lines is enough.
    const start = view.state.doc.lineAt(from).from;
    const end = view.state.doc.lineAt(to).to;
    for (const link of findLinks(view.state.doc.sliceString(start, end))) {
      builder.add(start + link.from, start + link.to, index.has(linkKey(link.name)) ? known : missing);
    }
  }
  return builder.finish();
}

function linkAt(view: EditorView, pos: number): string | null {
  const line = view.state.doc.lineAt(pos);
  const hit = findLinks(line.text).find((l) => line.from + l.from <= pos && pos <= line.from + l.to);
  return hit ? hit.name : null;
}

export function wikilinks(host: WikilinkHost) {
  const marks = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorate(view, host);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.transactions.some((t) => t.effects.some((e) => e.is(entriesChanged)))) {
          this.decorations = decorate(u.view, host);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  // A click on a link shows the entry beside the page; the caret still lands
  // where you clicked, so editing the link text works as usual.
  const clicks = EditorView.domEventHandlers({
    click(event, view) {
      if (!(event.target instanceof Element) || !event.target.closest(".cm-wikilink")) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      const name = pos === null ? null : linkAt(view, pos);
      if (name) host.open(name);
      return false;
    },
  });

  const complete = (ctx: CompletionContext): CompletionResult | null => {
    const before = ctx.matchBefore(/\[\[[^[\]|\n]*$/);
    if (!before) return null;
    const typed = before.text.slice(2);
    const after = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2);
    const options = host.entries().flatMap((e) => [
      { label: e.name, detail: e.kind, apply: e.name + (after === "]]" ? "" : "]]") },
      ...e.aliases.map((a) => ({ label: a, detail: `${e.name}, ${e.kind}`, apply: a + (after === "]]" ? "" : "]]") })),
    ]);
    if (!options.length && !typed) return null;
    return { from: before.from + 2, options, validFor: /^[^[\]|\n]*$/ };
  };

  return [
    marks,
    clicks,
    autocompletion({ override: [complete], activateOnTyping: true, icons: false }),
    EditorView.baseTheme({
      ".cm-wikilink": {
        color: "var(--lamp)",
        textDecoration: "underline",
        textDecorationColor: "color-mix(in srgb, var(--lamp) 45%, transparent)",
        textUnderlineOffset: "0.18em",
        cursor: "pointer",
      },
      ".cm-wikilink-missing": {
        color: "inherit",
        textDecorationStyle: "dotted",
        textDecorationColor: "var(--text-faint)",
      },
    }),
  ];
}
