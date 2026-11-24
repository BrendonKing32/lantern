import { forceCloseDatabase, IDBFactory, IDBObjectStore } from "fake-indexeddb";
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
  it("does not let late old chapter writes replace or resurrect invalidated text", async () => {
    const { chapters } = await import("./local");
    const old = {
      id: "c", project_id: "p", title: "First", synopsis: "", position: 0,
      word_count: 1, version: 1, updated_at: "", act_id: null, content: "old",
    };
    await chapters.write(old);
    await chapters.invalidate("c");
    await chapters.write(old);
    expect(await chapters.read("c")).toBeNull();
    await chapters.restore({ ...old, version: 2, content: "moved" });
    await chapters.write(old);
    expect(await chapters.read("c")).toMatchObject({ version: 2, content: "moved" });
  });
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

  it("opens storage again on request after a failed open, without a reload", async () => {
    const working = new IDBFactory();
    let available = false;
    vi.stubGlobal("indexedDB", {
      open: (...args: Parameters<IDBFactory["open"]>) => {
        if (!available) throw new Error("blocked");
        return working.open(...args);
      },
    });
    const { DraftStorageError, drafts, reopenStorage } = await import("./local");

    await expect(drafts.all()).rejects.toBeInstanceOf(DraftStorageError);
    available = true;
    // The failed open is remembered until something asks to try again.
    await expect(drafts.all()).rejects.toBeInstanceOf(DraftStorageError);

    await reopenStorage();
    await expect(drafts.all()).resolves.toEqual([]);
  });

  it("keeps a working connection when asked to reopen", async () => {
    const factory = new IDBFactory();
    const open = vi.spyOn(factory, "open");
    vi.stubGlobal("indexedDB", factory);
    const { drafts, reopenStorage } = await import("./local");

    await drafts.write("chapter-1", "A new scene.", 7);
    await reopenStorage();
    await expect(drafts.all()).resolves.toHaveLength(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("opens a fresh connection after the browser closes it", async () => {
    const factory = new IDBFactory();
    const connections: IDBDatabase[] = [];
    const realOpen = factory.open.bind(factory);
    vi.spyOn(factory, "open").mockImplementation((...args) => {
      const req = realOpen(...args);
      req.addEventListener("success", () => connections.push(req.result));
      return req;
    });
    vi.stubGlobal("indexedDB", factory);
    const { drafts } = await import("./local");

    await drafts.write("chapter-1", "A new scene.", 7);
    forceCloseDatabase(connections[0] as unknown as Parameters<typeof forceCloseDatabase>[0]);

    await expect(drafts.all()).resolves.toHaveLength(1);
    expect(connections).toHaveLength(2);
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
        word_count: 0, version: 1, updated_at: "", act_id: null,
      });
      await cache.setProject({
        project: {
          id: "novel-1", title: "Novel", created_at: "", updated_at: "",
          target_words: null, target_date: null, dialect: "american",
        },
        chapters: [chapter("first"), chapter("last")],
        acts: [],
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
