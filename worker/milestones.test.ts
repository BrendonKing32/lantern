import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";
import { cleanupIncompleteMilestones } from "./handlers/milestones";
import { memoryR2, sqliteD1 } from "./testing/d1";

let db: ReturnType<typeof sqliteD1>;
let bucket: ReturnType<typeof memoryR2>;
let env: Env;
const ts = "2026-01-01T00:00:00.000Z";
beforeEach(async () => {
  db = sqliteD1();
  bucket = memoryR2();
  env = { DB: db, BUCKET: bucket, ASSETS: { fetch: async () => new Response() }, DEV_BYPASS: "true" } as unknown as Env;
  db.raw.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('p', 'Book', ?, ?)").run(ts, ts);
  db.raw.prepare("INSERT INTO chapters (id, project_id, title, position, created_at, updated_at) VALUES (?, 'p', ?, ?, ?, ?)")
    .run("a", "First", 0, ts, ts);
  db.raw.prepare("INSERT INTO chapters (id, project_id, title, position, created_at, updated_at) VALUES (?, 'p', ?, ?, ?, ?)")
    .run("b", "Second", 1, ts, ts);
  await bucket.put("projects/p/chapters/a.md", "First text", { customMetadata: { version: "2" } });
  await bucket.put("projects/p/chapters/b.md", "Second text here", { customMetadata: { version: "0" } });
});
const request = (method: string, path: string, payload?: unknown) => worker.fetch(new Request(`https://lantern.test${path}`, {
  method, headers: { "content-type": "application/json" }, body: payload === undefined ? undefined : JSON.stringify(payload),
}), env);
const create = () => request("POST", "/api/projects/p/milestones", { name: "Draft 1", note: "Sent to readers" });

describe("milestones", () => {
  it("reads only complete milestone chapters, including deleted chapters", async () => {
    const milestone = await (await create()).json() as { id: string };
    await request("DELETE", "/api/chapters/a");
    const path = `/api/milestones/${milestone.id}/chapters`;
    expect(await (await request("GET", path)).json()).toMatchObject([
      { chapter_id: "a", title: "First", version: 2 },
      { chapter_id: "b", title: "Second", version: 0 },
    ]);
    expect(await (await request("GET", `${path}/a`)).json()).toMatchObject({ chapter_id: "a", content: "First text" });
    expect((await request("GET", `${path}/missing`)).status).toBe(404);
    db.raw.prepare("UPDATE milestones SET complete = 0 WHERE id = ?").run(milestone.id);
    expect((await request("GET", path)).status).toBe(404);
    expect((await request("GET", `${path}/a`)).status).toBe(404);
  });

  it("restores milestone text through History without adding daily words", async () => {
    const milestone = await (await create()).json() as { id: string };
    expect((await request("PUT", "/api/chapters/a", {
      content: "Newer writing here", baseVersion: 2, day: "2026-11-24",
    })).status).toBe(200);
    const before = db.raw.prepare("SELECT words, revised FROM daily_words WHERE day = '2026-11-24'").get();
    const copied = await (await request("GET", `/api/milestones/${milestone.id}/chapters/a`)).json() as { content: string };
    expect((await request("PUT", "/api/chapters/a", {
      content: copied.content, baseVersion: 3, snapshot: "restore", day: "2026-11-24",
    })).status).toBe(200);
    expect(db.raw.prepare("SELECT words, revised FROM daily_words WHERE day = '2026-11-24'").get()).toEqual(before);
    const snapshot = db.raw.prepare("SELECT id, reason FROM chapter_snapshots WHERE chapter_id = 'a' AND reason = 'restore'").get() as { id: string; reason: string };
    expect(snapshot).toBeDefined();
    expect(await (await request("GET", `/api/chapters/a/history/${snapshot.id}`)).json()).toMatchObject({ content: "Newer writing here" });
    expect(await (await request("GET", "/api/chapters/a")).json()).toMatchObject({ content: "First text" });
  });

  it("adds a deleted milestone chapter back as a new chapter", async () => {
    const milestone = await (await create()).json() as { id: string };
    await request("DELETE", "/api/chapters/a");
    const copied = await (await request("GET", `/api/milestones/${milestone.id}/chapters/a`)).json() as { title: string; content: string };
    const chapter = await (await request("POST", "/api/projects/p/chapters", { title: copied.title })).json() as { id: string; version: number };
    expect(chapter.id).not.toBe("a");
    expect((await request("PUT", `/api/chapters/${chapter.id}`, {
      content: copied.content, baseVersion: chapter.version, snapshot: "restore", day: "2026-11-24",
    })).status).toBe(200);
    expect(await (await request("GET", `/api/chapters/${chapter.id}`)).json()).toMatchObject({ title: "First", content: "First text" });
    expect(db.raw.prepare("SELECT words, revised FROM daily_words WHERE day = '2026-11-24'").get()).toEqual({ words: 0, revised: 0 });
  });

  it("refuses a restore if the current chapter cannot be kept in History", async () => {
    const milestone = await (await create()).json() as { id: string };
    const copied = await (await request("GET", `/api/milestones/${milestone.id}/chapters/a`)).json() as { content: string };
    bucket.failPuts = /\/history\//;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await request("PUT", "/api/chapters/a", {
        content: copied.content, baseVersion: 2, snapshot: "restore", day: "2026-11-24",
      })).status).toBe(500);
      expect(await (await request("GET", "/api/chapters/a")).json()).toMatchObject({ version: 2, content: "First text" });
      expect(db.raw.prepare("SELECT * FROM daily_words").all()).toEqual([]);
    } finally { log.mockRestore(); }
  });

  it("copies reconciled chapter texts and versions and keeps them after deletion", async () => {
    const response = await create();
    expect(response.status).toBe(201);
    const milestone = await response.json() as { id: string; word_count: number; chapter_count: number };
    expect(milestone).toMatchObject({ word_count: 5, chapter_count: 2 });
    expect(db.raw.prepare("SELECT chapter_id, version, word_count FROM milestone_chapters ORDER BY position").all())
      .toEqual([{ chapter_id: "a", version: 2, word_count: 2 }, { chapter_id: "b", version: 0, word_count: 3 }]);
    expect(bucket.objects.get(`projects/p/milestones/${milestone.id}/a.md`)).toBe("First text");
    expect(db.raw.prepare("SELECT version FROM chapters WHERE id = 'a'").get()).toEqual({ version: 2 });
    await request("DELETE", "/api/chapters/a");
    await request("DELETE", "/api/projects/p");
    expect(bucket.objects.get(`projects/p/milestones/${milestone.id}/a.md`)).toBe("First text");
    expect(db.raw.prepare("SELECT * FROM milestone_chapters").all()).toHaveLength(2);
  });

  it("cleans up after a move lock or failed copy", async () => {
    db.raw.prepare("UPDATE chapters SET moving_until = ? WHERE id = 'b'").run(new Date(Date.now() + 60_000).toISOString());
    expect((await create()).status).toBe(423);
    expect(db.raw.prepare("SELECT * FROM milestones").all()).toEqual([]);
    expect([...bucket.objects.keys()].filter((key) => key.includes("/milestones/"))).toEqual([]);
    db.raw.prepare("UPDATE chapters SET moving_until = NULL WHERE id = 'b'").run();
    bucket.failPuts = /\/milestones\/.*\/b\.md$/;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await create()).status).toBe(500);
    expect(db.raw.prepare("SELECT * FROM milestone_chapters").all()).toEqual([]);
    expect(db.raw.prepare("SELECT * FROM milestones").all()).toEqual([]);
    expect([...bucket.objects.keys()].filter((key) => key.includes("/milestones/"))).toEqual([]);
    log.mockRestore();
  });

  it("uses the version of the same R2 object even if a save lands during creation", async () => {
    const get = bucket.get.bind(bucket);
    let reads = 0;
    bucket.get = async (key) => {
      if (key === "projects/p/chapters/a.md" && ++reads === 2) {
        await bucket.put(key, "A later save", { customMetadata: { version: "3" } });
      }
      return get(key);
    };
    const result = await (await create()).json() as { id: string };
    expect(db.raw.prepare("SELECT version, word_count FROM milestone_chapters WHERE chapter_id = 'a'").get())
      .toEqual({ version: 3, word_count: 3 });
    expect(bucket.objects.get(`projects/p/milestones/${result.id}/a.md`)).toBe("A later save");
  });

  it("refuses a move that starts and finishes while the chapter is read", async () => {
    const get = bucket.get.bind(bucket);
    let reads = 0;
    bucket.get = async (key) => {
      const object = await get(key);
      if (key === "projects/p/chapters/b.md" && ++reads === 2) {
        db.raw.prepare("UPDATE chapters SET moving_until = ? WHERE id = 'b'").run("2020-01-01T00:00:00.000Z");
      }
      return object;
    };
    expect((await create()).status).toBe(423);
    expect(db.raw.prepare("SELECT * FROM milestones").all()).toEqual([]);
    expect([...bucket.objects.keys()].filter((key) => key.includes("/milestones/"))).toEqual([]);
  });

  it("copies a missing chapter object as empty at its D1 version", async () => {
    db.raw.prepare("UPDATE chapters SET version = 3 WHERE id = 'b'").run();
    await bucket.delete("projects/p/chapters/b.md");
    const response = await create();
    expect(response.status).toBe(201);
    const milestone = await response.json() as { id: string };
    expect(bucket.objects.get(`projects/p/milestones/${milestone.id}/b.md`)).toBe("");
    expect(db.raw.prepare("SELECT version, word_count FROM milestone_chapters WHERE chapter_id = 'b'").get())
      .toEqual({ version: 3, word_count: 0 });
  });

  it("copies an older chapter without version metadata at its D1 version", async () => {
    db.raw.prepare("UPDATE chapters SET version = 1 WHERE id = 'b'").run();
    await bucket.put("projects/p/chapters/b.md", "Legacy text");
    const response = await create();
    expect(response.status).toBe(201);
    const milestone = await response.json() as { id: string };
    expect(bucket.objects.get(`projects/p/milestones/${milestone.id}/b.md`)).toBe("Legacy text");
    expect(db.raw.prepare("SELECT version, word_count FROM milestone_chapters WHERE chapter_id = 'b'").get())
      .toEqual({ version: 1, word_count: 2 });
  });

  it("hides incomplete milestones and cleans up old copies", async () => {
    db.raw.prepare("INSERT INTO milestones (id, project_id, name, created_at) VALUES ('old', 'p', 'Old', ?)").run(ts);
    db.raw.prepare("INSERT INTO milestones (id, project_id, name, created_at) VALUES ('new', 'p', 'New', ?)").run(new Date().toISOString());
    await bucket.put("projects/p/milestones/old/a.md", "partial");
    expect(await (await request("GET", "/api/projects/p/milestones")).json()).toEqual([]);
    await cleanupIncompleteMilestones(env);
    expect(db.raw.prepare("SELECT id FROM milestones").all()).toEqual([{ id: "new" }]);
    expect(bucket.objects.has("projects/p/milestones/old/a.md")).toBe(false);
  });

  it("renames and deletes complete milestones", async () => {
    const milestone = await (await create()).json() as { id: string };
    const path = `/api/milestones/${milestone.id}`;
    expect(await (await request("PATCH", path, { name: "Draft 2", note: "Done" })).json()).toMatchObject({ name: "Draft 2", note: "Done" });
    expect((await (await request("GET", "/api/projects/p/milestones")).json() as unknown[])).toHaveLength(1);
    expect((await request("DELETE", path)).status).toBe(200);
    expect(db.raw.prepare("SELECT * FROM milestones").all()).toEqual([]);
    expect([...bucket.objects.keys()].filter((key) => key.includes("/milestones/"))).toEqual([]);
  });
});
