import { beforeEach, describe, expect, it, vi } from "vitest";
import { splitScenes } from "../shared/scenes";
import worker, { type Env } from "./index";
import { saveAsClaude } from "./mcp/writes";
import { memoryR2, sqliteD1 } from "./testing/d1";

let db: ReturnType<typeof sqliteD1>;
let bucket: ReturnType<typeof memoryR2>;
let env: Env;
const key = "projects/p/chapters/c.md";
const ts = "2026-01-01T00:00:00.000Z";
beforeEach(() => {
  db = sqliteD1();
  bucket = memoryR2();
  env = { DB: db, BUCKET: bucket, ASSETS: { fetch: async () => new Response() }, DEV_BYPASS: "true" } as unknown as Env;
  db.raw.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('p', 'Book', ?, ?)").run(ts, ts);
  db.raw.prepare("INSERT INTO chapters (id, project_id, title, position, created_at, updated_at, scenes_version) VALUES ('c', 'p', 'Chapter', 0, ?, ?, 0)").run(ts, ts);
  bucket.objects.set(key, "");
});
const request = (method: string, path: string, payload?: unknown) => worker.fetch(new Request(`https://lantern.test${path}`, {
  method, headers: { "content-type": "application/json" }, body: payload === undefined ? undefined : JSON.stringify(payload),
}), env);
const save = (content: string, baseVersion = 0) => request("PUT", "/api/chapters/c", { content, baseVersion, day: "2026-01-01" });
const create = async () => (await (await request("POST", "/api/chapters/c/scenes")).json() as { id: string }).id;
const link = (id: string, index: number) => request("PATCH", `/api/scenes/${id}`, { link: { passage_index: index } });
const arrange = (ids: string[], baseVersion = 1) => request("PUT", "/api/chapters/c/scenes/arrangement", { sceneIds: ids, baseVersion });
const chapter = () => db.raw.prepare("SELECT version, word_count, updated_at, scenes_version FROM chapters WHERE id = 'c'").get();
const daily = () => db.raw.prepare("SELECT * FROM daily_words ORDER BY day").all();
const positions = () => db.raw.prepare("SELECT id FROM scenes WHERE chapter_id = 'c' ORDER BY position").all().map((row) => row.id);
const snapshots = () => db.raw.prepare("SELECT id, reason, version FROM chapter_snapshots ORDER BY rowid").all();

describe("chapter scene arrangement", () => {
  it("moves text and attached placeholders, preserves history, versions and daily words", async () => {
    const text = "# Chapter\n\nFirst prose.\n\n***\n\nUncarded prose.\n\n---\n\nLast prose.\n";
    await save(text);
    const first = await create();
    const planned = await create();
    const last = await create();
    expect((await link(first, 0)).status).toBe(200);
    expect((await link(last, 2)).status).toBe(200);
    const beforeDaily = daily();
    const response = await arrange([last, planned, first]);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ version: 2 });
    expect(bucket.objects.get(key)).toBe("# Chapter\n\nLast prose.\n\n***\n\nFirst prose.\n\n***\n\nUncarded prose.\n");
    expect((await bucket.get(key))?.customMetadata).toEqual({ version: "2" });
    expect(snapshots()).toHaveLength(1);
    expect(snapshots()[0]).toMatchObject({ reason: "move", version: 1 });
    const historyId = snapshots()[0].id;
    expect(bucket.objects.get(`projects/p/chapters/c/history/${historyId}.md`)).toBe(text);
    expect(daily()).toEqual(beforeDaily);
    expect(positions()).toEqual([last, planned, first]);
    expect(chapter()).toMatchObject({ version: 2, scenes_version: 2 });
    const listing = await (await request("GET", "/api/projects/p/scenes")).json() as { scenes: { id: string; passage_index: number }[]; placeholders: { chapter_id: string; passage_index: number }[] };
    expect(listing.scenes.find((s) => s.id === last)?.passage_index).toBe(0);
    expect(listing.scenes.find((s) => s.id === first)?.passage_index).toBe(1);
    expect(listing.placeholders).toContainEqual(expect.objectContaining({ chapter_id: "c", passage_index: 2 }));
  });

  it("only updates positions when planned cards move, and rejects stale versions and lists", async () => {
    await save("One.\n\n***\n\nTwo.");
    const a = await create(), b = await create(), planned = await create();
    await link(a, 0); await link(b, 1);
    const before = chapter();
    expect((await arrange([planned, a, b], 0)).status).toBe(409);
    for (const ids of [[a, b], [a, b, b], [a, b, "missing"]]) {
      expect((await arrange(ids)).status).toBe(409);
    }
    expect((await arrange([planned, a, b])).status).toBe(200);
    expect(chapter()).toEqual(before);
    expect(positions()).toEqual([planned, a, b]);
    expect(snapshots()).toEqual([]);
    expect(bucket.objects.get(key)).toBe("One.\n\n***\n\nTwo.");
  });

  it("fails safely when History or the chapter write fails", async () => {
    await save("One.\n\n***\n\nTwo.");
    const a = await create(), b = await create();
    await link(a, 0); await link(b, 1);
    const before = chapter(), beforeDaily = daily();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    bucket.failPuts = /\/history\//;
    const failed = await arrange([b, a]);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "Could not keep a copy in History, so nothing was moved" });
    expect(chapter()).toEqual(before);
    expect(positions()).toEqual([a, b]);
    expect(bucket.objects.get(key)).toBe("One.\n\n***\n\nTwo.");
    bucket.failPuts = /\/c\.md$/;
    expect((await arrange([b, a])).status).toBe(500);
    expect(chapter()).toEqual(before);
    expect(daily()).toEqual(beforeDaily);
    expect(bucket.objects.get(key)).toBe("One.\n\n***\n\nTwo.");
    log.mockRestore();
  });

  it("keeps an empty first placeholder first without adding extra passages", async () => {
    await save("***\n\nFirst.\n\n---\n\nSecond.");
    const a = await create(), b = await create();
    await link(a, 1); await link(b, 2);
    expect((await arrange([b, a])).status).toBe(200);
    const text = bucket.objects.get(key)!;
    expect(splitScenes(text, "Chapter").map((p) => p.head)).toEqual(["", "second.", "first."]);
    expect(text).toBe("\n\n---\n\nSecond.\n\n***\n\nFirst.");
  });

  it("keeps a title-only placeholder and title at the start without an extra passage", async () => {
    await save("# Chapter\n\n***\n\nFirst.\n\n---\n\nSecond.");
    const a = await create(), b = await create();
    await link(a, 1); await link(b, 2);
    expect((await arrange([b, a])).status).toBe(200);
    const text = bucket.objects.get(key)!;
    expect(text).toBe("# Chapter\n\n---\n\nSecond.\n\n***\n\nFirst.");
    expect(splitScenes(text, "Chapter").map((p) => p.head)).toEqual(["", "second.", "first."]);
  });

  it.each(["", "# Chapter\n\n"])("keeps a card on an empty first passage when it moves: %j", async (prefix) => {
    await save(`${prefix}***\n\nFirst.\n\n---\n\nSecond.`);
    const empty = await create(), first = await create(), second = await create();
    await link(empty, 0); await link(first, 1); await link(second, 2);
    expect((await arrange([second, first, empty])).status).toBe(200);
    const text = bucket.objects.get(key)!;
    expect(text).toBe(`${prefix}Second.\n\n***\n\nFirst.\n\n***`);
    expect(splitScenes(text, "Chapter").map((p) => p.head)).toEqual(["second.", "first.", ""]);
    const listing = await (await request("GET", "/api/projects/p/scenes")).json() as { scenes: { id: string; passage_index: number | null }[] };
    expect(listing.scenes.find((s) => s.id === empty)?.passage_index).toBe(2);
    expect(listing.scenes.find((s) => s.id === first)?.passage_index).toBe(1);
    expect(listing.scenes.find((s) => s.id === second)?.passage_index).toBe(0);
  });

  it("checks the chapter version atomically when only positions change", async () => {
    await save("One.");
    const a = await create(), b = await create();
    await link(a, 0);
    const before = positions();
    const prepare = db.prepare;
    db.prepare = (sql) => {
      if (sql.includes("UPDATE scenes SET position = (SELECT CAST(key")) {
        db.raw.prepare("UPDATE chapters SET version = 2 WHERE id = 'c'").run();
      }
      return prepare(sql);
    };
    const response = await arrange([b, a]);
    expect(response.status).toBe(409);
    expect(positions()).toEqual(before);
    expect(snapshots()).toEqual([]);
  });

  it("reports a partial move if scene sync fails after the text was saved", async () => {
    await save("One.\n\n***\n\nTwo.");
    const a = await create(), b = await create();
    await link(a, 0); await link(b, 1);
    const prepare = db.prepare;
    db.prepare = (sql) => {
      if (sql.includes("SELECT scenes_version FROM chapters")) throw new Error("sync unavailable");
      return prepare(sql);
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await arrange([b, a]);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("chapter text was moved"), version: 2 });
    expect(bucket.objects.get(key)).toBe("Two.\n\n***\n\nOne.");
    expect(chapter()).toMatchObject({ version: 2, scenes_version: 1 });
    db.prepare = prepare;
    expect((await request("GET", "/api/projects/p/scenes")).status).toBe(200);
    expect(chapter()).toMatchObject({ version: 2, scenes_version: 2 });
    log.mockRestore();
  });

  it("reports a partial move when the card list changes during the R2 write", async () => {
    await save("One.\n\n***\n\nTwo.");
    const a = await create(), b = await create();
    await link(a, 0); await link(b, 1);
    const put = bucket.put.bind(bucket);
    let extra = "";
    bucket.put = async (putKey, value, options) => {
      if (putKey === key) extra = await create();
      return put(putKey, value, options);
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await arrange([b, a]);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("chapter text was moved"), version: 2 });
    expect(bucket.objects.get(key)).toBe("Two.\n\n***\n\nOne.");
    expect(chapter()).toMatchObject({ version: 2, scenes_version: 1 });
    expect(positions()).toContain(extra);
    log.mockRestore();
  });

  it("does not expose or accept a claimed version before the move reaches R2", async () => {
    await save("One.\n\n***\n\nTwo.");
    const a = await create(), b = await create();
    await link(a, 0); await link(b, 1);
    let started!: () => void, resume!: () => void;
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const proceed = new Promise<void>((resolve) => { resume = resolve; });
    const put = bucket.put.bind(bucket);
    bucket.put = async (putKey, value, options) => {
      if (putKey === key) { started(); await proceed; }
      return put(putKey, value, options);
    };
    const move = arrange([b, a]);
    await waiting;
    expect((await request("GET", "/api/chapters/c")).status).toBe(409);
    expect((await save("Stale text", 2)).status).toBe(409);
    await expect(saveAsClaude(env, "c", 2, "Stale Claude text")).rejects.toThrow("changed since you read it");
    resume();
    expect((await move).status).toBe(200);
    expect(bucket.objects.get(key)).toBe("Two.\n\n***\n\nOne.");
    expect((await request("GET", "/api/chapters/c")).status).toBe(200);
  });

  it("refuses an unmatched in-text card and R2 content from another version", async () => {
    await save("One.\n\n***\n\nTwo.");
    const a = await create(), b = await create();
    await link(a, 0); await link(b, 1);
    db.raw.prepare("UPDATE scenes SET anchor_head = 'missing', anchor_tail = 'missing' WHERE id = ?").run(a);
    bucket.objects.set(key, "One.\n\n***\n\nNew placeholder.\n\n***\n\nTwo.");
    expect((await arrange([b, a])).status).toBe(409);
    await bucket.put(key, "One.\n\n***\n\nTwo.", { customMetadata: { version: "0" } });
    expect((await arrange([b, a])).status).toBe(409);
    expect(chapter()).toMatchObject({ version: 1 });
  });
});
