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
const DRAFT_KEY = `projects/${NOVEL}/chapters/${CH}/claude-draft.md`;
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
const draft = () => db.raw.prepare("SELECT version, base_version, word_count FROM claude_drafts WHERE chapter_id = ?").get(CH) as {
  version: number; base_version: number; word_count: number;
} | undefined;
const app = (method: string, path: string, payload?: unknown) =>
  worker.fetch(new Request(`https://lantern.test${path}`, {
    method,
    headers: payload === undefined ? {} : { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }), env);
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
    expect(readOnly).not.toContain("move_scene");
    const refused = await (await connect(false)).callTool({ name: "move_scene", arguments: { scene_id: "s", from_chapter_id: CH, base_versions: { from: 0 } } });
    expect(refused.isError).toBe(true);
    const editing = (await (await connect(true)).listTools()).tools.map((t) => t.name);
    expect(editing).toEqual(expect.arrayContaining([
      "edit_chapter", "append_to_chapter", "create_chapter", "update_chapter_details",
      "create_story_entry", "update_story_entry", "create_scene", "update_scene", "read_chapter", "read_draft", "move_scene",
    ]));
    expect(editing.some((n) => n.startsWith("delete"))).toBe(false);
  });

  it("tells Claude how to edit only when it may", async () => {
    expect((await connect(false)).getInstructions()).toContain("can read but not change");
    expect((await connect(true)).getInstructions()).toContain("Change only what the author asked for");
  });
});

describe("scene connector", () => {
  const api = (method: string, path: string, payload?: unknown) => worker.fetch(
    new Request(`https://lantern.test${path}`, {
      method, headers: payload === undefined ? {} : { "content-type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }), env,
  );
  const source = "First passage.\n\n***\n\nSecond passage.\n\n***\n\nUncarded passage.";
  const destKey = `projects/${NOVEL}/chapters/ch-2.md`;
  async function setup() {
    const ts = "2026-11-01T00:00:00.000Z";
    db.raw.prepare("INSERT INTO chapters (id, project_id, title, position, created_at, updated_at, scenes_version) VALUES ('ch-2', ?, 'Next', 1, ?, ?, 0)")
      .run(NOVEL, ts, ts);
    await bucket.put(destKey, "Destination.\n\n***\n\nNo card.", { customMetadata: { version: "0" } });
    expect((await api("PUT", `/api/chapters/${CH}`, { content: source, baseVersion: 4 })).status).toBe(200);
    const create = async (index: number) => {
      const response = await api("POST", `/api/projects/${NOVEL}/scenes`, { chapterId: CH });
      const scene = await response.json() as { id: string };
      expect((await api("PATCH", `/api/scenes/${scene.id}`, { link: { passage_index: index } })).status).toBe(200);
      return scene.id;
    };
    return { first: await create(0), second: await create(1) };
  }

  it("outlines matched scenes and placeholders, without anchors", async () => {
    const { first, second } = await setup();
    const result = await call("get_outline", { novel_id: NOVEL });
    const outline = JSON.parse(textOf(result));
    expect(outline.chapters[0].scenes).toEqual([
      expect.objectContaining({ id: first, in_text: true, word_count: 2, passage_index: 0 }),
      expect.objectContaining({ id: second, in_text: true, word_count: 2, passage_index: 1 }),
    ]);
    expect(outline.chapters[0].uncarded_passages).toEqual([{ passage_index: 2, words: 2, excerpt: "Uncarded passage." }]);
    expect(textOf(result)).not.toContain("anchor_");
  });

  it("reads only a linked passage and rejects planned and wrong-chapter cards", async () => {
    const { second } = await setup();
    const result = await call("read_chapter", { chapter_id: CH, scene_id: second });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("version 5");
    expect(textOf(result)).toContain("passage_index: 1");
    expect(textOf(result)).toContain("Second passage.");
    expect(textOf(result)).not.toContain("First passage.");
    expect(textOf(result)).not.toContain("Uncarded passage.");
    expect((await call("read_chapter", { chapter_id: "ch-2", scene_id: second })).isError).toBe(true);
    await api("PATCH", `/api/scenes/${second}`, { unlink: true });
    expect((await call("read_chapter", { chapter_id: CH, scene_id: second })).isError).toBe(true);
  });

  it("reconciles an interrupted write before reading a scene", async () => {
    const { second } = await setup();
    await bucket.put(KEY, source, { customMetadata: { version: "6" } });
    const result = await call("read_chapter", { chapter_id: CH, scene_id: second });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("version 6");
    expect(chapter().version).toBe(6);
  });

  it("preserves CRLF in a scene read so its text can be edited exactly", async () => {
    const { second } = await setup();
    expect((await api("PATCH", `/api/scenes/${second}`, { unlink: true })).status).toBe(200);
    const content = source.replace("Second passage.", "Second passage.\nContinued here.").replace(/\n/g, "\r\n");
    expect((await api("PUT", `/api/chapters/${CH}`, { content, baseVersion: 5 })).status).toBe(200);
    expect((await api("PATCH", `/api/scenes/${second}`, { link: { passage_index: 1 } })).status).toBe(200);
    const read = await call("read_chapter", { chapter_id: CH, scene_id: second });
    expect(read.isError, textOf(read)).toBeFalsy();
    const responseText = textOf(read);
    const separator = "\n\n---\n\n";
    const bodyStart = responseText.indexOf(separator);
    expect(bodyStart).toBeGreaterThanOrEqual(0);
    const passage = responseText.slice(bodyStart + separator.length);
    expect(passage).toContain("Second passage.\r\nContinued here.");
    const edited = await call("edit_chapter", {
      chapter_id: CH, base_version: 6, edits: [{ old_text: passage, new_text: "Revised passage." }],
    });
    expect(edited.isError, textOf(edited)).toBeFalsy();
  });

  it("reorders in the chapter and logs the move", async () => {
    const { first, second } = await setup();
    const result = await call("move_scene", { scene_id: second, from_chapter_id: CH, from_passage_index: 1, before_passage_index: 0, base_versions: { from: 5 } });
    expect(result.isError).toBeFalsy();
    expect(bucket.objects.get(KEY)).toBe("Second passage.\n\n***\n\nUncarded passage.\n\n***\n\nFirst passage.");
    expect(db.raw.prepare("SELECT action, target_kind, target_id FROM claude_changes").all())
      .toEqual([{ action: "move_scene", target_kind: "scene", target_id: second }]);
    expect(first).not.toBe(second);
  });

  it("moves across chapters before an uncarded passage and logs it", async () => {
    const { second } = await setup();
    const result = await call("move_scene", {
      scene_id: second, from_chapter_id: CH, from_passage_index: 1, to_chapter_id: "ch-2", before_passage_index: 1, base_versions: { from: 5, to: 0 },
    });
    expect(result.isError).toBeFalsy();
    expect(bucket.objects.get(destKey)).toBe("Destination.\n\n***\n\nSecond passage.\n\n***\n\nNo card.");
    expect(db.raw.prepare("SELECT action, target_kind, target_id, chapter_id FROM claude_changes").get())
      .toMatchObject({ action: "move_scene", target_kind: "scene", target_id: second, chapter_id: "ch-2" });
  });

  it("requires the source chapter and refuses a scene that moved to another chapter at the same version", async () => {
    const { second } = await setup();
    const missing = await call("move_scene", { scene_id: second, base_versions: { from: 5 } });
    expect(missing.isError).toBe(true);
    const moved = await call("move_scene", {
      scene_id: second, from_chapter_id: CH, from_passage_index: 1, to_chapter_id: "ch-2", base_versions: { from: 5, to: 0 },
    });
    expect(moved.isError).toBeFalsy();
    const sourceAfter = bucket.objects.get(KEY);
    const destinationAfter = bucket.objects.get(destKey);
    const versions = db.raw.prepare("SELECT id, version FROM chapters ORDER BY id").all();
    const changes = db.raw.prepare("SELECT COUNT(*) AS n FROM claude_changes").get();
    for (const to_chapter_id of [undefined, CH]) {
      const refused = await call("move_scene", {
        scene_id: second, from_chapter_id: CH, from_passage_index: 1, to_chapter_id, base_versions: { from: 1, to: 6 },
      });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain("The chapter has changed since you read it");
      expect(bucket.objects.get(KEY)).toBe(sourceAfter);
      expect(bucket.objects.get(destKey)).toBe(destinationAfter);
      expect(db.raw.prepare("SELECT id, version FROM chapters ORDER BY id").all()).toEqual(versions);
      expect(db.raw.prepare("SELECT COUNT(*) AS n FROM claude_changes").get()).toEqual(changes);
    }
  });

  it("refuses stale versions and locked chapters without changing text", async () => {
    const { second } = await setup();
    const stale = await call("move_scene", { scene_id: second, from_chapter_id: CH, from_passage_index: 1, base_versions: { from: 4 } });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain("changed since you read it");
    db.raw.prepare("UPDATE chapters SET moving_until = ? WHERE id = ?").run(new Date(Date.now() + 60_000).toISOString(), CH);
    const locked = await call("move_scene", { scene_id: second, from_chapter_id: CH, from_passage_index: 1, before_passage_index: 0, base_versions: { from: 5 } });
    expect(locked.isError).toBe(true);
    expect(textOf(locked)).toBe("A scene is being moved in this chapter; try again in a few seconds.");
    expect(bucket.objects.get(KEY)).toBe(source);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM claude_changes").get()).toEqual({ n: 0 });
  });

  it("refuses stale destination versions and preserves move failure messages", async () => {
    const { second } = await setup();
    const args = { scene_id: second, from_chapter_id: CH, from_passage_index: 1, to_chapter_id: "ch-2", base_versions: { from: 5, to: 1 } };
    const stale = await call("move_scene", args);
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain("changed since you read it");
    const put = bucket.put.bind(bucket);
    let destPuts = 0;
    bucket.put = async (key, value, options) => {
      if (key === KEY || (key === destKey && ++destPuts === 2)) throw new Error("write failed");
      return put(key, value, options);
    };
    const result = await call("move_scene", { ...args, base_versions: { from: 5, to: 0 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("The scene is now in both chapters. Delete one copy.");
  });

  it("refuses to split a group at an uncarded passage during a reorder", async () => {
    const { first } = await setup();
    const result = await call("move_scene", { scene_id: first, from_chapter_id: CH, from_passage_index: 0, before_passage_index: 2, base_versions: { from: 5 } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Uncarded passages stay with the scene before them");
    expect(bucket.objects.get(KEY)).toBe(source);
  });

  it("refuses a move when cards have been relinked since the listing", async () => {
    const { first, second } = await setup();
    expect((await api("PATCH", `/api/scenes/${second}`, { unlink: true })).status).toBe(200);
    expect((await api("PATCH", `/api/scenes/${second}`, { link: { passage_index: 2 } })).status).toBe(200);
    const arrange = await api("PUT", `/api/chapters/${CH}/scenes/arrangement`, {
      baseVersion: 5, sceneIds: [second, first], expectedPassages: [[first, 0], [second, 1]],
    });
    expect(arrange.status).toBe(409);
    const across = await api("POST", `/api/scenes/${second}/move`, {
      toChapterId: "ch-2", beforePassageIndex: null, baseVersions: { from: 5, to: 0 },
      expectedFromChapterId: CH, expectedFromPassageIndex: 1,
    });
    expect(across.status).toBe(409);
    expect(bucket.objects.get(KEY)).toBe(source);
  });

  it("refuses to move a scene after its passage changed since read_chapter", async () => {
    const { second } = await setup();
    const read = await call("read_chapter", { chapter_id: CH, scene_id: second });
    expect(textOf(read)).toContain("passage_index: 1");
    expect((await api("PATCH", `/api/scenes/${second}`, { unlink: true })).status).toBe(200);
    expect((await api("PATCH", `/api/scenes/${second}`, { link: { passage_index: 2 } })).status).toBe(200);
    const result = await call("move_scene", {
      scene_id: second, from_chapter_id: CH, from_passage_index: 1, to_chapter_id: "ch-2",
      base_versions: { from: 5, to: 0 },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("passage has changed since you read it");
    expect(bucket.objects.get(KEY)).toBe(source);
    expect(bucket.objects.get(destKey)).toBe("Destination.\n\n***\n\nNo card.");
  });
});

describe("edit_chapter", () => {
  it("puts the edit in Claude's draft and leaves the chapter alone", async () => {
    const r = await call("edit_chapter", {
      chapter_id: CH,
      base_version: 4,
      edits: [{ old_text: "lit the lamp", new_text: "lit the old brass lamp" }],
    });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain("draft version 1");
    expect(bucket.objects.get(DRAFT_KEY)).toBe("Mara lit the old brass lamp.\n\nThe “tower” waited in the dark.\n");
    expect(draft()).toEqual({ version: 1, base_version: 4, word_count: 12 });
    expect(bucket.objects.get(KEY)).toBe(OPENING);
    expect(chapter()).toMatchObject({ version: 4, word_count: 10 });
    expect(snapshots()).toEqual([]);
  });

  it("keeps editing the draft, against the draft's version and text", async () => {
    await call("edit_chapter", { chapter_id: CH, base_version: 4, edits: [{ old_text: "Mara", new_text: "Nell" }] });
    const stale = await call("edit_chapter", { chapter_id: CH, base_version: 4, edits: [{ old_text: "dark", new_text: "night" }] });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toMatch(/draft version 1.*read_draft/s);
    const missing = await call("edit_chapter", { chapter_id: CH, base_version: 1, edits: [{ old_text: "Mara", new_text: "Ada" }] });
    expect(textOf(missing)).toMatch(/wasn't found in the draft\. Read the draft again with read_draft/);
    const r = await call("edit_chapter", { chapter_id: CH, base_version: 1, edits: [{ old_text: "dark", new_text: "night" }] });
    expect(r.isError).toBeFalsy();
    expect(bucket.objects.get(DRAFT_KEY)).toBe("Nell lit the lamp.\n\nThe “tower” waited in the night.\n");
    expect(draft()).toMatchObject({ version: 2, base_version: 4 });
    expect(bucket.objects.get(KEY)).toBe(OPENING);
  });

  it("shows Claude the draft, and says so when reading the chapter", async () => {
    await call("append_to_chapter", { chapter_id: CH, base_version: 4, text: "Morning came." });
    expect(textOf(await call("read_chapter", { chapter_id: CH }))).toContain("Claude's draft of this chapter is waiting");
    const read = textOf(await call("read_draft", { chapter_id: CH }));
    expect(read).toContain("draft version 1");
    expect(read).toContain("Morning came.");
  });

  it("never counts Claude's words toward the author's day", async () => {
    await call("append_to_chapter", { chapter_id: CH, base_version: 4, text: "A great many new words arrived here." });
    expect((await app("POST", `/api/chapters/${CH}/claude-draft/accept`, { baseVersion: 4, draftVersion: 1 })).status).toBe(200);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM daily_words").get()).toEqual({ n: 0 });
  });

  it("refuses to start a draft from writing it hasn't seen", async () => {
    const r = await call("edit_chapter", { chapter_id: CH, base_version: 3, edits: [{ old_text: "Mara", new_text: "Nell" }] });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/changed since you read it \(it's now version 4\)/);
    expect(draft()).toBeUndefined();
  });

  it("changes nothing if any edit fails", async () => {
    const r = await call("edit_chapter", {
      chapter_id: CH,
      base_version: 4,
      edits: [{ old_text: "Mara", new_text: "Nell" }, { old_text: "not in the text", new_text: "x" }],
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^Edit 2:/);
    expect(draft()).toBeUndefined();
    expect(bucket.objects.has(DRAFT_KEY)).toBe(false);
  });

  it("leaves no draft behind when its text can't be stored", async () => {
    bucket.failPuts = /claude-draft\.md$/;
    const r = await call("edit_chapter", { chapter_id: CH, base_version: 4, edits: [{ old_text: "Mara", new_text: "Nell" }] });
    expect(r.isError).toBe(true);
    expect(draft()).toBeUndefined();
  });
});

describe("accepting or discarding Claude's draft", () => {
  beforeEach(async () => {
    await call("edit_chapter", { chapter_id: CH, base_version: 4, edits: [{ old_text: "Mara", new_text: "Nell" }] });
  });
  const NELL = OPENING.replace("Mara", "Nell");

  it("shows the draft to the app", async () => {
    const res = await app("GET", `/api/chapters/${CH}/claude-draft`);
    expect(await res.json()).toMatchObject({ chapter_id: CH, version: 1, base_version: 4, word_count: 10, content: NELL });
  });

  it("puts the draft in the chapter and keeps the chapter's text in History", async () => {
    const res = await app("POST", `/api/chapters/${CH}/claude-draft/accept`, { baseVersion: 4, draftVersion: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: CH, version: 5, word_count: 10, content: NELL });
    expect(bucket.objects.get(KEY)).toBe(NELL);
    expect(chapter()).toMatchObject({ version: 5 });
    const [snap] = snapshots();
    expect(snap).toMatchObject({ version: 4, reason: "claude" });
    expect(bucket.objects.get(`projects/${NOVEL}/chapters/${CH}/history/${snap.id}.md`)).toBe(OPENING);
    expect(draft()).toBeUndefined();
    expect(bucket.objects.has(DRAFT_KEY)).toBe(false);
    expect(await (await app("GET", `/api/chapters/${CH}/claude-draft`)).json()).toBeNull();
  });

  it("refuses when the chapter or the draft changed since the author looked", async () => {
    const draftMoved = await app("POST", `/api/chapters/${CH}/claude-draft/accept`, { baseVersion: 4, draftVersion: 0 });
    expect(draftMoved.status).toBe(409);
    expect(await draftMoved.json()).toMatchObject({ code: "draft_changed" });
    expect((await app("POST", `/api/chapters/${CH}/claude-draft/accept`, { baseVersion: 3, draftVersion: 1 })).status).toBe(409);
    expect(bucket.objects.get(KEY)).toBe(OPENING);
    expect(chapter().version).toBe(4);
    expect(draft()).toMatchObject({ version: 1 });
  });

  it("changes nothing when History can't keep a copy", async () => {
    bucket.failPuts = /\/history\//;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app("POST", `/api/chapters/${CH}/claude-draft/accept`, { baseVersion: 4, draftVersion: 1 });
    log.mockRestore();
    expect(res.status).toBe(500);
    expect(bucket.objects.get(KEY)).toBe(OPENING);
    expect(chapter()).toMatchObject({ version: 4, word_count: 10 });
    expect(draft()).toMatchObject({ version: 1 });
  });

  it("discards the draft without touching the chapter, and the next edit starts afresh", async () => {
    expect((await app("DELETE", `/api/chapters/${CH}/claude-draft`)).status).toBe(200);
    expect(draft()).toBeUndefined();
    expect(bucket.objects.has(DRAFT_KEY)).toBe(false);
    expect(bucket.objects.get(KEY)).toBe(OPENING);
    const r = await call("append_to_chapter", { chapter_id: CH, base_version: 4, text: "Dawn." });
    expect(r.isError).toBeFalsy();
    expect(bucket.objects.get(DRAFT_KEY)).toBe(`${OPENING.trimEnd()}\n\nDawn.\n`);
  });
});

describe("append_to_chapter", () => {
  it("adds after a blank line", async () => {
    await call("append_to_chapter", { chapter_id: CH, base_version: 4, text: "***\n\nMorning came." });
    expect(bucket.objects.get(DRAFT_KEY)).toBe(`${OPENING.trimEnd()}\n\n***\n\nMorning came.\n`);
  });
});

describe("create_chapter", () => {
  it("adds a chapter at the end with its synopsis, and its text as Claude's draft", async () => {
    const r = await call("create_chapter", { novel_id: NOVEL, title: "The Storm", synopsis: "The light fails.", text: "Rain." });
    const made = JSON.parse(textOf(r));
    expect(made).toMatchObject({ title: "The Storm", position: 2, version: 0, draft_version: 1, draft_word_count: 1 });
    expect(bucket.objects.get(`projects/${NOVEL}/chapters/${made.chapter_id}.md`)).toBe("");
    expect(bucket.objects.get(`projects/${NOVEL}/chapters/${made.chapter_id}/claude-draft.md`)).toBe("Rain.\n");
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
    await call("append_to_chapter", { chapter_id: CH, base_version: 1, text: "Morning came." });
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
      ["Drafted an addition to the end of “Arrival”", "+2 words"],
      ["Drafted edits to “Arrival”", "2 passages · +3 words"],
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
    expect(made).toMatchObject({ summary: "Added the chapter “The Storm”", detail: "Chapter 2, 3 words drafted, with a synopsis" });
  });

  it("keeps the edit when the log can't be written", async () => {
    db.raw.exec("DROP TABLE claude_changes");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await call("edit_chapter", { chapter_id: CH, base_version: 4, edits: [{ old_text: "Mara", new_text: "Nell" }] });
    log.mockRestore();
    expect(r.isError).toBeFalsy();
    expect(draft()?.version).toBe(1);
  });

  it("drops changes older than 180 days", async () => {
    db.raw.prepare(
      "INSERT INTO claude_changes (id, project_id, created_at, action, target_kind, target_id, summary) VALUES ('old', ?, '2020-01-01T00:00:00.000Z', 'edit_chapter', 'chapter', ?, 'Old')",
    ).run(NOVEL, CH);
    await call("update_chapter_details", { chapter_id: CH, title: "Landfall" });
    expect((await changes()).map((c) => c.summary)).toEqual(["Changed the details of “Landfall”"]);
  });
});
