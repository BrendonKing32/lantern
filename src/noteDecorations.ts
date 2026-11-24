import { RangeSet, StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, ViewPlugin, gutter, keymap, type DecorationSet } from "@codemirror/view";
import { findAnchor } from "../shared/anchors";
import type { MarginNote } from "../shared/types";

export const notesChanged = StateEffect.define<readonly MarginNote[]>();

class NoteMarker extends GutterMarker {
  constructor(private readonly notes: readonly MarginNote[], private readonly open: (id: string) => void) {
    super();
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    for (const note of this.notes) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cm-note-marker";
      button.textContent = "●";
      button.setAttribute("aria-label", `Open ${note.author === "claude" ? "Claude's note" : "note"}`);
      button.addEventListener("click", () => this.open(note.id));
      wrap.append(button);
    }
    return wrap;
  }
}

interface NoteRanges {
  marks: DecorationSet;
  markers: RangeSet<GutterMarker>;
}

/** Decorations and gutter markers are metadata, never edits to the document. */
export function noteRanges(doc: import("@codemirror/state").Text, notes: readonly MarginNote[], open: (id: string) => void): NoteRanges {
  const marks: ReturnType<Decoration["range"]>[] = [];
  const lines = new Map<number, MarginNote[]>();
  const text = doc.toString();
  for (const note of notes) {
    if (note.resolved_at) continue;
    const range = findAnchor(text, note);
    if (!range) continue;
    marks.push(Decoration.mark({ class: "cm-note-highlight", attributes: { "data-note-id": note.id } }).range(range.from, range.to));
    const line = doc.lineAt(range.from).from;
    const list = lines.get(line) ?? [];
    list.push(note);
    lines.set(line, list);
  }
  return {
    marks: Decoration.set(marks, true),
    markers: RangeSet.of([...lines].map(([pos, list]) => new NoteMarker(list, open).range(pos)), true),
  };
}

export function noteDecorations(host: {
  notes: () => readonly MarginNote[];
  open: (id: string) => void;
  add: () => void;
  changed: (text: string) => void;
}): Extension {
  const field = StateField.define<NoteRanges>({
    create: (state) => noteRanges(state.doc, host.notes(), host.open),
    update(value, transaction) {
      value = { marks: value.marks.map(transaction.changes), markers: value.markers.map(transaction.changes) };
      for (const effect of transaction.effects) {
        if (effect.is(notesChanged)) value = noteRanges(transaction.state.doc, effect.value, host.open);
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f, (value) => value.marks),
  });
  return [
    field,
    gutter({ class: "cm-note-gutter", markers: (view) => view.state.field(field).markers }),
    keymap.of([{ key: "Mod-Alt-m", run: () => { host.add(); return true; } }]),
    EditorView.domEventHandlers({
      click(event) {
        const element = event.target instanceof Element ? event.target.closest<HTMLElement>(".cm-note-highlight") : null;
        const id = element?.dataset.noteId;
        if (!id) return false;
        host.open(id);
        return true;
      },
    }),
    ViewPlugin.fromClass(class {
      private timer: ReturnType<typeof setTimeout> | undefined;
      update(update: import("@codemirror/view").ViewUpdate) {
        if (!update.docChanged) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          const text = update.view.state.doc.toString();
          update.view.dispatch({ effects: notesChanged.of(host.notes()) });
          host.changed(text);
        }, 300);
      }
      destroy() { clearTimeout(this.timer); }
    }),
  ];
}
