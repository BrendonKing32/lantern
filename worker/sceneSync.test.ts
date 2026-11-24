import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";
import { memoryR2, sqliteD1 } from "./testing/d1";

let db: ReturnType<typeof sqliteD1>;
let bucket: ReturnType<typeof memoryR2>;
let env: Env;
const ts = "2026-01-01T00:00:00.000Z";
const text = "First passage here.\n\n***\n\nSecond passage there.";

beforeEach(() => {
  db = sqliteD1();
  bucket = memoryR2();
  env = { DB: db, BUCKET: bucket, ASSETS: { fetch: async () => new Response() }, DEV_BYPASS: "true" } as unknown as Env;
  db.raw.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('p', 'Book', ?, ?)").run(ts, ts);
  for (const [id, position] of [["c", 0], ["d", 1]] as const) {
    db.raw.prepare("INSERT INTO chapters (id, project_id, title, position, created_at, updated_at) VALUES (?, 'p', ?, ?, ?, ?)")
      .run(id, id, position, ts, ts);
    bucket.objects.set(`projects/p/chapters/${id}.md`, "");
  }
});

const request = (method: string, path: string, payload?: unknown) => worker.fetch(
  new Request(`https://lantern.test${path}`, {
    method, headers: payload === undefined ? {} : { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }), env,
);
const create = async (chapterId: string) => (await (await request("POST", "/api/projects/p/scenes", { chapterId })).json()) as { id: string };
const save = (chapter: string, content: string, baseVersion: number) =>
  request("PUT", `/api/chapters/${chapter}`, { content, baseVersion });
const list = async () => (await (await request("GET", "/api/projects/p/scenes")).json()) as {
  scenes: { id: string; chapter_id: string; in_text: boolean; unconfirmed: boolean; word_count: number;
    excerpt: string; passage_index: number | null; unlinked_at: string | null; status: string; merged_into: string | null }[];
  placeholders: { chapter_id: string; passage_index: number }[];
};
const row = (id: string) => db.raw.prepare("SELECT * FROM scenes WHERE id = ?").get(id) as Record<string, unknown>;
const version = (id: string) => db.raw.prepare("SELECT version, scenes_version FROM chapters WHERE id = ?").get(id) as {
  version: number; scenes_version: number;
};

describe("matching scenes to text", () => {
  it("keeps a new chapter's card planned when its first passage is saved", async () => {
    const response = await request("POST", "/api/projects/p/chapters", { title: "New chapter" });
    const chapter = await response.json() as { id: string };
    const card = await create(chapter.id);
    expect((await save(chapter.id, "A new scene unfolds.", 0)).status).toBe(200);
    expect(row(card.id)).toMatchObject({ in_text: 0, unconfirmed: 0, status: "planned" });
    expect((await list()).placeholders).toContainEqual(expect.objectContaining({ chapter_id: chapter.id, passage_index: 0 }));
  });

  it("retains distinct positions when the earlier in-text card leaves", async () => {
    const first = await create("c");
    const second = await create("c");
    const lastPassage = "The second scene continues. ".repeat(12);
    await save("c", `First scene.\n\n***\n\n${lastPassage}`, 0);
    await save("c", lastPassage, 1);
    expect(row(first.id)).toMatchObject({ in_text: 0, position: 0 });
    expect(row(second.id)).toMatchObject({ in_text: 1, position: 1 });
    const positions = db.raw.prepare("SELECT position FROM scenes WHERE chapter_id = 'c'").all() as { position: number }[];
    expect(new Set(positions.map((entry) => entry.position)).size).toBe(positions.length);
  });

  it("pairs existing cards once, records anchors and words, and follows later edits", async () => {
    const a = await create("c");
    const b = await create("c");
    expect((await save("c", text, 0)).status).toBe(200);
    expect(row(a.id)).toMatchObject({ in_text: 1, unconfirmed: 1, anchor_head: "first passage here.", word_count: 3, status: "drafted" });
    expect(row(b.id)).toMatchObject({ in_text: 1, unconfirmed: 1, word_count: 3 });
    expect((await save("c", `First passage here and more.\n\n***\n\nSecond passage there.`, 1)).status).toBe(200);
    expect(row(a.id)).toMatchObject({ word_count: 5, anchor_head: "first passage here and more." });
    const listing = await list();
    expect(listing.scenes[0]).toMatchObject({ in_text: true, unconfirmed: true, passage_index: 0, word_count: 5 });
    expect(listing.scenes[0]).not.toHaveProperty("anchor_head");
    expect(listing.placeholders.filter((p) => p.chapter_id === "c")).toEqual([]);
  });

  it("pairs pre-feature cards even when their chapter is at version zero", async () => {
    const card = await create("c");
    bucket.objects.set("projects/p/chapters/c.md", "An older passage.");
    expect(version("c")).toEqual({ version: 0, scenes_version: -1 });
    expect((await list()).scenes.find((scene) => scene.id === card.id)).toMatchObject({
      in_text: true, unconfirmed: true, word_count: 3,
    });
    expect(version("c")).toEqual({ version: 0, scenes_version: 0 });
  });

  it("leaves mismatched existing cards planned and supports linking, confirmation and unlinking", async () => {
    const card = await create("c");
    await save("c", text, 0);
    expect(row(card.id)).toMatchObject({ in_text: 0, unconfirmed: 0 });
    expect((await list()).placeholders.filter((p) => p.chapter_id === "c")).toHaveLength(2);
    expect((await request("PATCH", `/api/scenes/${card.id}`, { link: { passage_index: 1 } })).status).toBe(200);
    expect(row(card.id)).toMatchObject({ in_text: 1, status: "drafted", word_count: 3 });
    const other = await create("c");
    expect((await request("PATCH", `/api/scenes/${other.id}`, { link: { passage_index: 1 } })).status).toBe(409);
    expect((await request("PATCH", `/api/scenes/${card.id}`, { chapter_id: "d" })).status).toBe(400);
    expect((await request("PATCH", `/api/scenes/${card.id}`, { confirm: true })).status).toBe(200);
    expect((await request("PATCH", `/api/scenes/${card.id}`, { unlink: true })).status).toBe(200);
    expect(row(card.id)).toMatchObject({ in_text: 0, word_count: 0, unconfirmed: 0 });
    expect(bucket.objects.get("projects/p/chapters/c.md")).toBe(text);
  });

  it("confirms an automatically paired card without changing the manuscript", async () => {
    const card = await create("c");
    await save("c", "Only one passage.", 0);
    expect(row(card.id).unconfirmed).toBe(1);
    expect((await request("PATCH", `/api/scenes/${card.id}`, { confirm: true })).status).toBe(200);
    expect(row(card.id).unconfirmed).toBe(0);
    expect(bucket.objects.get("projects/p/chapters/c.md")).toBe("Only one passage.");
  });

  it("only lets one card claim the same placeholder concurrently", async () => {
    await save("c", text, 0);
    const first = await create("c");
    const second = await create("c");
    const responses = await Promise.all([first, second].map((card) =>
      request("PATCH", `/api/scenes/${card.id}`, { link: { passage_index: 0 } })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect([row(first.id).in_text, row(second.id).in_text].filter(Boolean)).toHaveLength(1);
  });

  it("keeps a failed sync from failing the save and repairs it on listing", async () => {
    const card = await create("c");
    const prepare = db.prepare;
    db.prepare = (sql) => {
      if (sql.includes("SELECT scenes_version FROM chapters")) throw new Error("sync unavailable");
      return prepare(sql);
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await save("c", "New prose", 0)).status).toBe(200);
    expect(version("c")).toEqual({ version: 1, scenes_version: -1 });
    db.prepare = prepare;
    expect((await list()).scenes.find((s) => s.id === card.id)).toMatchObject({ in_text: true, word_count: 2 });
    expect(version("c")).toEqual({ version: 1, scenes_version: 1 });
    log.mockRestore();
  });

  it("does not match old R2 text against a claimed version and repairs a failed save match", async () => {
    const card = await create("c");
    const key = "projects/p/chapters/c.md";
    expect((await save("c", "Old prose", 0)).status).toBe(200);
    expect((await bucket.get(key))?.customMetadata).toEqual({ version: "1" });
    const planned = await create("c");

    let writing!: () => void;
    let resume!: () => void;
    const writeStarted = new Promise<void>((resolve) => { writing = resolve; });
    const proceed = new Promise<void>((resolve) => { resume = resolve; });
    const put = bucket.put.bind(bucket);
    bucket.put = async (putKey, value, options) => {
      if (putKey === key) {
        writing();
        await proceed;
      }
      return put(putKey, value, options);
    };
    const saving = save("c", "New prose with more words", 1);
    await writeStarted;
    expect(version("c")).toEqual({ version: 2, scenes_version: 1 });
    await list();
    expect(version("c")).toEqual({ version: 2, scenes_version: 1 });
    expect(row(card.id)).toMatchObject({ anchor_head: "old prose", word_count: 2 });
    expect((await request("PATCH", `/api/scenes/${planned.id}`, { link: { passage_index: 0 } })).status).toBe(409);

    const prepare = db.prepare;
    db.prepare = (sql) => {
      if (sql.includes("SELECT scenes_version FROM chapters")) throw new Error("sync unavailable");
      return prepare(sql);
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    resume();
    expect((await saving).status).toBe(200);
    expect((await bucket.get(key))?.customMetadata).toEqual({ version: "2" });
    expect(version("c")).toEqual({ version: 2, scenes_version: 1 });
    db.prepare = prepare;
    expect((await list()).scenes.find((scene) => scene.id === card.id)).toMatchObject({ word_count: 5 });
    expect(row(card.id).anchor_head).toBe("new prose with more words");
    expect(version("c")).toEqual({ version: 2, scenes_version: 2 });
    log.mockRestore();
  });

  it("repairs legacy chapter objects without version metadata", async () => {
    const card = await create("c");
    db.raw.prepare("UPDATE chapters SET version = 1 WHERE id = 'c'").run();
    bucket.objects.set("projects/p/chapters/c.md", "Legacy chapter text");
    expect((await list()).scenes.find((scene) => scene.id === card.id)).toMatchObject({ in_text: true, word_count: 3 });
    expect(version("c")).toEqual({ version: 1, scenes_version: 1 });
  });

  it("does not rematch older text during the cross-chapter repair pass", async () => {
    const card = await create("c");
    await save("c", "Current text", 0);
    db.raw.prepare("UPDATE chapters SET version = 2, scenes_version = 2 WHERE id = 'c'").run();
    db.raw.prepare("UPDATE chapters SET version = 1 WHERE id = 'd'").run();
    await bucket.put("projects/p/chapters/c.md", "Older unrelated text", { customMetadata: { version: "1" } });
    await list();
    expect(row(card.id)).toMatchObject({ in_text: 1, anchor_head: "current text", word_count: 2 });
  });

  it("does not treat invalid version metadata as a legacy object", async () => {
    const card = await create("c");
    db.raw.prepare("UPDATE chapters SET version = 1 WHERE id = 'c'").run();
    await bucket.put("projects/p/chapters/c.md", "Unknown version", { customMetadata: { version: "invalid" } });
    await list();
    expect(row(card.id).in_text).toBe(0);
    expect(version("c")).toEqual({ version: 1, scenes_version: -1 });
  });

  it("leaves the lower card planned on merge and follows a cut to another chapter", async () => {
    const a = await create("c");
    const b = await create("c");
    const first = "First passage here. ".repeat(12);
    await save("c", `${first}\n\n***\n\nSecond passage there.`, 0);
    await save("c", `${first}Second passage there.`, 1);
    expect(row(b.id)).toMatchObject({ in_text: 0, word_count: 0 });
    expect(row(b.id).unlinked_at).toBeTruthy();
    expect((await list()).scenes.find((scene) => scene.id === b.id)?.merged_into).toBe("New scene");
    await save("d", "Second passage there.", 0);
    expect(row(b.id)).toMatchObject({ in_text: 1, chapter_id: "d", unlinked_at: null });
    expect(row(a.id).chapter_id).toBe("c");
  });

  it("revisits the destination after a failed source match is repaired", async () => {
    await create("c");
    const cut = await create("c");
    await save("c", text, 0);
    const prepare = db.prepare;
    db.prepare = (sql) => {
      if (sql.includes("SELECT scenes_version FROM chapters")) throw new Error("sync unavailable");
      return prepare(sql);
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await save("c", "First passage here.", 1)).status).toBe(200);
    db.prepare = prepare;
    expect((await save("d", "Second passage there.", 0)).status).toBe(200);
    expect(row(cut.id)).toMatchObject({ in_text: 1, chapter_id: "c" });
    await list();
    expect(row(cut.id)).toMatchObject({ in_text: 1, chapter_id: "d" });
    log.mockRestore();
  });

  it("matches after the author accepts Claude's draft", async () => {
    const card = await create("c");
    db.raw.prepare(
      `INSERT INTO claude_drafts (chapter_id, project_id, version, base_version, word_count, created_at, updated_at)
       VALUES ('c', 'p', 1, 0, 3, ?, ?)`,
    ).run(ts, ts);
    bucket.objects.set("projects/p/chapters/c/claude-draft.md", "Claude writes here.");
    expect((await request("POST", "/api/chapters/c/claude-draft/accept", { baseVersion: 0, draftVersion: 1 })).status).toBe(200);
    expect(row(card.id)).toMatchObject({ in_text: 1, word_count: 3 });
    expect((await bucket.get("projects/p/chapters/c.md"))?.customMetadata).toEqual({ version: "1" });
  });

  it("writes version zero when creating a chapter and retains metadata after a failed save", async () => {
    const created = await request("POST", "/api/projects/p/chapters", { title: "New chapter" });
    expect(created.status).toBe(201);
    const chapter = await created.json() as { id: string };
    const key = `projects/p/chapters/${chapter.id}.md`;
    expect((await bucket.get(key))?.customMetadata).toEqual({ version: "0" });
    bucket.failPuts = new RegExp(`${chapter.id}\\.md$`);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await save(chapter.id, "Not saved", 0)).status).toBe(500);
    expect(version(chapter.id)).toEqual({ version: 0, scenes_version: 0 });
    expect((await bucket.get(key))?.customMetadata).toEqual({ version: "0" });
    log.mockRestore();
  });
});
