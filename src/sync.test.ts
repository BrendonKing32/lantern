import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveChapter: vi.fn(),
  draftsAll: vi.fn(),
  draftsClearIf: vi.fn(),
  chapterRead: vi.fn(),
  chapterWrite: vi.fn(),
}));

vi.mock("./api", () => ({
  api: { saveChapter: mocks.saveChapter },
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string, public data: Record<string, unknown> | null) {
      super(message);
    }
  },
}));

vi.mock("./local", () => ({
  DraftStorageError: class DraftStorageError extends Error {},
  drafts: { all: mocks.draftsAll, clearIf: mocks.draftsClearIf },
  chapters: { read: mocks.chapterRead, write: mocks.chapterWrite },
}));

import { ApiError } from "./api";
import { DraftStorageError } from "./local";
import { draftReadProblem, syncDrafts } from "./sync";

const draft = { chapterId: "chapter-1", content: "A draft.", baseVersion: 4, savedAt: 123 };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.draftsAll.mockResolvedValue([draft]);
  mocks.draftsClearIf.mockResolvedValue(undefined);
  mocks.chapterRead.mockResolvedValue({
    id: draft.chapterId,
    project_id: "project-1",
    title: "Chapter 1",
    synopsis: "",
    position: 0,
    word_count: 0,
    version: 4,
    updated_at: "",
    content: "",
  });
  mocks.chapterWrite.mockResolvedValue(undefined);
});

describe("offline draft sync", () => {
  it("clears and updates the cached chapter after a successful save", async () => {
    const result = { version: 5, word_count: 2, updated_at: "now" };
    mocks.saveChapter.mockResolvedValue(result);

    await expect(syncDrafts()).resolves.toBe("done");

    expect(mocks.saveChapter).toHaveBeenCalledWith(
      draft.chapterId,
      draft.content,
      draft.baseVersion,
      { writtenAt: draft.savedAt },
    );
    expect(mocks.draftsClearIf).toHaveBeenCalledWith(draft.chapterId, draft.content);
    expect(mocks.chapterWrite).toHaveBeenCalledWith(
      expect.objectContaining({ ...result, content: draft.content }),
    );
  });

  it("keeps a conflicting draft for the writer to resolve", async () => {
    mocks.saveChapter.mockRejectedValue(new ApiError(409, "conflict", { version: 5 }));

    await syncDrafts();

    expect(mocks.draftsClearIf).not.toHaveBeenCalled();
    expect(mocks.chapterWrite).not.toHaveBeenCalled();
  });

  it("reports a storage failure instead of treating it as an empty queue", async () => {
    mocks.draftsAll.mockRejectedValue(new DraftStorageError("couldn't read drafts"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(syncDrafts()).resolves.toBe("storage-error");

    expect(mocks.saveChapter).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("flags unreadable drafts for the notice until a later read succeeds", async () => {
    mocks.saveChapter.mockResolvedValue({ version: 5, word_count: 2, updated_at: "now" });
    await syncDrafts(); // start from a good read
    expect(draftReadProblem.get()).toBe(false);
    const listener = vi.fn();
    const stop = draftReadProblem.subscribe(listener);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.draftsAll.mockRejectedValueOnce(new DraftStorageError("couldn't read drafts"));

    await syncDrafts();
    expect(draftReadProblem.get()).toBe(true);

    await syncDrafts();
    expect(draftReadProblem.get()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);

    stop();
    warn.mockRestore();
  });

  it("reports an empty queue as done", async () => {
    mocks.draftsAll.mockResolvedValue([]);

    await expect(syncDrafts()).resolves.toBe("done");
  });

  it("reports offline when the server can't be reached", async () => {
    mocks.saveChapter.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(syncDrafts()).resolves.toBe("offline");
    expect(mocks.draftsClearIf).not.toHaveBeenCalled();
  });
});
