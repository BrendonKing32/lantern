import { IDBFactory } from "fake-indexeddb";
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
  });
});
