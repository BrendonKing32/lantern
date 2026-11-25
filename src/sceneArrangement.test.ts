import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterMeta } from "../shared/types";
import { draftWriteFailed, draftWriteSucceeded, trackChapterActivity } from "./chapterActivity";

const mocks = vi.hoisted(() => ({
  getChapter: vi.fn(), saveChapter: vi.fn(), arrangeScenes: vi.fn(), moveScene: vi.fn(), scenes: vi.fn(),
  readDraft: vi.fn(), clearIf: vi.fn(), acknowledge: vi.fn(), reopen: vi.fn(), writeChapter: vi.fn(),
  forget: vi.fn(), remember: vi.fn(),
}));
vi.mock("./api", () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string, public data: unknown = null) { super(message); }
  },
  api: { getChapter: mocks.getChapter, saveChapter: mocks.saveChapter, arrangeScenes: mocks.arrangeScenes, moveScene: mocks.moveScene, scenes: mocks.scenes },
  describeError: (e: unknown) => e instanceof Error ? e.message : "Can't reach Lantern.",
}));
vi.mock("./local", () => ({
  draftToSave: (draft: { snapshot?: string; replacementBase?: string; content: string; revised?: number }) =>
    draft.snapshot ? { ...draft, content: draft.replacementBase ?? draft.content, revised: 0 } : draft,
  drafts: { read: mocks.readDraft, clearIf: mocks.clearIf, acknowledge: mocks.acknowledge },
  chapters: { restore: mocks.writeChapter },
  reopenStorage: mocks.reopen,
}));
vi.mock("./sync", () => ({
  forgetChapter: mocks.forget, rememberSaved: mocks.remember, openEditors: new Set<string>(),
}));
import { ApiError } from "./api";
import { arrangeChapterScenes, flushForSceneMove, moveSceneBetweenChapters } from "./sceneArrangement";
import { openEditors } from "./sync";

const chapter: ChapterMeta = { id: "c", project_id: "p", title: "First", synopsis: "", position: 0, word_count: 1, version: 1, updated_at: "", act_id: null, revision_status: "drafting" };
const server = (version: number, content: string) => ({ ...chapter, version, content });
const draft = { chapterId: "c", content: "new", baseVersion: 1, savedAt: 123 };
const result = { version: 3, word_count: 1, updated_at: "now" };

beforeEach(() => {
  vi.resetAllMocks();
  draftWriteSucceeded("c");
  openEditors.clear();
  vi.stubGlobal("navigator", { onLine: true });
  mocks.readDraft.mockResolvedValue(null);
  mocks.getChapter.mockResolvedValue(server(2, "old"));
  mocks.arrangeScenes.mockResolvedValue(result);
});

describe("moving scenes", () => {
  it("explains how to close an open chapter before moving", async () => {
    openEditors.add("c");
    await expect(flushForSceneMove(chapter)).rejects.toThrow(
      "Save First first: This chapter is open in another window. Close it there and try again.",
    );
    expect(mocks.arrangeScenes).not.toHaveBeenCalled();
  });

  it("waits for editor teardown activity before reading drafts and uses the fresh version", async () => {
    let finish!: () => void;
    const cleanupSave = new Promise<void>((resolve) => { finish = resolve; });
    trackChapterActivity("c", cleanupSave);
    const moving = arrangeChapterScenes(chapter, ["b", "a"]);
    await Promise.resolve();
    expect(mocks.readDraft).not.toHaveBeenCalled();
    finish();
    await moving;
    expect(mocks.arrangeScenes).toHaveBeenCalledWith("c", 2, ["b", "a"]);
    expect(mocks.forget).toHaveBeenCalledBefore(mocks.arrangeScenes);
    expect(mocks.writeChapter).not.toHaveBeenCalled();
  });

  it("waits for both a pending draft write and an older editor save before detecting a conflict", async () => {
    let finishWrite!: () => void;
    let finishSave!: () => void;
    const write = new Promise<void>((resolve) => { finishWrite = resolve; });
    const save = new Promise<void>((resolve) => { finishSave = resolve; });
    trackChapterActivity("c", write);
    trackChapterActivity("c", save);
    const moving = arrangeChapterScenes(chapter, ["b", "a"]);
    finishSave();
    await Promise.resolve();
    expect(mocks.readDraft).not.toHaveBeenCalled();
    mocks.readDraft.mockResolvedValue(draft);
    mocks.getChapter.mockResolvedValue(server(2, "older editor save"));
    mocks.saveChapter.mockRejectedValue(new ApiError(409, "conflict", null));
    finishWrite();
    await expect(moving).rejects.toThrow("Save First first: This chapter changed elsewhere");
    expect(mocks.clearIf).not.toHaveBeenCalled();
    expect(mocks.arrangeScenes).not.toHaveBeenCalled();
  });

  it("flushes a draft through the normal save path and uses the returned server version", async () => {
    mocks.readDraft.mockResolvedValueOnce(draft).mockResolvedValue(null);
    mocks.getChapter.mockResolvedValueOnce(server(1, "old")).mockResolvedValue(server(2, "new"));
    mocks.saveChapter.mockResolvedValue({ ...result, version: 2 });
    await arrangeChapterScenes(chapter, ["b", "a"]);
    expect(mocks.saveChapter).toHaveBeenCalledWith("c", "new", 1, { writtenAt: 123, revised: 0 });
    expect(mocks.acknowledge).toHaveBeenCalledWith(draft, 2);
    expect(mocks.arrangeScenes).toHaveBeenCalledWith("c", 2, ["b", "a"]);
  });

  it("accepts a cleanup save that already saved the same draft", async () => {
    mocks.readDraft.mockResolvedValueOnce(draft).mockResolvedValue(null);
    mocks.getChapter.mockResolvedValue(server(2, "new"));
    await flushForSceneMove(chapter);
    expect(mocks.saveChapter).not.toHaveBeenCalled();
    expect(mocks.acknowledge).toHaveBeenCalledWith(draft, 2);
  });

  it("saves revisions when a draft returns to the server text", async () => {
    const same = { ...draft, revised: 7 };
    mocks.readDraft.mockResolvedValueOnce(same).mockResolvedValue(null);
    mocks.getChapter.mockResolvedValueOnce(server(1, "new")).mockResolvedValue(server(2, "new"));
    mocks.saveChapter.mockResolvedValue({ ...result, version: 2 });
    await flushForSceneMove(chapter);
    expect(mocks.saveChapter).toHaveBeenCalledWith("c", "new", 1, { writtenAt: 123, revised: 7 });
    expect(mocks.acknowledge).toHaveBeenCalledWith(same, 2);
  });

  it("stops a move when a newer same-text draft remains after acknowledgement", async () => {
    const sent = { ...draft, revised: 2 };
    mocks.readDraft.mockResolvedValueOnce(sent).mockResolvedValue({ ...sent, baseVersion: 2, revised: 3 });
    mocks.getChapter.mockResolvedValueOnce(server(1, "new")).mockResolvedValue(server(2, "new"));
    mocks.saveChapter.mockResolvedValue({ ...result, version: 2 });
    await expect(flushForSceneMove(chapter)).rejects.toThrow("A newer draft is waiting");
    expect(mocks.clearIf).not.toHaveBeenCalled();
  });

  it("keeps a same-text draft with uncertain revision credit for conflict resolution", async () => {
    mocks.readDraft.mockResolvedValue({ ...draft, revised: 4 });
    mocks.getChapter.mockResolvedValue(server(2, "new"));
    await expect(flushForSceneMove(chapter)).rejects.toThrow("resolve the conflict");
    expect(mocks.saveChapter).not.toHaveBeenCalled();
    expect(mocks.acknowledge).not.toHaveBeenCalled();
  });

  it("flushes a restore and then its subsequent author edits before moving", async () => {
    const restored = { ...draft, content: "restored and edited", revised: 3, snapshot: "restore", replacementBase: "restored", generation: "tab" };
    const edited = { ...restored, baseVersion: 2, snapshot: undefined, replacementBase: undefined };
    mocks.readDraft.mockResolvedValueOnce(restored).mockResolvedValueOnce(edited).mockResolvedValue(null);
    mocks.getChapter.mockResolvedValueOnce(server(1, "old"))
      .mockResolvedValueOnce(server(2, "restored"))
      .mockResolvedValue(server(3, "restored and edited"));
    mocks.saveChapter.mockResolvedValueOnce({ ...result, version: 2 }).mockResolvedValueOnce({ ...result, version: 3 });
    await flushForSceneMove(chapter);
    expect(mocks.saveChapter).toHaveBeenNthCalledWith(1, "c", "restored", 1, { writtenAt: 123, revised: 0, snapshot: "restore" });
    expect(mocks.saveChapter).toHaveBeenNthCalledWith(2, "c", "restored and edited", 2, { writtenAt: 123, revised: 3 });
  });

  it("refuses conflicts, new drafts, unreadable storage and offline moves", async () => {
    mocks.readDraft.mockResolvedValue(draft);
    mocks.getChapter.mockResolvedValue(server(2, "elsewhere"));
    mocks.saveChapter.mockRejectedValue(new ApiError(409, "conflict", null));
    await expect(arrangeChapterScenes(chapter, [])).rejects.toThrow("Save First first: This chapter changed elsewhere");
    expect(mocks.arrangeScenes).not.toHaveBeenCalled();
    mocks.getChapter.mockResolvedValue(server(2, "new"));
    await expect(flushForSceneMove(chapter)).rejects.toThrow("A newer draft");
    mocks.readDraft.mockRejectedValue(new Error("Storage unavailable."));
    await expect(flushForSceneMove(chapter)).rejects.toThrow("Save First first: Storage unavailable.");
    vi.stubGlobal("navigator", { onLine: false });
    await expect(flushForSceneMove(chapter)).rejects.toThrow("Reconnect");
  });

  it("refuses an unsaved editor draft whose IndexedDB write failed", async () => {
    draftWriteFailed("c", "unprotected writing");
    await expect(arrangeChapterScenes(chapter, [])).rejects.toThrow("latest draft wasn't saved");
    expect(mocks.arrangeScenes).not.toHaveBeenCalled();
  });

  it("uses a fresh version on undo and keeps stale cache discarded if refreshing fails", async () => {
    mocks.getChapter.mockResolvedValueOnce(server(8, "moved")).mockRejectedValueOnce(new TypeError("offline"));
    await arrangeChapterScenes(chapter, ["a", "b"]);
    expect(mocks.arrangeScenes).toHaveBeenCalledWith("c", 8, ["a", "b"]);
    expect(mocks.forget).toHaveBeenCalled();
    expect(mocks.writeChapter).not.toHaveBeenCalled();
  });

  it("does not cache a response older than the move result", async () => {
    mocks.getChapter.mockResolvedValueOnce(server(2, "old")).mockResolvedValueOnce(server(2, "old"));
    await arrangeChapterScenes(chapter, ["b", "a"]);
    expect(mocks.writeChapter).not.toHaveBeenCalled();
  });

  it("refuses undo when a later scene order differs from the move", async () => {
    mocks.scenes.mockResolvedValue({ scenes: [
      { id: "a", chapter_id: "c", position: 0 }, { id: "b", chapter_id: "c", position: 1 },
    ], placeholders: [] });
    await expect(arrangeChapterScenes(chapter, ["a", "b"], { projectId: "p", sceneIds: ["b", "a"] }))
      .rejects.toThrow("Scenes changed elsewhere. Reload the scene list");
    expect(mocks.arrangeScenes).not.toHaveBeenCalled();
  });

  it("flushes both chapters, uses fresh versions and invalidates both caches after an uncertain response", async () => {
    const to = { ...chapter, id: "d", title: "Second", version: 9 };
    mocks.getChapter.mockImplementation(async (id: string) => ({ ...(id === "c" ? chapter : to), version: id === "c" ? 7 : 9, content: "old" }));
    mocks.scenes.mockResolvedValue({ scenes: [{ id: "s", chapter_id: "c", in_text: true }], placeholders: [] });
    mocks.moveScene.mockRejectedValue(new TypeError("lost reply"));
    await expect(moveSceneBetweenChapters("s", chapter, to, 1)).rejects.toThrow("lost reply");
    expect(mocks.moveScene).toHaveBeenCalledWith("s", "d", 1, { from: 7, to: 9 }, "c");
    expect(mocks.forget.mock.calls).toEqual([["c"], ["d"], ["c"], ["d"]]);
  });

  it("refuses a stale insertion index or a scene moved to another chapter", async () => {
    const to = { ...chapter, id: "d", title: "Second", version: 3 };
    mocks.getChapter.mockImplementation(async (id: string) => ({ ...(id === "c" ? chapter : to), version: id === "c" ? 7 : 4, content: "old" }));
    mocks.scenes.mockResolvedValue({ scenes: [{ id: "s", chapter_id: "c", in_text: true }], placeholders: [] });
    await expect(moveSceneBetweenChapters("s", chapter, to, 1)).rejects.toThrow("text in Second changed");
    mocks.scenes.mockResolvedValue({ scenes: [{ id: "s", chapter_id: "elsewhere", in_text: true }], placeholders: [] });
    await expect(moveSceneBetweenChapters("s", chapter, to, null)).rejects.toThrow("scene moved elsewhere");
    expect(mocks.moveScene).not.toHaveBeenCalled();
    expect(mocks.forget).not.toHaveBeenCalled();
  });

  it("does not use a drop index from before a destination draft was flushed", async () => {
    const to = { ...chapter, id: "d", title: "Second", version: 3 };
    const destinationDraft = { ...draft, chapterId: "d", baseVersion: 3 };
    let saved = false;
    let read = false;
    mocks.getChapter.mockImplementation(async (id: string) => id === "c"
      ? { ...chapter, version: 7, content: "old" }
      : { ...to, version: saved ? 4 : 3, content: saved ? "new" : "old" });
    mocks.readDraft.mockImplementation(async (id: string) => {
      if (id !== "d" || read) return null;
      read = true;
      return destinationDraft;
    });
    mocks.saveChapter.mockImplementation(async () => { saved = true; return { ...result, version: 4 }; });
    mocks.scenes.mockResolvedValue({ scenes: [{ id: "s", chapter_id: "c", in_text: true }], placeholders: [] });
    await expect(moveSceneBetweenChapters("s", chapter, to, 1)).rejects.toThrow("text in Second changed");
    expect(mocks.saveChapter).toHaveBeenCalledWith("d", "new", 3, { writtenAt: 123, revised: 0 });
    expect(mocks.moveScene).not.toHaveBeenCalled();
  });

  it("refuses the whole move if the destination draft conflicts", async () => {
    const to = { ...chapter, id: "d", title: "Second" };
    mocks.readDraft.mockImplementation(async (id: string) => id === "d" ? { ...draft, chapterId: "d" } : null);
    mocks.saveChapter.mockRejectedValue(new ApiError(409, "conflict", null));
    await expect(moveSceneBetweenChapters("s", chapter, to, null)).rejects.toThrow("Save Second first");
    expect(mocks.moveScene).not.toHaveBeenCalled();
    expect(mocks.forget).not.toHaveBeenCalled();
  });

  it("undo checks the fresh scene location and original chapter version after flushing", async () => {
    const to = { ...chapter, id: "d", title: "Second" };
    mocks.getChapter.mockImplementation(async (id: string) => ({ ...(id === "c" ? chapter : to), version: id === "c" ? 8 : 10, content: "old" }));
    mocks.scenes.mockResolvedValue({ scenes: [{ id: "s", chapter_id: "c", in_text: true }], placeholders: [] });
    await expect(moveSceneBetweenChapters("s", to, chapter, 2, { projectId: "p", destinationVersion: 8 }))
      .rejects.toThrow("scene moved elsewhere");
    mocks.scenes.mockResolvedValue({ scenes: [{ id: "s", chapter_id: "d", in_text: true }], placeholders: [] });
    await expect(moveSceneBetweenChapters("s", to, chapter, 2, { projectId: "p", destinationVersion: 7 }))
      .rejects.toThrow("text in First changed");
    expect(mocks.moveScene).not.toHaveBeenCalled();
    mocks.moveScene.mockResolvedValue({ from: { version: 11, word_count: 1 }, to: { version: 9, word_count: 2 }, from_passage_index: 0 });
    await moveSceneBetweenChapters("s", to, chapter, 2, { projectId: "p", destinationVersion: 8 });
    expect(mocks.moveScene).toHaveBeenCalledWith("s", "c", 2, { from: 10, to: 8 }, "d");
  });

  it("refuses undo when flushing the original chapter changes its passage indices", async () => {
    const from = { ...chapter, id: "d", title: "Second" };
    let saved = false;
    let read = false;
    mocks.getChapter.mockImplementation(async (id: string) => id === "d"
      ? { ...from, version: 10, content: "old" }
      : { ...chapter, version: saved ? 9 : 8, content: saved ? "new" : "old" });
    mocks.readDraft.mockImplementation(async (id: string) => {
      if (id !== "c" || read) return null;
      read = true;
      return { ...draft, baseVersion: 8 };
    });
    mocks.saveChapter.mockImplementation(async () => { saved = true; return { ...result, version: 9 }; });
    mocks.scenes.mockResolvedValue({ scenes: [{ id: "s", chapter_id: "d", in_text: true }], placeholders: [] });
    await expect(moveSceneBetweenChapters("s", from, chapter, 2, { projectId: "p", destinationVersion: 8 }))
      .rejects.toThrow("text in First changed");
    expect(mocks.saveChapter).toHaveBeenCalledWith("c", "new", 8, { writtenAt: 123, revised: 0 });
    expect(mocks.moveScene).not.toHaveBeenCalled();
  });
});
