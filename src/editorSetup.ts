import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

const proseBlock = (name: string) => Decoration.line({ class: name });

function decorateBlocks(view: EditorView): DecorationSet {
  const classes = new Map<number, Set<string>>();
  const addRange = (from: number, to: number, name: string) => {
    const first = view.state.doc.lineAt(from).number;
    const last = view.state.doc.lineAt(Math.max(from, to - 1)).number;
    for (let number = first; number <= last; number++) {
      let names = classes.get(number);
      if (!names) classes.set(number, (names = new Set()));
      names.add(name);
    }
  };

  const tree = syntaxTree(view.state);
  for (const range of view.visibleRanges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter(node) {
        const from = Math.max(node.from, range.from);
        const to = Math.min(node.to, range.to);
        const { name } = node;
        const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(name);
        if (heading) {
          addRange(from, to, `cm-prose-heading-${heading[1]}`);
          if (name === "ATXHeading1" && view.state.doc.lineAt(node.from).text.trim() === "#") {
            addRange(from, to, "cm-prose-scene-break");
          }
        } else if (name === "Blockquote") addRange(from, to, "cm-prose-quote");
        else if (name === "BulletList" || name === "OrderedList") addRange(from, to, "cm-prose-list");
        else if (name === "FencedCode" || name === "CodeBlock") addRange(from, to, "cm-prose-code");
        else if (name === "HorizontalRule") addRange(from, to, "cm-prose-scene-break");
      },
    });
  }

  const builder = new RangeSetBuilder<Decoration>();
  for (const [number, names] of [...classes].sort(([a], [b]) => a - b)) {
    builder.add(view.state.doc.line(number).from, view.state.doc.line(number).from, proseBlock([...names].join(" ")));
  }
  return builder.finish();
}

const proseBlocks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = decorateBlocks(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = decorateBlocks(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

const proseStyle = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.55em", fontWeight: "600", lineHeight: "1.3" },
  { tag: t.heading2, fontSize: "1.28em", fontWeight: "600" },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.quote, fontStyle: "italic", color: "var(--text-soft)" },
  { tag: t.link, textDecoration: "underline", textDecorationColor: "var(--mark)" },
  { tag: t.url, color: "var(--mark)" },
  { tag: [t.processingInstruction, t.contentSeparator, t.list], color: "var(--mark)" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", fontSize: "0.9em" },
]);

const proseTheme = EditorView.theme({
  "&": {
    backgroundColor: "transparent",
    color: "var(--page-text)",
    fontFamily: "var(--font-prose)",
    fontSize: "var(--prose-size)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "var(--prose-leading)", overflow: "visible" },
  ".cm-content": { caretColor: "var(--lamp)", padding: "0 0 40vh" },
  ".cm-line": { padding: "0" },
  ".cm-line.cm-prose-heading-1": { paddingTop: "1.25em", paddingBottom: "0.3em" },
  ".cm-line.cm-prose-heading-2": { paddingTop: "1em", paddingBottom: "0.25em" },
  ".cm-line.cm-prose-heading-3, .cm-line.cm-prose-heading-4, .cm-line.cm-prose-heading-5, .cm-line.cm-prose-heading-6":
    { paddingTop: "0.75em", paddingBottom: "0.15em" },
  ".cm-line.cm-prose-quote": {
    borderLeft: "2px solid var(--mark)",
    paddingLeft: "1em",
    marginLeft: "-1em",
  },
  ".cm-line.cm-prose-list": { paddingLeft: "1.25em" },
  ".cm-line.cm-prose-code": {
    backgroundColor: "color-mix(in srgb, var(--shade) 72%, transparent)",
    fontFamily: "var(--font-mono)",
    fontSize: "0.88em",
    paddingInline: "0.6em",
  },
  ".cm-line.cm-prose-scene-break": {
    color: "var(--mark)",
    letterSpacing: "0.2em",
    textAlign: "center",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--lamp)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--selection)" },
  ".cm-placeholder": { color: "var(--text-faint)", fontStyle: "italic" },
});

export const proseExtensions = [
  markdown({ base: markdownLanguage }),
  syntaxHighlighting(proseStyle),
  proseBlocks,
  EditorView.lineWrapping,
  proseTheme,
  // spellcheck is set by the editor: off while Harper checks spelling itself.
  EditorView.contentAttributes.of({
    autocorrect: "on",
    autocapitalize: "sentences",
    "aria-label": "Chapter text",
  }),
];

export const basicSetup = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: false,
  highlightActiveLineGutter: false,
  highlightSelectionMatches: false,
  autocompletion: false,
  bracketMatching: false,
  closeBrackets: false,
  indentOnInput: false,
  syntaxHighlighting: false,
  searchKeymap: true,
  history: true,
};
