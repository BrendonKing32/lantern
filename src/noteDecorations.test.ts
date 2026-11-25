import { EditorState } from "@codemirror/state";
import { describe, expect, it, vi } from "vitest";
import { makeAnchor } from "../shared/anchors";
import type { MarginNote } from "../shared/types";
import { countWords } from "../shared/wordcount";
import { noteDecorations, noteRanges, notesChanged } from "./noteDecorations";

describe("margin note decorations", () => {
  it("adds, reanchors and removes marks and margin markers without changing chapter length or words", () => {
    const text = "The lamp burned.\nA quiet room.";
    const note: MarginNote = {
      id: "n", project_id: "p", chapter_id: "c", ...makeAnchor(text, 4, 8),
      body: "A private note with many words", author: "writer", resolved_at: null,
      created_at: "now", updated_at: "now",
    };
    const host = { notes: () => [note], open: vi.fn(), add: vi.fn(), changed: vi.fn() };
    let state = EditorState.create({ doc: text, extensions: [noteDecorations(host)] });
    const originalLength = state.doc.length;
    const originalWords = countWords(state.doc.toString());
    const ranges = noteRanges(state.doc, [note], host.open);
    expect(ranges.marks.size).toBe(1);
    expect(ranges.markers.size).toBe(1);
    state = state.update({ effects: notesChanged.of([note]) }).state;
    expect(state.doc.toString()).toBe(text);
    expect(state.doc.length).toBe(originalLength);
    expect(countWords(state.doc.toString())).toBe(originalWords);

    state = state.update({ changes: { from: 0, insert: "Outside, " } }).state;
    const edited = state.doc.toString();
    const words = countWords(edited);
    expect(noteRanges(state.doc, [note], host.open).marks.size).toBe(1);
    state = state.update({ effects: notesChanged.of([note]) }).state;
    state = state.update({ effects: notesChanged.of([]) }).state;
    expect(state.doc.toString()).toBe(edited);
    expect(state.doc.length).toBe(edited.length);
    expect(countWords(state.doc.toString())).toBe(words);
    expect(noteRanges(state.doc, [{ ...note, resolved_at: "now" }], host.open).marks.size).toBe(0);
    expect(noteRanges(state.doc, [{ ...note, quote: "missing" }], host.open).markers.size).toBe(0);
  });
});
