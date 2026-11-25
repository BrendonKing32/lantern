import { beforeEach, describe, expect, it, vi } from "vitest";
import { chapterKey, chapterPut, getChapterRow, reconcileChapter } from "./db";
import type { Env } from "./env";
import { deleteChapter, getChapter, saveChapter, updateChapter, writeChapter } from "./handlers/chapters";
import { HttpError } from "./http";
import { draftAsClaude, EditError } from "./mcp/writes";
import { memoryR2, sqliteD1 } from "./testing/d1";

let db: ReturnType<typeof sqliteD1>;
let bucket: ReturnType<typeof memoryR2>;
let env: Env;
const ts = "2026-01-01T00:00:00.000Z";
const key = chapterKey("p", "c");

beforeEach(() => {
  db = sqliteD1();
  bucket = memoryR2();
  env = { DB: db, BUCKET: bucket } as unknown as Env;
  db.raw.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('p', 'Book', ?, ?)").run(ts, ts);
  db.raw.prepare("INSERT INTO chapters (id, project_id, title, position, created_at, updated_at) VALUES ('c', 'p', 'Chapter', 0, ?, ?)")
    .run(ts, ts);
  bucket.objects.set(key, "Original text.");
});

function lock(until: string) {
  db.raw.prepare("UPDATE chapters SET moving_until = ? WHERE id = 'c'").run(until);
}

function current() {
  return db.raw.prepare("SELECT version, word_count FROM chapters WHERE id = 'c'").get() as { version: number; word_count: number };
}

describe("chapter move locks and recovery", () => {
  it("reconciles an R2 version ahead of D1 on reads and rejects stale writes", async () => {
    await chapterPut(env, { id: "c", project_id: "p" }, "One two three", 2);
    const response = await getChapter(new Request("https://example.test"), env, { id: "c" });
    expect(await response.json()).toMatchObject({ version: 2, word_count: 3, content: "One two three" });
    await expect(writeChapter(env, await getChapterRow(env, "c"), "Stale", 0, "auto"))
      .rejects.toMatchObject({ status: 409, extra: { version: 2 } });
    expect(bucket.objects.get(key)).toBe("One two three");
  });

  it("reconciles before saving even without an earlier read", async () => {
    await chapterPut(env, { id: "c", project_id: "p" }, "Recovered words", 1);
    const request = new Request("https://example.test", { method: "PUT", body: JSON.stringify({ content: "New words", baseVersion: 1 }) });
    await saveChapter(request, env, { id: "c" });
    expect(current()).toEqual({ version: 2, word_count: 2 });
  });

  it("does not roll D1 backward or reject ordinary saves when D1 is ahead", async () => {
    db.raw.prepare("UPDATE chapters SET version = 3 WHERE id = 'c'").run();
    await chapterPut(env, { id: "c", project_id: "p" }, "Older text", 2);
    const row = await reconcileChapter(env, await getChapterRow(env, "c"));
    expect(row.version).toBe(3);
    await writeChapter(env, row, "Accepted text", 3, "auto");
    expect(current()).toEqual({ version: 4, word_count: 2 });
  });

  it("blocks saves and Claude while a lock is active, without advancing reconciliation", async () => {
    await chapterPut(env, { id: "c", project_id: "p" }, "Already moved", 1);
    lock(new Date(Date.now() + 30_000).toISOString());
    const row = await reconcileChapter(env, await getChapterRow(env, "c"));
    expect(row.version).toBe(0);
    try {
      await writeChapter(env, row, "Not saved", 0, "auto");
      throw new Error("Expected a lock");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ status: 423, extra: { retryAfter: expect.any(Number) } });
    }
    await expect(draftAsClaude(env, "c", 0, () => "Not saved", [{ kind: "set", text: "Not saved" }])).rejects.toBeInstanceOf(EditError);
    expect(current().version).toBe(0);
    expect(bucket.objects.get(key)).toBe("Already moved");
  });

  it("repairs after an expired lock and lets Claude save at the repaired version", async () => {
    lock(new Date(Date.now() - 1000).toISOString());
    await chapterPut(env, { id: "c", project_id: "p" }, "Recovered words", 1);
    await expect(draftAsClaude(env, "c", 0, () => "Stale", [{ kind: "set", text: "Stale" }])).rejects.toThrow("version 1");
    await draftAsClaude(env, "c", 1, () => "Claude writes new words", [{ kind: "set", text: "Claude writes new words" }]);
    expect(current()).toEqual({ version: 1, word_count: 2 });
  });

  it("keeps ordinary reads available but blocks chapter changes during a move", async () => {
    lock(new Date(Date.now() + 30_000).toISOString());
    const req = new Request("https://example.test", { method: "PATCH", body: JSON.stringify({ title: "Changed" }) });
    expect((await getChapter(new Request("https://example.test"), env, { id: "c" })).status).toBe(200);
    await expect(updateChapter(req, env, { id: "c" })).rejects.toMatchObject({ status: 423 });
    await expect(deleteChapter(new Request("https://example.test"), env, { id: "c" }))
      .rejects.toMatchObject({ status: 423 });
  });

  it("does not reconcile if a move acquires its lock while R2 is being read", async () => {
    await chapterPut(env, { id: "c", project_id: "p" }, "Moved words", 1);
    const get = bucket.get.bind(bucket);
    vi.spyOn(bucket, "get").mockImplementation(async (objectKey) => {
      const object = await get(objectKey);
      if (!object) return object;
      return { ...object, text: async () => {
        lock(new Date(Date.now() + 60_000).toISOString());
        return object.text();
      } };
    });
    const row = await reconcileChapter(env, await getChapterRow(env, "c"));
    expect(row.version).toBe(0);
    expect(current().version).toBe(0);
  });

  it("re-reads R2 if a move completes during reconciliation", async () => {
    await chapterPut(env, { id: "c", project_id: "p" }, "Old recovered text", 1);
    const get = bucket.get.bind(bucket);
    let first = true;
    vi.spyOn(bucket, "get").mockImplementation(async (objectKey) => {
      const object = await get(objectKey);
      if (!object || !first) return object;
      first = false;
      return { ...object, text: async () => {
        lock(new Date(Date.now() - 1000).toISOString());
        await chapterPut(env, { id: "c", project_id: "p" }, "The newer recovered text", 2);
        return object.text();
      } };
    });
    const row = await reconcileChapter(env, await getChapterRow(env, "c"));
    expect(row).toMatchObject({ version: 2, word_count: 4 });
    expect(current()).toEqual({ version: 2, word_count: 4 });
  });

  it.each(["author", "claude"])("refuses a stale %s claim after a completed move", async (author) => {
    const get = bucket.get.bind(bucket);
    let first = true;
    vi.spyOn(bucket, "get").mockImplementation(async (objectKey) => {
      const object = await get(objectKey);
      if (first) {
        first = false;
        lock(new Date(Date.now() - 1000).toISOString());
        await chapterPut(env, { id: "c", project_id: "p" }, "Moved words", 1);
      }
      return object;
    });
    if (author === "author") {
      await expect(writeChapter(env, await getChapterRow(env, "c"), "Stale edit", 0, "auto"))
        .rejects.toMatchObject({ status: 409 });
    } else {
      await expect(draftAsClaude(env, "c", 0, () => "Stale edit", [{ kind: "set", text: "Stale edit" }])).rejects.toBeInstanceOf(EditError);
    }
    expect(bucket.objects.get(key)).toBe("Moved words");
  });
});
