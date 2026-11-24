import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";
import { saveAsClaude } from "./mcp/writes";
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
    expect(version("c")).toEqual({ version: 1, scenes_version: 0 });
    db.prepare = prepare;
    expect((await list()).scenes.find((s) => s.id === card.id)).toMatchObject({ in_text: true, word_count: 2 });
    expect(version("c")).toEqual({ version: 1, scenes_version: 1 });
    log.mockRestore();
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

  it("matches after Claude saves", async () => {
    const card = await create("c");
    await saveAsClaude(env, "c", 0, "Claude writes here.");
    expect(row(card.id)).toMatchObject({ in_text: 1, word_count: 3 });
  });
});
