import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";
import { migrateShareToken, shareTokenKey } from "./shareTokens";

function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  } as Storage;
}

afterEach(() => vi.restoreAllMocks());

describe("legacy share token migration", () => {
  it("verifies and moves a token only when exactly one link is active", async () => {
    const verify = vi.spyOn(api, "getSharedProject").mockResolvedValue({ project: { title: "Book" }, label: "", chapters: [] });
    for (const ids of [[], ["a"], ["a", "b"]]) {
      const store = storage();
      store.setItem(shareTokenKey("project"), "old");
      await migrateShareToken(store, "project", ids);
      expect(store.getItem(shareTokenKey("project"))).toBeNull();
      expect(store.getItem(shareTokenKey("a"))).toBe(ids.length === 1 ? "old" : null);
    }
    expect(verify).toHaveBeenCalledExactlyOnceWith("old");
  });
  it("does not overwrite a newer copy", async () => {
    const verify = vi.spyOn(api, "getSharedProject");
    const store = storage();
    store.setItem(shareTokenKey("project"), "old");
    store.setItem(shareTokenKey("a"), "new");
    await migrateShareToken(store, "project", ["a"]);
    expect(store.getItem(shareTokenKey("a"))).toBe("new");
    expect(store.getItem(shareTokenKey("project"))).toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });
  it("does not associate a revoked legacy token with its replacement", async () => {
    vi.spyOn(api, "getSharedProject").mockRejectedValue(new ApiError(404, "Review link not found", null));
    const store = storage();
    store.setItem(shareTokenKey("project"), "revoked");
    expect(await migrateShareToken(store, "project", ["replacement"])).toBe("done");
    expect(store.getItem(shareTokenKey("project"))).toBeNull();
    expect(store.getItem(shareTokenKey("replacement"))).toBeNull();
  });
  it.each([new TypeError("network unavailable"), new ApiError(503, "Unavailable", null)])(
    "retains the only copy when verification fails transiently: %s", async (failure) => {
      const verify = vi.spyOn(api, "getSharedProject").mockRejectedValueOnce(failure)
        .mockResolvedValueOnce({ project: { title: "Book" }, label: "", chapters: [] });
      const store = storage();
      store.setItem(shareTokenKey("project"), "old");
      expect(await migrateShareToken(store, "project", ["a"])).toBe("deferred");
      expect(store.getItem(shareTokenKey("project"))).toBe("old");
      expect(store.getItem(shareTokenKey("a"))).toBeNull();
      expect(await migrateShareToken(store, "project", ["a"])).toBe("done");
      expect(store.getItem(shareTokenKey("a"))).toBe("old");
      expect(store.getItem(shareTokenKey("project"))).toBeNull();
      expect(verify).toHaveBeenCalledTimes(2);
    },
  );
  it("keeps the original if writing the new key fails", async () => {
    vi.spyOn(api, "getSharedProject").mockResolvedValue({ project: { title: "Book" }, label: "", chapters: [] });
    const store = storage();
    store.setItem(shareTokenKey("project"), "old");
    vi.spyOn(store, "setItem").mockImplementation(() => { throw new Error("storage full"); });
    await expect(migrateShareToken(store, "project", ["a"])).rejects.toThrow("storage full");
    expect(store.getItem(shareTokenKey("project"))).toBe("old");
  });
});
