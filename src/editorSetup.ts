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

type CaretPosition = Pick<DOMRect, "left" | "top" | "bottom">;

const caretAnimation = ViewPlugin.fromClass(
  class {
    private position: number;
    private coords: CaretPosition | null;
    private active = false;
    private timer: number | undefined;
    private readonly cursor = document.createElement("span");

    constructor(private readonly view: EditorView) {
      this.position = view.state.selection.main.head;
      this.coords = this.readCoords(this.position);
      this.cursor.className = "cm-animated-cursor";
      this.cursor.setAttribute("aria-hidden", "true");
      view.dom.append(this.cursor);
    }

    update(update: ViewUpdate) {
      if (!update.docChanged && !update.selectionSet) {
        if (!this.active && update.geometryChanged) this.coords = this.readCoords(this.position);
        return;
      }

      const previousPosition = this.position;
      const nextPosition = update.state.selection.main.head;
      const nextCoords = this.readCoords(nextPosition);
      if (
        update.docChanged &&
        update.selectionSet &&
        update.transactions.some(
          (transaction) => transaction.isUserEvent("input.type") || transaction.isUserEvent("delete"),
        ) &&
        update.startState.selection.main.empty &&
        update.state.selection.main.empty &&
        Math.abs(nextPosition - previousPosition) <= 2 &&
        this.isSingleLineEdit(update) &&
        this.coords &&
        nextCoords &&
        Math.abs(nextCoords.top - this.coords.top) < 1 &&
        this.view.hasFocus &&
        !window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        this.animate(this.coords, nextCoords);
      } else {
        this.stop();
      }

      this.position = nextPosition;
      this.coords = nextCoords;
    }

    destroy() {
      this.stop();
      this.cursor.remove();
    }

    private readCoords(position: number): CaretPosition | null {
      const coords = this.view.coordsAtPos(position);
      return coords ? { left: coords.left, top: coords.top, bottom: coords.bottom } : null;
    }

    private isSingleLineEdit(update: ViewUpdate): boolean {
      let found = false;
      let valid = true;
      update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
        if (
          found ||
          toA - fromA > 2 ||
          toB - fromB > 2 ||
          update.startState.doc.sliceString(fromA, toA).includes("\n") ||
          inserted.toString().includes("\n") ||
          update.startState.doc.lineAt(fromA).number !== update.state.doc.lineAt(fromB).number
        ) {
          valid = false;
        }
        found = true;
      });
      return found && valid;
    }

    private animate(from: CaretPosition, to: CaretPosition) {
      if (!this.active) {
        this.cursor.style.display = "block";
        this.cursor.style.transition = "none";
        this.moveTo(from);
        this.view.dom.classList.add("cm-caret-animating");
        void this.cursor.offsetWidth;
        this.cursor.style.removeProperty("transition");
      }
      this.moveTo(to);
      this.active = true;
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.stop(), 100);
    }

    private moveTo(coords: CaretPosition) {
      const bounds = this.view.dom.getBoundingClientRect();
      this.cursor.style.height = `${coords.bottom - coords.top}px`;
      this.cursor.style.transform = `translate3d(${coords.left - bounds.left}px, ${coords.top - bounds.top}px, 0)`;
    }

    private stop() {
      window.clearTimeout(this.timer);
      this.timer = undefined;
      if (!this.active) return;
      this.active = false;
      this.cursor.style.display = "none";
      this.view.dom.classList.remove("cm-caret-animating");
    }
  },
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
  ".cm-animated-cursor": {
    position: "absolute",
    top: "0",
    left: "0",
    borderLeft: "2px solid var(--lamp)",
    pointerEvents: "none",
    zIndex: "2",
    transition: "transform 85ms cubic-bezier(0.2, 0.8, 0.2, 1)",
  },
  "&.cm-caret-animating .cm-cursor": { visibility: "hidden" },
  "&.cm-caret-animating .cm-content": { caretColor: "transparent" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--selection)" },
  ".cm-placeholder": { color: "var(--text-faint)", fontStyle: "italic" },
});

export const proseExtensions = [
  markdown({ base: markdownLanguage }),
  syntaxHighlighting(proseStyle),
  proseBlocks,
  caretAnimation,
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
