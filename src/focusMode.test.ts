import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  focusRemembered, isFocusShortcut, recentres, rememberFocus, setTypewriterEnabled, typewriterEnabled, typewriterScrolling,
} from "./focusMode";

const key = (over: Partial<KeyboardEvent>) =>
  ({ code: "KeyF", key: "f", altKey: true, shiftKey: false, metaKey: false, ctrlKey: true, ...over }) as KeyboardEvent;

function storage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    get length() { return data.size; },
  };
}

describe("focus shortcut", () => {
  it("is Ctrl+Alt+F, or ⌘⌥F where Option changes the typed letter", () => {
    expect(isFocusShortcut(key({}))).toBe(true);
    expect(isFocusShortcut(key({ ctrlKey: false, metaKey: true, key: "ƒ" }))).toBe(true);
  });

  it("leaves plain Alt+F, Ctrl+F (find) and Ctrl+Shift+Alt+F alone", () => {
    expect(isFocusShortcut(key({ ctrlKey: false }))).toBe(false);
    expect(isFocusShortcut(key({ altKey: false }))).toBe(false);
    expect(isFocusShortcut(key({ shiftKey: true }))).toBe(false);
    expect(isFocusShortcut(key({ code: "KeyG", key: "g" }))).toBe(false);
  });
});

describe("typewriter scrolling", () => {
  const state = EditorState.create({ doc: "One line.\nAnother line.", extensions: typewriterScrolling() });
  // The extension's only effect is the scroll request, so any effect means it asked to recentre.
  const centred = (spec: TransactionSpec) => state.update(spec).effects.length > 0;

  it("recentres on typing, deleting and keyboard movement", () => {
    expect(centred({ changes: { from: 9, insert: "!" }, selection: { anchor: 10 }, userEvent: "input.type" })).toBe(true);
    expect(centred({ changes: { from: 8, to: 9 }, userEvent: "delete.backward" })).toBe(true);
    expect(centred({ selection: { anchor: 15 }, userEvent: "select" })).toBe(true);
    expect(centred({ changes: { from: 0, insert: "x" }, userEvent: "undo" })).toBe(true);
  });

  it("doesn't move the page under a click, a selection or a change made elsewhere", () => {
    expect(centred({ selection: { anchor: 15 }, userEvent: "select.pointer" })).toBe(false);
    expect(centred({ selection: EditorSelection.single(0, 5), userEvent: "select" })).toBe(false);
    expect(centred({ changes: { from: 0, insert: "Remote " } })).toBe(false);
  });

  it("decides from the transaction alone", () => {
    const tr = state.update({ changes: { from: 0, insert: "a" }, userEvent: "input.paste" });
    expect(recentres(tr)).toBe(true);
  });
});

describe("focus settings", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps typewriter scrolling on by default and remembers turning it off", () => {
    vi.stubGlobal("localStorage", storage());
    expect(typewriterEnabled()).toBe(true);
    setTypewriterEnabled(false);
    expect(typewriterEnabled()).toBe(false);
    setTypewriterEnabled(true);
    expect(typewriterEnabled()).toBe(true);
  });

  it("remembers focus mode for the tab only", () => {
    vi.stubGlobal("sessionStorage", storage());
    expect(focusRemembered()).toBe(false);
    rememberFocus(true);
    expect(focusRemembered()).toBe(true);
    rememberFocus(false);
    expect(focusRemembered()).toBe(false);
  });

  it("carries on when storage is unavailable", () => {
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
    vi.stubGlobal("localStorage", broken);
    vi.stubGlobal("sessionStorage", broken);
    expect(typewriterEnabled()).toBe(true);
    expect(focusRemembered()).toBe(false);
    expect(() => { setTypewriterEnabled(false); rememberFocus(true); }).not.toThrow();
  });
});
