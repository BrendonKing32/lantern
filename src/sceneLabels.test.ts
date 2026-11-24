import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SceneMeta } from "../shared/types";
import { countWords } from "../shared/wordcount";
import { computeSceneLabels, insertSceneBreak, sceneLabels, sceneLabelsEnabled, setSceneLabelsEnabled } from "./sceneLabels";

function card(id: string, passage_index: number | null, position: number, in_text = true): SceneMeta {
  return {
    id, passage_index, position, in_text, title: `Card ${id}`, chapter_id: "chapter",
    project_id: "project", summary: "", pov: "", location: "", status: "drafted",
    word_count: 0, excerpt: "", unconfirmed: false, unlinked_at: null, merged_into: null,
    created_at: "", updated_at: "",
  };
}

describe("scene labels", () => {
  const baselineText = "# Chapter\n\nFirst passage.\n\n***\n\nSecond passage.\n\n---\n\nThird passage.";
  const snapshot = {
    baselineText, chapterTitle: "Chapter",
    cards: [card("first", 0, 0), card("third", 2, 1), card("planned", null, 2, false)],
  };

  it("uses baseline passage indexes and leaves uncarded passages as placeholders", () => {
    const labels = computeSceneLabels(baselineText, snapshot);
    expect(labels.map(({ text }) => text)).toEqual(["Card first", "Scene 2 · no card", "Card third"]);
    expect(labels.map(({ from }) => from)).toEqual([0, baselineText.indexOf("\n\nSecond") + 1, baselineText.indexOf("\n\nThird") + 1]);
    expect(labels.map(({ card }) => card?.id ?? null)).toEqual(["first", null, "third"]);
  });

  it("matches the saved anchors after a new break rather than shifting cards", () => {
    const current = baselineText.replace("First passage.", "New passage.\n\n***\n\nFirst passage.");
    expect(computeSceneLabels(current, snapshot).map((label) => label.text))
      .toEqual(["Scene 1 · no card", "Card first", "Scene 3 · no card", "Card third"]);
  });

  it("uses a refreshed listing against its saved baseline, not the current edit", () => {
    const changed = baselineText.replace("First passage.", "New passage.\n\n***\n\nFirst passage.");
    const refreshed = { ...snapshot, cards: [card("first", 0, 0), card("new", 1, 1), card("third", 2, 2)] };
    expect(computeSceneLabels(changed, refreshed).map((label) => label.text))
      .toEqual(["Scene 1 · no card", "Card first", "Card new", "Card third"]);
  });

  it("does not invent anchors for invalid or duplicate passage indexes", () => {
    const cards = [card("a", 0, 0), card("b", 0, 1), card("c", 99, 2), card("d", null, 3)];
    expect(computeSceneLabels(baselineText, { ...snapshot, cards }).every((label) => !label.card)).toBe(true);
  });

  it("keeps the document and its word count unchanged with widgets installed", () => {
    const state = EditorState.create({
      doc: baselineText,
      extensions: sceneLabels({ snapshot: () => snapshot, open: () => {} }),
    });
    expect(state.doc.toString()).toBe(baselineText);
    expect(state.doc.length).toBe(baselineText.length);
    expect(countWords(state.doc.toString())).toBe(countWords(baselineText));
    const edited = state.update({ changes: { from: 0, insert: "Hello " } }).state;
    expect(edited.doc.toString()).toBe(`Hello ${baselineText}`);
  });
});

describe("insertSceneBreak", () => {
  function run(doc: string, from: number, to = from) {
    let state = EditorState.create({ doc, selection: { anchor: from, head: to } });
    const view = {
      get state() { return state; },
      dispatch: (...specs: TransactionSpec[]) => { state = state.update(...specs).state; },
    } as unknown as EditorView;
    expect(insertSceneBreak(view)).toBe(true);
    return state;
  }

  it("inserts the chapter's most common break at the cursor", () => {
    const text = "One\n\n---\n\nTwo\n\n***\n\nThree\n\n---\n\nFour";
    expect(run(text, 3).doc.toString()).toBe(text.slice(0, 3) + "\n\n---\n\n" + text.slice(3));
  });

  describe("scene label preference", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("defaults on and remembers the choice", () => {
      const data = new Map<string, string>();
      vi.stubGlobal("localStorage", {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => data.set(key, value),
      });
      expect(sceneLabelsEnabled()).toBe(true);
      setSceneLabelsEnabled(false);
      expect(sceneLabelsEnabled()).toBe(false);
      setSceneLabelsEnabled(true);
      expect(sceneLabelsEnabled()).toBe(true);
    });

    it("defaults on when storage is unavailable", () => {
      vi.stubGlobal("localStorage", {
        getItem: () => { throw new Error("blocked"); },
        setItem: () => { throw new Error("blocked"); },
      });
      expect(sceneLabelsEnabled()).toBe(true);
      expect(() => setSceneLabelsEnabled(false)).not.toThrow();
    });
  });

  it("uses the first style on a tie, or *** when there are no breaks", () => {
    const text = "One\n\n#\n\nTwo\n\n***\n\nThree";
    expect(run(text, 0).doc.toString()).toBe("\n\n#\n\n" + text);
    expect(run("One", 0, 3).doc.toString()).toBe("\n\n***\n\n");
  });

  it("replaces the selection and puts the caret after the inserted break", () => {
    const state = run("before chosen after", 7, 13);
    expect(state.doc.toString()).toBe("before \n\n***\n\n after");
    expect(state.selection.main.empty).toBe(true);
    expect(state.selection.main.head).toBe(14);
  });

  it("does not dispatch in a read-only editor", () => {
    const state = EditorState.create({ doc: "Unchanged", extensions: EditorState.readOnly.of(true) });
    const dispatch = vi.fn();
    expect(insertSceneBreak({ state, dispatch } as unknown as EditorView)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(state.doc.toString()).toBe("Unchanged");
  });
});
