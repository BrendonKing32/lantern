import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarginNote } from "../../shared/types";
import type { TextAnchor } from "../../shared/anchors";
import { api } from "../api";
import { NotesPanel } from "./NotesPanel";

const hooks = vi.hoisted(() => ({ slots: [] as any[], index: 0, effects: [] as (() => void)[], dirty: false }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState(initial: unknown) {
      const i = hooks.index++;
      if (!(i in hooks.slots)) hooks.slots[i] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [hooks.slots[i], (value: any) => {
        hooks.slots[i] = typeof value === "function" ? value(hooks.slots[i]) : value;
        hooks.dirty = true;
      }];
    },
    useRef(initial: unknown) {
      const i = hooks.index++;
      return hooks.slots[i] ??= { current: initial };
    },
    useEffect(effect: () => void | (() => void), deps: unknown[]) {
      const i = hooks.index++;
      const previous = hooks.slots[i];
      if (previous && deps.every((dep, n) => Object.is(dep, previous.deps[n]))) return;
      hooks.effects.push(() => {
        previous?.cleanup?.();
        hooks.slots[i] = { deps, cleanup: effect() };
      });
    },
  };
});

const note: MarginNote = {
  id: "n", project_id: "p", chapter_id: "c", quote: "passage", prefix: "", suffix: "",
  body: "Original", author: "writer", resolved_at: null, created_at: "now", updated_at: "now",
};

function elements(node: any): any[] {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(elements);
  return [node, ...elements(node.props?.children)];
}

describe("NotesPanel", () => {
  let selected: string | null;
  let chapterId: string;
  let loading: boolean;
  let open: boolean;
  let anchor: TextAnchor | null;
  let notes: MarginNote[];
  let tree: any;
  let onNotes: (update: (notes: MarginNote[]) => MarginNote[]) => void;
  const onClose = () => {};
  const onSelect = (id: string | null) => { selected = id; };
  const render = () => {
    hooks.index = 0;
    hooks.dirty = false;
    tree = NotesPanel({
      chapterId, title: "Chapter", open, text: "passage", notes, onNotes, offline: false,
      loading, loadError: null, anchor, selected, onSelect,
      onCancelAdd: () => { anchor = null; }, onJump: () => {}, onClose,
    });
    for (const effect of hooks.effects.splice(0)) effect();
  };
  const settle = () => {
    for (let i = 0; i < 10; i++) { render(); if (!hooks.dirty) break; }
  };
  const button = (label: string) => elements(tree).find((element) => element.type === "button" && element.props.children === label);

  beforeEach(() => {
    hooks.slots = []; hooks.effects = []; hooks.dirty = false;
    selected = null; chapterId = "c"; loading = false; open = true; anchor = null; notes = [note];
    onNotes = vi.fn((update: (notes: MarginNote[]) => MarginNote[]) => { notes = update(notes); });
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    settle();
  });
  afterEach(() => {
    for (const slot of hooks.slots) slot?.cleanup?.();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  it("keeps the edit form open when selecting an unselected note", () => {
    button("Edit").props.onClick();
    settle();
    expect(selected).toBe("n");
    const textarea = elements(tree).find((element) => element.type === "textarea");
    expect(textarea?.props.value).toBe("Original");
    expect(button("Save")).toBeTruthy();
  });

  it("ignores an in-flight mutation after switching chapters", async () => {
    let finish!: (note: MarginNote) => void;
    vi.spyOn(api, "updateNote").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    button("Resolve").props.onClick();
    chapterId = "other";
    settle();
    finish({ ...note, resolved_at: "now" });
    await Promise.resolve();
    await Promise.resolve();
    expect(onNotes).not.toHaveBeenCalled();
  });

  it("does not mutate while the notes list is loading", () => {
    const update = vi.spyOn(api, "updateNote");
    loading = true;
    settle();
    expect(button("Resolve").props.disabled).toBe(true);
    button("Resolve").props.onClick();
    expect(update).not.toHaveBeenCalled();
  });

  it("applies a mutation that finishes after the panel is closed and a stale list loaded", async () => {
    let finish!: (note: MarginNote) => void;
    vi.spyOn(api, "updateNote").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    button("Resolve").props.onClick();
    open = false;
    settle();
    notes = [note, { ...note, id: "another" }];
    settle();
    finish({ ...note, resolved_at: "now" });
    await Promise.resolve();
    await Promise.resolve();
    expect(notes).toEqual([{ ...note, resolved_at: "now" }, { ...note, id: "another" }]);
  });

  it("keeps a second note draft when an earlier creation finishes", async () => {
    let finish!: (note: MarginNote) => void;
    vi.spyOn(api, "createNote").mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    anchor = { quote: "passage", prefix: "", suffix: "" };
    settle();
    let textarea = elements(tree).find((element) => element.type === "textarea");
    textarea.props.onChange({ target: { value: "First note" } });
    settle();
    elements(tree).find((element) => element.type === "form").props.onSubmit({ preventDefault() {} });
    const secondAnchor = { quote: "other", prefix: "", suffix: "" };
    anchor = secondAnchor;
    settle();
    textarea = elements(tree).find((element) => element.type === "textarea");
    textarea.props.onChange({ target: { value: "Second note" } });
    settle();
    finish({ ...note, id: "new", body: "First note" });
    await Promise.resolve();
    await Promise.resolve();
    settle();
    expect(anchor).toBe(secondAnchor);
    expect(elements(tree).find((element) => element.type === "textarea")?.props.value).toBe("Second note");
    expect(notes.find((item) => item.id === "new")?.body).toBe("First note");
    expect(selected).toBeNull();
  });
});
