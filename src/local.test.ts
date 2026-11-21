import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("localStorage", {
    length: 0,
    key: () => null,
    getItem: () => null,
    removeItem: () => undefined,
  });
  vi.stubGlobal("indexedDB", new IDBFactory());
});

describe("draft storage", () => {
  it("round-trips an unsaved draft", async () => {
    const { drafts } = await import("./local");

    await drafts.write("chapter-1", "A new scene.", 7);

    await expect(drafts.read("chapter-1")).resolves.toMatchObject({
      chapterId: "chapter-1",
      content: "A new scene.",
      baseVersion: 7,
    });

  });

  it("rejects instead of claiming a draft was stored when IndexedDB is unavailable", async () => {
    vi.stubGlobal("indexedDB", { open: () => { throw new Error("blocked"); } });
    const { DraftStorageError, drafts } = await import("./local");

    await expect(drafts.write("chapter-1", "A new scene.", 7)).rejects.toBeInstanceOf(DraftStorageError);
    await expect(drafts.read("chapter-1")).rejects.toBeInstanceOf(DraftStorageError);
    await expect(drafts.all()).rejects.toBeInstanceOf(DraftStorageError);
  });

  it("tells an empty draft list apart from one it couldn't read", async () => {
    const { DraftStorageError, drafts } = await import("./local");
    await expect(drafts.all()).resolves.toEqual([]);

    await drafts.write("chapter-1", "A new scene.", 7);
    await expect(drafts.all()).resolves.toMatchObject([{ chapterId: "chapter-1" }]);

    const getAll = vi.spyOn(IDBObjectStore.prototype, "getAll").mockImplementation(() => {
      throw new DOMException("read failed", "UnknownError");
    });
    try {
      await expect(drafts.all()).rejects.toBeInstanceOf(DraftStorageError);
    } finally {
      getAll.mockRestore();
    }
  });

  describe("last chapter storage", () => {
    it("remembers a chapter separately for each novel", async () => {
      const { cache } = await import("./local");

      await cache.setLastChapter("novel-1", "chapter-2");
      await cache.setLastChapter("novel-2", "chapter-3");

      await expect(cache.lastChapter("novel-1")).resolves.toBe("chapter-2");
      await expect(cache.lastChapter("novel-2")).resolves.toBe("chapter-3");
      await expect(cache.lastChapter("novel-3")).resolves.toBeNull();
    });

    it("falls back safely when storage is unavailable", async () => {
      vi.stubGlobal("indexedDB", { open: () => { throw new Error("blocked"); } });
      const { cache } = await import("./local");

      await expect(cache.setLastChapter("novel-1", "chapter-2")).resolves.toBeUndefined();
      await expect(cache.lastChapter("novel-1")).resolves.toBeNull();
    });

    it("uses the cached chapter list to resume or fall back offline", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
      const { cache } = await import("./local");
      const { loadProject } = await import("./sync");
      const { selectChapter } = await import("./resume");
      const chapter = (id: string) => ({
        id, project_id: "novel-1", title: id, synopsis: "", position: 0,
        word_count: 0, version: 1, updated_at: "",
      });
      await cache.setProject({
        project: {
          id: "novel-1", title: "Novel", created_at: "", updated_at: "",
          target_words: null, target_date: null, dialect: "american",
        },
        chapters: [chapter("first"), chapter("last")],
      });
      await cache.setLastChapter("novel-1", "last");

      const loaded = await loadProject("novel-1");
      expect(loaded.offline).toBe(true);
      expect(selectChapter(loaded.data.chapters, undefined, await cache.lastChapter("novel-1"))?.id).toBe("last");

      await cache.setLastChapter("novel-1", "deleted");
      expect(selectChapter(loaded.data.chapters, undefined, await cache.lastChapter("novel-1"))?.id).toBe("first");
    });
  });
});
