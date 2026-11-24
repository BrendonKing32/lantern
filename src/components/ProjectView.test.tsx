import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { useLabelSnapshot } from "./ProjectView";
import type { EditorControls } from "./ChapterEditor";
import type { SceneMeta } from "../../shared/types";

const hooks = vi.hoisted(() => ({
  slots: [] as any[],
  index: 0,
  effects: [] as (() => void)[],
  dirty: false,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState(initial: unknown) {
      const index = hooks.index++;
      if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [hooks.slots[index], (value: any) => {
        hooks.slots[index] = typeof value === "function" ? value(hooks.slots[index]) : value;
        hooks.dirty = true;
      }];
    },
    useRef(initial: unknown) {
      const index = hooks.index++;
      return hooks.slots[index] ??= { current: initial };
    },
    useEffect(effect: () => void | (() => void), deps: unknown[]) {
      const index = hooks.index++;
      const previous = hooks.slots[index];
      if (previous && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return;
      hooks.effects.push(() => {
        previous?.cleanup?.();
        hooks.slots[index] = { deps, cleanup: effect() };
      });
    },
    useCallback(callback: unknown) {
      hooks.index++;
      return callback;
    },
  };
});

describe("label snapshot refresh", () => {
  let text: string;
  let chapter: { id: string; version: number; content: string; word_count: number; updated_at: string };
  let view: "write" | "scenes" | "board";
  let controls: { current: EditorControls };
  let setScenes: (scenes: SceneMeta[]) => void;
  let result: ReturnType<typeof useLabelSnapshot>;

  const render = () => {
    hooks.index = 0;
    hooks.dirty = false;
    result = useLabelSnapshot("p", view, chapter.id, "Chapter", controls, setScenes);
    for (const effect of hooks.effects.splice(0)) effect();
  };
  const settle = async () => {
    for (let i = 0; i < 12; i++) {
      await Promise.resolve();
      if (hooks.dirty) render();
    }
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    hooks.slots = [];
    hooks.effects = [];
    hooks.dirty = false;
    text = "First passage.";
    chapter = { id: "c", version: 1, content: text, word_count: 2, updated_at: "" };
    view = "write";
    controls = { current: { text: () => text, reveal: () => false, revealScene: () => false } };
    setScenes = vi.fn();
    vi.spyOn(api, "getChapter").mockImplementation(async () => ({ ...chapter } as Awaited<ReturnType<typeof api.getChapter>>));
    vi.spyOn(api, "scenes").mockResolvedValue({ scenes: [], placeholders: [] });
  });

  afterEach(() => {
    for (const slot of hooks.slots) slot?.cleanup?.();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not list scenes again for ten routine saves", async () => {
    render();
    await settle();
    for (let i = 0; i < 10; i++) {
      chapter.version++;
      chapter.content = text = `First passage, save ${i}.`;
      result.chapterSaved(chapter.id);
      render();
      await settle();
    }
    expect(api.scenes).toHaveBeenCalledTimes(1);
    expect(result.snapshot?.baseline).toBe("First passage.");
  });

  it("refreshes for a replacement, a new chapter, and returning from Scenes", async () => {
    render();
    await settle();
    result.chapterSaved(chapter.id, true);
    render();
    await settle();
    expect(api.scenes).toHaveBeenCalledTimes(2);
    view = "board";
    render();
    view = "write";
    render();
    await settle();
    expect(api.scenes).toHaveBeenCalledTimes(2);
    view = "scenes";
    render();
    view = "board";
    render();
    view = "write";
    render();
    await settle();
    expect(api.scenes).toHaveBeenCalledTimes(3);
    chapter.id = "other";
    render();
    await settle();
    expect(api.scenes).toHaveBeenCalledTimes(4);
    expect(result.snapshot?.chapterId).toBe("other");
  });

  it("keeps labels on failure and throttles passage-count refreshes", async () => {
    render();
    await settle();
    const snapshot = result.snapshot;
    vi.mocked(api.scenes).mockRejectedValueOnce(new Error("offline"));
    result.chapterSaved(chapter.id, true);
    render();
    await settle();
    expect(result.snapshot).toBe(snapshot);
    text = "First passage.\n\n***\n\nSecond passage.";
    await vi.advanceTimersByTimeAsync(29_000);
    await settle();
    expect(api.scenes).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(api.scenes).toHaveBeenCalledTimes(3);
    expect(result.snapshot).not.toBe(snapshot);
  });

  it("retries a failed initial load without waiting for a passage change", async () => {
    vi.mocked(api.scenes).mockRejectedValueOnce(new Error("offline"));
    render();
    await settle();
    expect(result.snapshot).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(api.scenes).toHaveBeenCalledTimes(2);
    expect(result.snapshot?.chapterId).toBe("c");
  });
});
