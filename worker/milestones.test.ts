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
