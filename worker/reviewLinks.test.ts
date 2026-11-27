import { beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import worker, { type Env } from "./index";
import { memoryR2, sqliteD1 } from "./testing/d1";

let db: ReturnType<typeof sqliteD1>;
let bucket: ReturnType<typeof memoryR2>;
let env: Env;
const date = "2026-01-01T00:00:00.000Z";
beforeEach(async () => {
  db = sqliteD1();
  bucket = memoryR2();
  env = { DB: db, BUCKET: bucket, ASSETS: { fetch: async () => new Response() }, DEV_BYPASS: "true" } as unknown as Env;
  db.raw.exec("PRAGMA foreign_keys = ON");
  db.raw.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('p', 'Book', ?, ?)").run(date, date);
  db.raw.prepare("INSERT INTO chapters (id, project_id, title, position, created_at, updated_at) VALUES ('c', 'p', 'First', 0, ?, ?)").run(date, date);
  await bucket.put("projects/p/chapters/c.md", "Live text");
});
const request = (method: string, path: string, data?: unknown) => worker.fetch(new Request(`https://lantern.test${path}`, {
  method, headers: { "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data),
}), env);
async function create(label: string, milestoneId?: string) {
  const res = await request("POST", "/api/projects/p/shares", { label, milestoneId });
  expect(res.status).toBe(201);
  return await res.json() as { id: string; token: string };
}
async function milestone() {
  db.raw.prepare("INSERT INTO milestones (id, project_id, name, created_at, complete) VALUES ('m', 'p', 'Draft', ?, 1)").run(date);
  db.raw.exec("INSERT INTO milestone_chapters (milestone_id, chapter_id, position, title, version, word_count) VALUES ('m', 'c', 0, 'Old title', 0, 2)");
  await bucket.put("projects/p/milestones/m/c.md", "Frozen text");
}

describe("review links with real SQL", () => {
  it("keeps independent live links, filters feedback and retains deleted chapter feedback", async () => {
    const a = await create(" A ");
    const b = await create("B");
    expect(a.token).not.toBe(b.token);
    for (const link of [a, b]) {
      expect(await (await request("GET", `/api/share/${link.token}/chapters/c`)).json()).toMatchObject({ content: "Live text" });
      expect((await request("POST", `/api/share/${link.token}/comments`, { chapterId: "c", body: link.id })).status).toBe(201);
    }
    expect(await (await request("GET", `/api/projects/p/feedback?shareId=${b.id}`)).json()).toMatchObject([{ share_id: b.id, share_label: "B" }]);
    expect((await request("PATCH", `/api/shares/${b.id}`, { label: " Renamed ", trackProgress: false })).status).toBe(200);
    await request("DELETE", `/api/shares/${a.id}`);
    expect((await request("GET", `/api/share/${a.token}`)).status).toBe(404);
    expect((await request("GET", `/api/share/${b.token}`)).status).toBe(200);
    db.raw.exec("UPDATE chapters SET deleted_at = '2026-01-02' WHERE id = 'c'");
    expect(await (await request("GET", "/api/projects/p/feedback")).json()).toHaveLength(2);
    for (const method of ["GET", "POST", "DELETE"]) expect((await request(method, "/api/projects/p/share")).status).toBe(404);
    expect((await request("GET", "/api/projects/p/share/comments")).status).toBe(404);
  });

  it("caps simultaneous creates atomically at 20", async () => {
    const responses = await Promise.all(Array.from({ length: 25 }, (_, i) =>
      request("POST", "/api/projects/p/shares", { label: `Reader ${i}` })));
    expect(responses.filter((r) => r.status === 201)).toHaveLength(20);
    expect(responses.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await responses.find((r) => r.status === 409)!.json()).toEqual({ error: "Revoke a link before creating another." });
    expect(db.raw.prepare("SELECT count(*) AS n FROM project_shares WHERE revoked_at IS NULL").get()).toEqual({ n: 20 });
  });

  it("returns all feedback, including older entries and filtered results beyond 500", async () => {
    const a = await create("First");
    const b = await create("Second");
    const insert = db.raw.prepare("INSERT INTO share_comments (id, share_id, chapter_id, body, created_at) VALUES (?, ?, 'c', ?, ?)");
    for (let i = 0; i < 510; i++) {
      insert.run(`a${i}`, a.id, `First ${i}`, `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`);
    }
    insert.run("old", b.id, "Oldest", "2025-01-01T00:00:00.000Z");
    const all = await (await request("GET", "/api/projects/p/feedback")).json() as { id: string }[];
    expect(all).toHaveLength(511);
    expect(all.at(-1)?.id).toBe("old");
    const filtered = await (await request("GET", `/api/projects/p/feedback?shareId=${a.id}`)).json() as { id: string }[];
    expect(filtered).toHaveLength(510);
    expect(new Set(filtered.map((item) => item.id)).size).toBe(510);
    expect(await (await request("GET", `/api/projects/p/feedback?shareId=${b.id}`)).json()).toMatchObject([{ id: "old" }]);
  });

  it("serves milestone copies including deleted chapters and revokes without losing feedback", async () => {
    await milestone();
    const link = await create("Round", "m");
    expect((await request("POST", `/api/share/${link.token}/comments`, { chapterId: "c", body: "A note" })).status).toBe(201);
    db.raw.exec("UPDATE chapters SET deleted_at = '2026-01-02' WHERE id = 'c'");
    expect(await (await request("GET", `/api/share/${link.token}`)).json()).toMatchObject({ chapters: [{ id: "c", title: "Old title" }] });
    expect(await (await request("GET", `/api/share/${link.token}/chapters/c`)).json()).toMatchObject({ content: "Frozen text" });
    expect((await request("GET", `/api/share/${link.token}/chapters/no`)).status).toBe(404);
    const comment = await request("POST", `/api/share/${link.token}/comments`, { chapterId: "c", body: "Later" });
    expect(comment.status).toBe(404);
    expect(await comment.json()).toEqual({ error: "This chapter is no longer in the book. Your other feedback still reaches the author." });
    await bucket.delete("projects/p/milestones/m/c.md");
    expect((await request("GET", `/api/share/${link.token}/chapters/c`)).status).toBe(404);
    expect((await request("DELETE", "/api/milestones/m")).status).toBe(200);
    expect((await request("GET", `/api/share/${link.token}`)).status).toBe(404);
    expect(db.raw.prepare("SELECT milestone_id, revoked_at FROM project_shares WHERE id = ?").get(link.id)).toMatchObject({ milestone_id: null, revoked_at: expect.any(String) });
    expect(db.raw.prepare("SELECT count(*) AS n FROM share_comments").get()).toEqual({ n: 1 });
    expect(db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("lists all owners' links but enforces ownership on changes and feedback", async () => {
    await milestone();
    const a = await create("Mine", "m");
    const b = await create("Other", "m");
    await request("POST", `/api/share/${b.token}/comments`, { chapterId: "c", body: "private" });
    db.raw.prepare("UPDATE project_shares SET owner_email = 'other@example.test' WHERE id = ?").run(b.id);
    expect(await (await request("GET", "/api/projects/p/shares")).json()).toMatchObject([{ id: a.id }, { id: b.id }]);
    expect((await request("PATCH", `/api/shares/${b.id}`, { label: "No" })).status).toBe(403);
    expect((await request("DELETE", `/api/shares/${b.id}`)).status).toBe(403);
    expect((await request("GET", `/api/projects/p/feedback?shareId=${b.id}`)).status).toBe(403);
    expect(await (await request("GET", "/api/projects/p/feedback")).json()).toEqual([]);
    const comment = db.raw.prepare("SELECT id FROM share_comments").get() as { id: string };
    expect((await request("DELETE", `/api/projects/p/share/comments/${comment.id}`)).status).toBe(403);
    expect((await request("DELETE", `/api/projects/wrong/share/comments/${comment.id}`)).status).toBe(404);
    expect(db.raw.prepare("SELECT count(*) AS n FROM share_comments").get()).toEqual({ n: 1 });
    db.raw.prepare("UPDATE project_shares SET owner_email = 'dev@localhost' WHERE id = ?").run(b.id);
    expect(await (await request("GET", "/api/projects/p/feedback")).json()).toMatchObject([{ id: comment.id, body: "private" }]);
    expect((await request("DELETE", `/api/projects/p/share/comments/${comment.id}`)).status).toBe(200);
    expect(db.raw.prepare("SELECT count(*) AS n FROM share_comments").get()).toEqual({ n: 0 });
    expect((await request("DELETE", "/api/milestones/m")).status).toBe(200);
    expect((await request("GET", `/api/share/${b.token}`)).status).toBe(404);
  });

  it("rejects foreign or incomplete milestones and invalid changes", async () => {
    await milestone();
    db.raw.exec("UPDATE milestones SET complete = 0 WHERE id = 'm'");
    expect((await request("POST", "/api/projects/p/shares", { label: "A", milestoneId: "m" })).status).toBe(400);
    expect((await request("POST", "/api/projects/p/shares", { label: " " })).status).toBe(400);
    const link = await create("A");
    expect((await request("PATCH", `/api/shares/${link.id}`, { milestoneId: "m" })).status).toBe(400);
    expect((await request("PATCH", `/api/shares/${link.id}`, { trackProgress: 1 })).status).toBe(400);
  });

  it("does not revoke links added after the milestone deletion question", async () => {
    await milestone();
    const first = await create("First", "m");
    const second = await create("Added later", "m");
    const confirmed = encodeURIComponent(JSON.stringify([first.id]));
    expect((await request("DELETE", `/api/milestones/m?confirmedLinks=${confirmed}`)).status).toBe(409);
    expect((await request("GET", `/api/share/${first.token}`)).status).toBe(200);
    expect((await request("GET", `/api/share/${second.token}`)).status).toBe(200);
    const both = encodeURIComponent(JSON.stringify([first.id, second.id]));
    expect((await request("DELETE", `/api/milestones/m?confirmedLinks=${both}`)).status).toBe(200);
    expect((await request("GET", `/api/share/${second.token}`)).status).toBe(404);
  });

  it("can retry a failed milestone object deletion without reopening its links", async () => {
    await milestone();
    const link = await create("Round", "m");
    const remove = bucket.delete.bind(bucket);
    bucket.delete = async () => { throw new Error("storage unavailable"); };
    const confirmed = encodeURIComponent(JSON.stringify([link.id]));
    expect((await request("DELETE", `/api/milestones/m?confirmedLinks=${confirmed}`)).status).toBe(500);
    expect(db.raw.prepare("SELECT complete FROM milestones WHERE id = 'm'").get()).toEqual({ complete: -1 });
    expect((await request("GET", `/api/share/${link.token}`)).status).toBe(404);
    expect((await request("POST", "/api/projects/p/shares", { label: "New", milestoneId: "m" })).status).toBe(400);
    bucket.delete = remove;
    expect((await request("DELETE", `/api/milestones/m?confirmedLinks=${confirmed}`)).status).toBe(200);
    expect(db.raw.prepare("SELECT id FROM milestones WHERE id = 'm'").get()).toBeUndefined();
    expect(bucket.objects.has("projects/p/milestones/m/c.md")).toBe(false);
    expect(db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("migrates an existing active link without changing its token", async () => {
    const legacy = new DatabaseSync(":memory:");
    const files = readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort();
    for (const file of files.filter((file) => file < "0020_review_links.sql")) legacy.exec(readFileSync(`migrations/${file}`, "utf8"));
    legacy.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('p', 'Book', ?, ?)").run(date, date);
    const token = "a".repeat(64);
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))].map((n) => n.toString(16).padStart(2, "0")).join("");
    legacy.prepare("INSERT INTO project_shares (id, project_id, owner_email, token_hash, created_at) VALUES ('old', 'p', 'dev@localhost', ?, ?)").run(hash, date);
    legacy.exec(readFileSync("migrations/0020_review_links.sql", "utf8"));
    expect(legacy.prepare("SELECT label, milestone_id, track_progress, token_hash FROM project_shares").get())
      .toEqual({ label: "", milestone_id: null, track_progress: 1, token_hash: hash });
    db.raw.prepare("INSERT INTO project_shares (id, project_id, owner_email, token_hash, created_at) VALUES ('old', 'p', 'dev@localhost', ?, ?)").run(hash, date);
    expect((await request("GET", `/api/share/${token}`)).status).toBe(200);
    legacy.close();
  });
});
