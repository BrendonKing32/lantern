import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterMeta } from "../shared/types";
import { draftWriteFailed, draftWriteSucceeded, trackChapterActivity } from "./chapterActivity";

const mocks = vi.hoisted(() => ({
  getChapter: vi.fn(), saveChapter: vi.fn(), arrangeScenes: vi.fn(), scenes: vi.fn(),
  readDraft: vi.fn(), clearIf: vi.fn(), reopen: vi.fn(), writeChapter: vi.fn(),
  forget: vi.fn(), remember: vi.fn(),
}));
vi.mock("./api", () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string, public data: unknown = null) { super(message); }
  },
  api: { getChapter: mocks.getChapter, saveChapter: mocks.saveChapter, arrangeScenes: mocks.arrangeScenes, scenes: mocks.scenes },
  describeError: (e: unknown) => e instanceof Error ? e.message : "Can't reach Lantern.",
}));
vi.mock("./local", () => ({
  drafts: { read: mocks.readDraft, clearIf: mocks.clearIf },
  chapters: { restore: mocks.writeChapter },
  reopenStorage: mocks.reopen,
}));
vi.mock("./sync", () => ({
  forgetChapter: mocks.forget, rememberSaved: mocks.remember, openEditors: new Set<string>(),
}));
import { ApiError } from "./api";
import { arrangeChapterScenes, flushForSceneMove } from "./sceneArrangement";
import { openEditors } from "./sync";

const chapter: ChapterMeta = { id: "c", project_id: "p", title: "First", synopsis: "", position: 0, word_count: 1, version: 1, updated_at: "", act_id: null };
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
    expect(mocks.saveChapter).toHaveBeenCalledWith("c", "new", 1, { writtenAt: 123 });
    expect(mocks.clearIf).toHaveBeenCalledWith("c", "new");
    expect(mocks.arrangeScenes).toHaveBeenCalledWith("c", 2, ["b", "a"]);
  });

  it("accepts a cleanup save that already saved the same draft", async () => {
    mocks.readDraft.mockResolvedValueOnce(draft).mockResolvedValue(null);
    mocks.getChapter.mockResolvedValue(server(2, "new"));
    await flushForSceneMove(chapter);
    expect(mocks.saveChapter).not.toHaveBeenCalled();
    expect(mocks.clearIf).toHaveBeenCalledWith("c", "new");
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
});
