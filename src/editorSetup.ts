import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

// Ulysses-style live markdown: formatting shows as you type, and the
// markup characters themselves recede.
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
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--lamp)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--selection)" },
  ".cm-placeholder": { color: "var(--text-faint)", fontStyle: "italic" },
});

export const proseExtensions = [
  markdown({ base: markdownLanguage }),
  syntaxHighlighting(proseStyle),
  EditorView.lineWrapping,
  proseTheme,
  EditorView.contentAttributes.of({
    spellcheck: "true",
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
