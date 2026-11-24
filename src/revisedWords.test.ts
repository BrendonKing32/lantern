import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { revisedWords } from "./revisedWords";

describe("revised words", () => {
  it.each([
    ["one two", [{ from: 3, insert: " three" }], 1],
    ["one two", [{ from: 4, to: 7 }], 1],
    ["one two", [{ from: 4, to: 7, insert: "three" }], 2],
    ["one two three four", [{ from: 0, to: 3, insert: "first" }, { from: 8, to: 13, insert: "last word" }], 5],
  ])("counts inserted and deleted words for %s", (doc, changes, expected) => {
    const state = EditorState.create({ doc });
    const tx = state.update({ changes });
    expect(revisedWords(tx.changes, state.doc)).toBe(expected);
  });
});
