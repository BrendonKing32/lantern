import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";
import { createMcpServer } from "./mcp/server";
import { applyEdits, EditError } from "./mcp/writes";
import { memoryR2, sqliteD1 } from "./testing/d1";

// The write tools against real SQLite with Lantern's migrations applied.

const NOVEL = "novel-1";
const CH = "ch-1";
const KEY = `projects/${NOVEL}/chapters/${CH}.md`;
const OPENING = "Mara lit the lamp.\n\nThe “tower” waited in the dark.\n";

let db: ReturnType<typeof sqliteD1>;
let bucket: ReturnType<typeof memoryR2>;
let env: Env;

beforeEach(() => {
  db = sqliteD1();
  bucket = memoryR2();
  env = { DB: db, BUCKET: bucket, ASSETS: { fetch: async () => new Response() }, DEV_BYPASS: "true" } as unknown as Env;
  const ts = "2026-11-01T00:00:00.000Z";
  db.raw.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(NOVEL, "The Lamplighter", ts, ts);
  db.raw
    .prepare("INSERT INTO chapters (id, project_id, title, position, word_count, version, created_at, updated_at) VALUES (?, ?, ?, 0, 10, 4, ?, ?)")
    .run(CH, NOVEL, "Arrival", ts, ts);
  bucket.objects.set(KEY, OPENING);
});

async function connect(canWrite: boolean) {
  const server = createMcpServer(env, { canWrite });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(a);
  return client;
}

const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? "";
const call = async (name: string, args: Record<string, unknown>) => (await connect(true)).callTool({ name, arguments: args });
const chapter = () => db.raw.prepare("SELECT version, word_count, title, synopsis, position FROM chapters WHERE id = ?").get(CH) as {
  version: number; word_count: number; title: string; synopsis: string; position: number;
};
const snapshots = () => db.raw.prepare("SELECT id, version, reason FROM chapter_snapshots WHERE chapter_id = ?").all(CH) as {
  id: string; version: number; reason: string;
}[];

describe("applyEdits", () => {
  it("replaces each passage in order", () => {
    expect(applyEdits("one two three", [{ old_text: "two", new_text: "2" }, { old_text: "2 three", new_text: "2 3" }])).toBe("one 2 3");
    expect(applyEdits("keep cut keep", [{ old_text: " cut", new_text: "" }])).toBe("keep keep");
  });

  it("refuses passages that are missing, repeated or empty", () => {
    expect(() => applyEdits("a lamp, a lamp", [{ old_text: "lamp", new_text: "x" }])).toThrow(/appears 2 times/);
    expect(() => applyEdits("text", [{ old_text: "nope", new_text: "x" }])).toThrow(/wasn't found/);
    expect(() => applyEdits("text", [{ old_text: "", new_text: "x" }])).toThrow(/append_to_chapter/);
  });

  it("points out a near match with different quotes or dashes", () => {
    try {
      applyEdits("She said, “Wait—now.”", [{ old_text: '"Wait-now."', new_text: "x" }]);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(EditError);
      expect((e as Error).message).toContain("“Wait—now.”");
    }
  });

  it("names which edit failed", () => {
    expect(() => applyEdits("a b", [{ old_text: "a", new_text: "A" }, { old_text: "zzz", new_text: "" }])).toThrow(/^Edit 2:/);
  });
});

describe("which tools a connection gets", () => {
  it("keeps write tools away from read-only connections", async () => {
    const readOnly = (await (await connect(false)).listTools()).tools.map((t) => t.name);
    expect(readOnly).not.toContain("edit_chapter");
    const editing = (await (await connect(true)).listTools()).tools.map((t) => t.name);
    expect(editing).toEqual(expect.arrayContaining([
      "edit_chapter", "append_to_chapter", "create_chapter", "update_chapter_details",
      "create_story_entry", "update_story_entry", "create_scene", "update_scene", "read_chapter",
    ]));
    expect(editing.some((n) => n.startsWith("delete"))).toBe(false);
  });

  it("tells Claude how to edit only when it may", async () => {
    expect((await connect(false)).getInstructions()).toContain("can read but not change");
    expect((await connect(true)).getInstructions()).toContain("Change only what the author asked for");
  });
});

describe("edit_chapter", () => {
  it("saves the edit and keeps the old text in History", async () => {
    const r = await call("edit_chapter", {
      chapter_id: CH,
      base_version: 4,
      edits: [{ old_text: "lit the lamp", new_text: "lit the old brass lamp" }],
    });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("version 5");
    expect(bucket.objects.get(KEY)).toBe("Mara lit the old brass lamp.\n\nThe “tower” waited in the dark.\n");
    expect(chapter()).toMatchObject({ version: 5, word_count: 12 });
    const [snap] = snapshots();
    expect(snap).toMatchObject({ version: 4, reason: "claude" });
    expect(bucket.objects.get(`projects/${NOVEL}/chapters/${CH}/history/${snap.id}.md`)).toBe(OPENING);
  });

  it("never counts Claude's words toward the author's day", async () => {
    await call("append_to_chapter", { chapter_id: CH, base_version: 4, text: "A great many new words arrived here." });
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM daily_words").get()).toEqual({ n: 0 });
  });

  it("refuses to overwrite writing it hasn't seen", async () => {
    const r = await call("edit_chapter", { chapter_id: CH, base_version: 3, edits: [{ old_text: "Mara", new_text: "Nell" }] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/changed since you read it \(it's now version 4\)/);
    expect(bucket.objects.get(KEY)).toBe(OPENING);
    expect(chapter().version).toBe(4);
    expect(snapshots()).toEqual([]);
  });

  it("changes nothing if any edit fails", async () => {
    const r = await call("edit_chapter", {
      chapter_id: CH,
      base_version: 4,
      edits: [{ old_text: "Mara", new_text: "Nell" }, { old_text: "not in the text", new_text: "x" }],
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^Edit 2:/);
    expect(bucket.objects.get(KEY)).toBe(OPENING);
    expect(chapter().version).toBe(4);
  });

  it("changes nothing when History can't keep a copy", async () => {
    bucket.failPuts = /\/history\//;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await call("edit_chapter", { chapter_id: CH, base_version: 4, edits: [{ old_text: "Mara", new_text: "Nell" }] });
    log.mockRestore();
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("couldn't keep a copy");
    expect(bucket.objects.get(KEY)).toBe(OPENING);
    expect(chapter()).toMatchObject({ version: 4, word_count: 10 });
  });

  it("rolls back the version when the chapter text can't be stored", async () => {
    bucket.failPuts = new RegExp(`${CH}\\.md$`);
    const r = await call("edit_chapter", { chapter_id: CH, base_version: 4, edits: [{ old_text: "Mara", new_text: "Nell" }] });
    expect(r.isError).toBe(true);
    expect(chapter()).toMatchObject({ version: 4, word_count: 10 });
  });
});

describe("append_to_chapter", () => {
  it("adds after a blank line", async () => {
    await call("append_to_chapter", { chapter_id: CH, base_version: 4, text: "***\n\nMorning came." });
    expect(bucket.objects.get(KEY)).toBe(`${OPENING.trimEnd()}\n\n***\n\nMorning came.\n`);
  });
});

describe("create_chapter", () => {
  it("adds a chapter at the end with its synopsis and text", async () => {
    const r = await call("create_chapter", { novel_id: NOVEL, title: "The Storm", synopsis: "The light fails.", text: "Rain." });
    const made = JSON.parse(textOf(r));
    expect(made).toMatchObject({ title: "The Storm", position: 2, version: 1, word_count: 1 });
    expect(bucket.objects.get(`projects/${NOVEL}/chapters/${made.chapter_id}.md`)).toBe("Rain.\n");
    const row = db.raw.prepare("SELECT synopsis, position FROM chapters WHERE id = ?").get(made.chapter_id);
    expect(row).toEqual({ synopsis: "The light fails.", position: 1 });
  });
});

describe("update_chapter_details", () => {
  it("renames and sets the synopsis without touching the text", async () => {
    await call("update_chapter_details", { chapter_id: CH, title: "Landfall", synopsis: "Mara arrives." });
    expect(chapter()).toMatchObject({ title: "Landfall", synopsis: "Mara arrives.", version: 4 });
    expect(bucket.objects.get(KEY)).toBe(OPENING);
  });
});

describe("story guide", () => {
  it("adds entries with the app's name rules", async () => {
    const r = await call("create_story_entry", { novel_id: NOVEL, kind: "character", name: "Mara Venn", aliases: ["Mara"], notes: "Keeper." });
    const entry = JSON.parse(textOf(r));
    expect(entry).toMatchObject({ kind: "character", name: "Mara Venn", aliases: ["Mara"] });

    const clash = await call("create_story_entry", { novel_id: NOVEL, kind: "place", name: "mara" });
    expect(clash.isError).toBe(true);
    expect(textOf(clash)).toContain("already used by the entry “Mara Venn”");
  });

  it("appends to notes or replaces them", async () => {
    const { id } = JSON.parse(textOf(await call("create_story_entry", { novel_id: NOVEL, kind: "place", name: "Tower", notes: "Old." })));
    const added = JSON.parse(textOf(await call("update_story_entry", { entry_id: id, add_to_notes: "Its lamp is brass." })));
    expect(added.notes).toBe("Old.\n\nIts lamp is brass.");
    const replaced = JSON.parse(textOf(await call("update_story_entry", { entry_id: id, notes: "New.", aliases: ["the spire"] })));
    expect(replaced).toMatchObject({ notes: "New.", aliases: ["the spire"], name: "Tower" });
    const both = await call("update_story_entry", { entry_id: id, notes: "a", add_to_notes: "b" });
    expect(both.isError).toBe(true);
  });
});

describe("scene cards", () => {
  it("adds and updates scenes", async () => {
    const scene = JSON.parse(textOf(await call("create_scene", { chapter_id: CH, title: "Landing", pov: "Mara", status: "drafted" })));
    expect(scene).toMatchObject({ chapter_id: CH, title: "Landing", pov: "Mara", status: "drafted", position: 0 });
    const updated = JSON.parse(textOf(await call("update_scene", { scene_id: scene.id, summary: "She lands.", status: "planned" })));
    expect(updated).toMatchObject({ title: "Landing", summary: "She lands.", status: "planned" });
  });

  it("adds an unassigned scene and places it in a chapter later", async () => {
    const scene = JSON.parse(textOf(await call("create_scene", { novel_id: NOVEL, title: "Storm" })));
    expect(scene).toMatchObject({ chapter_id: null, title: "Storm", position: 0 });
    const placed = JSON.parse(textOf(await call("update_scene", { scene_id: scene.id, chapter_id: CH })));
    expect(placed).toMatchObject({ chapter_id: CH, position: 0 });
    const unplaced = JSON.parse(textOf(await call("update_scene", { scene_id: scene.id, chapter_id: null })));
    expect(unplaced).toMatchObject({ chapter_id: null });
    const res = await worker.fetch(new Request(`https://lantern.test/api/projects/${NOVEL}/claude-changes`), env);
    const list = (await res.json()) as { summary: string; detail: string }[];
    expect(list.map((c) => c.detail)).toEqual(["Taken out of its chapter", "Moved to “Arrival”", "Not in a chapter yet"]);
  });

  it("needs a novel or a chapter", async () => {
    expect((await call("create_scene", { title: "Storm" })).isError).toBe(true);
  });
});

describe("scenes in the app", () => {
  const api = (method: string, path: string, payload?: unknown) =>
    worker.fetch(new Request(`https://lantern.test${path}`, {
      method,
      headers: payload === undefined ? {} : { "content-type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }), env);
  const create = async (chapterId?: string | null) => {
    const res = await api("POST", `/api/projects/${NOVEL}/scenes`, chapterId === undefined ? undefined : { chapterId });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; chapter_id: string | null; position: number };
  };

  it("creates scenes without a chapter, lists them, and moves them between groups", async () => {
    const a = await create();
    const b = await create(null);
    const c = await create(CH);
    expect([a.chapter_id, b.chapter_id, c.chapter_id]).toEqual([null, null, CH]);
    expect([a.position, b.position, c.position]).toEqual([0, 1, 0]);

    const moved = await (await api("PATCH", `/api/scenes/${a.id}`, { chapter_id: CH })).json();
    expect(moved).toMatchObject({ chapter_id: CH, position: 1 });

    const { scenes: list } = (await (await api("GET", `/api/projects/${NOVEL}/scenes`)).json()) as { scenes: { id: string }[] };
    expect(list.map((s) => s.id)).toEqual([b.id, c.id, a.id]);

    expect((await api("PUT", `/api/projects/${NOVEL}/scenes/order`, { chapterId: CH, sceneIds: [a.id, c.id] })).status).toBe(200);
    expect((await api("PUT", `/api/projects/${NOVEL}/scenes/order`, { chapterId: null, sceneIds: [b.id] })).status).toBe(200);
    expect((await api("PUT", `/api/projects/${NOVEL}/scenes/order`, { chapterId: null, sceneIds: [a.id] })).status).toBe(409);
  });

  it("refuses a chapter from another novel", async () => {
    const ts = "2026-11-01T00:00:00.000Z";
    db.raw.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run("novel-2", "Other", ts, ts);
    db.raw.prepare("INSERT INTO chapters (id, project_id, title, position, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)")
      .run("ch-other", "novel-2", "Elsewhere", ts, ts);
    const scene = await create();
    expect((await api("PATCH", `/api/scenes/${scene.id}`, { chapter_id: "ch-other" })).status).toBe(404);
    expect((await api("POST", `/api/projects/${NOVEL}/scenes`, { chapterId: "ch-other" })).status).toBe(404);
  });

  it("lets a scene have no chapter", () => {
    const cols = db.raw.prepare("PRAGMA table_info(scenes)").all() as { name: string; notnull: number }[];
    expect(cols.find((c) => c.name === "chapter_id")?.notnull).toBe(0);
  });
});

describe("Changes by Claude", () => {
  const changes = async () => {
    const res = await worker.fetch(new Request(`https://lantern.test/api/projects/${NOVEL}/claude-changes`), env);
    expect(res.status).toBe(200);
    return (await res.json()) as { action: string; target_kind: string; target_id: string; chapter_id: string | null; summary: string; detail: string }[];
  };

  it("records each change in plain words, newest first", async () => {
    await call("edit_chapter", {
      chapter_id: CH, base_version: 4,
      edits: [{ old_text: "lit the lamp", new_text: "lit the old brass lamp" }, { old_text: "dark", new_text: "deep dark" }],
    });
    await call("append_to_chapter", { chapter_id: CH, base_version: 5, text: "Morning came." });
    const entry = JSON.parse(textOf(await call("create_story_entry", { novel_id: NOVEL, kind: "place", name: "Tower" })));
    await call("update_story_entry", { entry_id: entry.id, add_to_notes: "Brass lamp.", aliases: ["the spire"] });
    const scene = JSON.parse(textOf(await call("create_scene", { chapter_id: CH, title: "Landing" })));
    await call("update_scene", { scene_id: scene.id, pov: "Mara", status: "drafted" });
    await call("update_chapter_details", { chapter_id: CH, synopsis: "She arrives." });

    const list = await changes();
    expect(list.map((c) => [c.summary, c.detail])).toEqual([
      ["Changed the details of “Arrival”", "Synopsis"],
      ["Changed the scene “Landing”", "Point of view, status"],
      ["Added the scene “Landing”", "In “Arrival”"],
      ["Changed the story guide entry “Tower”", "Other names, added to the notes"],
      ["Added “Tower” to the story guide", "Place"],
      ["Added to the end of “Arrival”", "+2 words"],
      ["Edited “Arrival”", "2 passages · +3 words"],
    ]);
    expect(list[1]).toMatchObject({ target_kind: "scene", target_id: scene.id, chapter_id: CH });
    expect(list[4]).toMatchObject({ target_kind: "entry", target_id: entry.id, chapter_id: null });
    expect(list[6]).toMatchObject({ action: "edit_chapter", target_kind: "chapter", target_id: CH, chapter_id: CH });
  });

  it("records new chapters, and nothing for refused edits", async () => {
    await call("edit_chapter", { chapter_id: CH, base_version: 1, edits: [{ old_text: "Mara", new_text: "Nell" }] });
    expect(await changes()).toEqual([]);
    await call("create_chapter", { novel_id: NOVEL, title: "The Storm", synopsis: "Rain.", text: "It rained hard." });
    const [made] = await changes();
    expect(made).toMatchObject({ summary: "Added the chapter “The Storm”", detail: "Chapter 2, 3 words, with a synopsis" });
  });

  it("keeps the edit when the log can't be written", async () => {
    db.raw.exec("DROP TABLE claude_changes");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await call("edit_chapter", { chapter_id: CH, base_version: 4, edits: [{ old_text: "Mara", new_text: "Nell" }] });
    log.mockRestore();
    expect(r.isError).toBeFalsy();
    expect(chapter().version).toBe(5);
  });

  it("drops changes older than 180 days", async () => {
    db.raw.prepare(
      "INSERT INTO claude_changes (id, project_id, created_at, action, target_kind, target_id, summary) VALUES ('old', ?, '2020-01-01T00:00:00.000Z', 'edit_chapter', 'chapter', ?, 'Old')",
    ).run(NOVEL, CH);
    await call("update_chapter_details", { chapter_id: CH, title: "Landfall" });
    expect((await changes()).map((c) => c.summary)).toEqual(["Changed the details of “Landfall”"]);
  });
});
