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
      word_count: 1, version: 1, updated_at: "", act_id: null, content: "old", revision_status: "drafting" as const,
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

  it("acknowledges only the sent revisions even when later edits return to the sent text", async () => {
    const { drafts } = await import("./local");
    await drafts.write("c", "same", 1, 4);
    const sent = (await drafts.read("c"))!;
    await drafts.write("c", "same", 1, 9);
    await drafts.acknowledge(sent, 2);
    expect(await drafts.read("c")).toMatchObject({ content: "same", baseVersion: 2, revised: 5 });
    const next = (await drafts.read("c"))!;
    await drafts.acknowledge(next, 3);
    expect(await drafts.read("c")).toBeNull();
  });

  it("does not credit discarded conflict revisions after a conflict draft is reset", async () => {
    const { drafts } = await import("./local");
    await drafts.write("c", "mine", 1, 10);
    await drafts.write("c", "mine", 2, 0, "conflict");
    const sent = (await drafts.read("c"))!;
    await drafts.write("c", "mine again", 2, 3, "conflict");
    await drafts.acknowledge(sent, 3);
    expect(await drafts.read("c")).toMatchObject({ content: "mine again", baseVersion: 3, revised: 3, snapshot: undefined });
  });

  it("does not acknowledge an older save over a restored draft at the same base version", async () => {
    const { drafts } = await import("./local");
    await drafts.write("c", "old", 2, 10, undefined, "tab", undefined, "before");
    const sent = (await drafts.read("c"))!;
    await drafts.write("c", "restored", 2, 0, "restore", "tab", "restored", "after");
    await drafts.acknowledge(sent, 3);
    expect(await drafts.read("c")).toMatchObject({ content: "restored", baseVersion: 2, revised: 0, snapshot: "restore" });
  });

  it("does not rebase or delete a different editor's draft", async () => {
    const { drafts } = await import("./local");
    await drafts.write("c", "one tab", 1, 3, undefined, "tab-one");
    const sent = (await drafts.read("c"))!;
    expect(await drafts.adopt(sent, "tab-two")).toBe(true);
    await drafts.write("c", "other tab", 1, 6, undefined, "tab-two");
    await drafts.acknowledge(sent, 2);
    await drafts.clearOwned("c", "tab-one");
    expect(await drafts.read("c")).toMatchObject({ content: "other tab", baseVersion: 1, revised: 6, generation: "tab-two" });
    await expect(drafts.write("c", "late tab one", 2, 4, undefined, "tab-one")).rejects.toThrow("another tab");
    expect(await drafts.read("c")).toMatchObject({ content: "other tab", baseVersion: 1, revised: 6, generation: "tab-two" });
  });

  it("claims a recovered draft without changing its pending work, and rejects stale claims", async () => {
    const { drafts } = await import("./local");
    await drafts.write("c", "saved draft", 1, 8, "restore", "old", "restored");
    const recovered = (await drafts.read("c"))!;
    expect(await drafts.adopt(recovered, "new-tab")).toBe(true);
    expect(await drafts.read("c")).toMatchObject({ content: "saved draft", baseVersion: 1, revised: 8, snapshot: "restore", replacementBase: "restored", generation: "new-tab" });
    expect(await drafts.adopt(recovered, "other-tab")).toBe(false);
    await drafts.acknowledge(recovered, 2);
    expect(await drafts.read("c")).toMatchObject({ baseVersion: 1, revised: 8, generation: "new-tab" });
  });

  it("saves an offline restore before crediting later author edits", async () => {
    const { drafts } = await import("./local");
    const { syncDrafts } = await import("./sync");
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 3, word_count: 1, updated_at: "now" })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 4, word_count: 2, updated_at: "now" })));
    vi.stubGlobal("fetch", fetcher);
    await drafts.write("c", "restored plus author", 2, 2, "restore", "tab-one", "restored");
    expect(await syncDrafts()).toBe("offline");
    expect(await drafts.read("c")).toMatchObject({ revised: 2, snapshot: "restore" });
    expect(await syncDrafts()).toBe("done");
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ content: "restored", baseVersion: 2, revised: 0, snapshot: "restore" });
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toMatchObject({ content: "restored plus author", baseVersion: 3, revised: 2 });
    expect(await drafts.read("c")).toBeNull();
  });

  it("keeps author edits queued if the save after a restore fails", async () => {
    const { drafts } = await import("./local");
    const { syncDrafts } = await import("./sync");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 3, word_count: 1, updated_at: "now" })))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 4, word_count: 2, updated_at: "now" })));
    vi.stubGlobal("fetch", fetcher);
    await drafts.write("c", "restored plus author", 2, 2, "restore", "tab-one", "restored");
    expect(await syncDrafts()).toBe("offline");
    expect(await drafts.read("c")).toMatchObject({ content: "restored plus author", baseVersion: 3, revised: 2, snapshot: undefined });
    expect(await syncDrafts()).toBe("done");
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toMatchObject({ content: "restored plus author", baseVersion: 3, revised: 2 });
    expect(await drafts.read("c")).toBeNull();
  });

  it("waits for queued sync acknowledgement before recovering a draft in an editor", async () => {
    const { drafts } = await import("./local");
    const { syncDrafts, openEditors } = await import("./sync");
    const { waitForChapterActivity } = await import("./chapterActivity");
    let finish!: (response: Response) => void;
    let started!: () => void;
    const requested = new Promise<void>((resolve) => { started = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => {
      started();
      return new Promise<Response>((resolve) => { finish = resolve; });
    }));
    await drafts.write("c", "draft", 2, 4, undefined, "original");
    const syncing = syncDrafts();
    await requested;
    openEditors.add("c");
    const recovery = (async () => {
      await waitForChapterActivity("c");
      return drafts.read("c");
    })();
    finish(new Response(JSON.stringify({ version: 3, word_count: 1, updated_at: "now" })));
    expect(await syncing).toBe("done");
    expect(await recovery).toBeNull();
    openEditors.delete("c");
  });

  it("updates cached chapter statuses atomically for different chapters", async () => {
    const { cache } = await import("./local");
    const chapter = (id: string) => ({
      id, project_id: "p", title: id, synopsis: "", position: 0, word_count: 0,
      version: 0, updated_at: "", act_id: null, revision_status: "drafting" as const,
    });
    await cache.setProject({
      project: { id: "p", title: "Book", created_at: "", updated_at: "", target_words: null, target_date: null, dialect: "american" },
      chapters: [chapter("a"), chapter("b")], acts: [],
    });
    await Promise.all([cache.setChapterStatus("p", "a", "revising"), cache.setChapterStatus("p", "b", "done")]);
    expect((await cache.project("p"))?.chapters.map((c) => c.revision_status)).toEqual(["revising", "done"]);
  });

  it("sends a persisted offline count once and leaves it queued after failure", async () => {
    const { drafts } = await import("./local");
    const { syncDrafts } = await import("./sync");
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 3, word_count: 1, updated_at: "now" })));
    vi.stubGlobal("fetch", fetcher);
    await drafts.write("c", "one", 2, 8);
    expect(await syncDrafts()).toBe("offline");
    expect(await drafts.read("c")).toMatchObject({ revised: 8, baseVersion: 2 });
    expect(await syncDrafts()).toBe("done");
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ revised: 8, baseVersion: 2, content: "one" });
    expect(await drafts.read("c")).toBeNull();
    await syncDrafts();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("syncs older drafts without a revised field as zero", async () => {
    const { drafts } = await import("./local");
    const { syncDrafts } = await import("./sync");
    await drafts.write("c", "old", 2);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("lantern", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("drafts", "readwrite");
      tx.objectStore("drafts").put({ chapterId: "c", content: "old", baseVersion: 2, savedAt: 123 });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: 3, word_count: 1, updated_at: "now" })));
    vi.stubGlobal("fetch", fetcher);
    expect(await syncDrafts()).toBe("done");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ revised: 0 });
    expect(await drafts.read("c")).toBeNull();
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
        word_count: 0, version: 1, updated_at: "", act_id: null, revision_status: "drafting" as const,
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
