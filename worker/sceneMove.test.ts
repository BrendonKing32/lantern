import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { findAnchor, makeAnchor } from "../shared/anchors";
import worker, { type Env } from "./index";
import { getChapterRow } from "./db";
import { afterChapterWrite } from "./sceneSync";
import { memoryR2, sqliteD1 } from "./testing/d1";

let db: ReturnType<typeof sqliteD1>;
let bucket: ReturnType<typeof memoryR2>;
let env: Env;
const ts = "2026-01-01T00:00:00.000Z";
const fromKey = "projects/p/chapters/a.md";
const toKey = "projects/p/chapters/b.md";
const source = "First scene.\n\n***\n\nMoving passage.";
const destination = "Destination passage.\n\n***\n\nUncarded passage.";

beforeEach(() => {
  db = sqliteD1();
  bucket = memoryR2();
  env = { DB: db, BUCKET: bucket, ASSETS: { fetch: async () => new Response() }, DEV_BYPASS: "true" } as unknown as Env;
  db.raw.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('p', 'Book', ?, ?)").run(ts, ts);
  for (const [id, position] of [["a", 0], ["b", 1]] as const) {
    db.raw.prepare("INSERT INTO chapters (id, project_id, title, position, created_at, updated_at, scenes_version) VALUES (?, 'p', ?, ?, ?, ?, 0)")
      .run(id, id, position, ts, ts);
    bucket.objects.set(`projects/p/chapters/${id}.md`, "");
  }
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const request = (method: string, path: string, payload?: unknown) => worker.fetch(
  new Request(`https://lantern.test${path}`, {
    method, headers: payload === undefined ? {} : { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }), env,
);
const save = (id: string, content: string, version: number) => request("PUT", `/api/chapters/${id}`, { content, baseVersion: version });
const create = async (chapterId: string) => await (await request("POST", "/api/projects/p/scenes", { chapterId })).json() as { id: string };
const link = (id: string, passage_index: number) => request("PATCH", `/api/scenes/${id}`, { link: { passage_index } });
const move = (id: string, beforePassageIndex: number | null = 1, from = 1, to = 1) =>
  request("POST", `/api/scenes/${id}/move`, { toChapterId: "b", beforePassageIndex, baseVersions: { from, to } });
const chapter = (id: string) => db.raw.prepare("SELECT version, word_count, moving_until FROM chapters WHERE id = ?").get(id) as {
  version: number; word_count: number; moving_until: string | null;
};
const card = (id: string) => db.raw.prepare("SELECT * FROM scenes WHERE id = ?").get(id) as Record<string, unknown>;
const note = (id: string, text: string, quote: string, resolved = false, chapterId = "a") => {
  const start = text.indexOf(quote);
  const anchor = start === -1 ? { quote, prefix: "", suffix: "" } : makeAnchor(text, start, start + quote.length);
  db.raw.prepare(`INSERT INTO margin_notes
    (id, project_id, chapter_id, quote, prefix, suffix, body, resolved_at, created_at, updated_at)
    VALUES (?, 'p', ?, ?, ?, ?, 'Note', ?, ?, ?)`)
    .run(id, chapterId, anchor.quote, anchor.prefix, anchor.suffix, resolved ? ts : null, ts, ts);
};
const noteChapter = (id: string) => (db.raw.prepare("SELECT chapter_id FROM margin_notes WHERE id = ?").get(id) as { chapter_id: string }).chapter_id;

async function setup() {
  expect((await save("a", source, 0)).status).toBe(200);
  expect((await save("b", destination, 0)).status).toBe(200);
  const first = await create("a");
  const moving = await create("a");
  const target = await create("b");
  expect((await link(first.id, 0)).status).toBe(200);
  expect((await link(moving.id, 1)).status).toBe(200);
  expect((await link(target.id, 0)).status).toBe(200);
  return { first, moving, target };
}

describe("cross-chapter scene moves", () => {
  it("moves only open notes wholly anchored in the moved passage", async () => {
    const { moving } = await setup();
    note("inside", source, "Moving passage.");
    note("outside", source, "First scene.");
    note("crossing", source, "scene.\n\n***\n\nMoving");
    note("resolved", source, "Moving passage.", true);
    note("orphan", source, "Missing passage.");
    note("destination", destination, "Destination passage.", false, "b");
    expect((await move(moving.id)).status).toBe(200);
    expect(["inside", "outside", "crossing", "resolved", "orphan", "destination"].map(noteChapter))
      .toEqual(["b", "a", "a", "a", "a", "b"]);
  });

  it("uses original text offsets for CRLF passages and leaves the chapter title behind", async () => {
    const text = "# a\r\n\r\nFirst scene.\r\n\r\n***\r\n\r\nMoving passage.";
    expect((await save("a", text, 0)).status).toBe(200);
    expect((await save("b", destination, 0)).status).toBe(200);
    const moving = await create("a");
    expect((await link(moving.id, 0)).status).toBe(200);
    note("title", text, "# a");
    note("first", text, "First scene.");
    note("second", text, "Moving passage.");
    expect((await move(moving.id)).status).toBe(200);
    expect(["title", "first", "second"].map(noteChapter)).toEqual(["a", "b", "a"]);
  });

  it("uses anchor context to distinguish duplicates and leaves ambiguous notes behind", async () => {
    const text = "First Same phrase ends.\r\n\r\n***\r\n\r\nSecond Same phrase ends.";
    expect((await save("a", text, 0)).status).toBe(200);
    expect((await save("b", destination, 0)).status).toBe(200);
    const moving = await create("a");
    expect((await link(moving.id, 1)).status).toBe(200);
    const start = text.lastIndexOf("Same phrase");
    const anchor = makeAnchor(text, start, start + "Same phrase".length);
    db.raw.prepare(`INSERT INTO margin_notes
      (id, project_id, chapter_id, quote, prefix, suffix, body, created_at, updated_at)
      VALUES ('context', 'p', 'a', ?, ?, ?, 'Note', ?, ?)`)
      .run(anchor.quote, anchor.prefix, anchor.suffix, ts, ts);
    db.raw.prepare(`INSERT INTO margin_notes
      (id, project_id, chapter_id, quote, prefix, suffix, body, created_at, updated_at)
      VALUES ('ambiguous', 'p', 'a', 'Same phrase', '', '', 'Note', ?, ?)`).run(ts, ts);
    expect((await move(moving.id)).status).toBe(200);
    expect(["context", "ambiguous"].map(noteChapter)).toEqual(["b", "a"]);
  });

  it("reanchors a moved note to its passage rather than an existing destination duplicate", async () => {
    const text = "Similar context here. Shared phrase. Tail text.\r\n\r\n***\r\n\r\nDifferent context. Shared phrase. Other ending.";
    const target = "Different context. Shared phrase. Other ending.\n\n***\n\nDestination end.";
    expect((await save("a", text, 0)).status).toBe(200);
    expect((await save("b", target, 0)).status).toBe(200);
    const moving = await create("a");
    expect((await link(moving.id, 1)).status).toBe(200);
    const start = text.lastIndexOf("Shared phrase");
    const original = makeAnchor(text, start, start + "Shared phrase".length);
    db.raw.prepare(`INSERT INTO margin_notes
      (id, project_id, chapter_id, quote, prefix, suffix, body, created_at, updated_at)
      VALUES ('duplicate', 'p', 'a', ?, ?, ?, 'Note', ?, ?)`)
      .run(original.quote, original.prefix, original.suffix, ts, ts);
    expect((await move(moving.id)).status).toBe(200);
    const updated = db.raw.prepare("SELECT chapter_id, quote, prefix, suffix FROM margin_notes WHERE id = 'duplicate'").get() as
      { chapter_id: string; quote: string; prefix: string; suffix: string };
    const newText = bucket.objects.get(toKey)!;
    expect(updated.chapter_id).toBe("b");
    expect(updated.quote).toBe(original.quote);
    expect(findAnchor(newText, updated)).toEqual({
      from: newText.lastIndexOf("Shared phrase"),
      to: newText.lastIndexOf("Shared phrase") + "Shared phrase".length,
    });
  });

  it("preserves the original quote while reanchoring whitespace drift across CRLF", async () => {
    const text = "First scene.\r\n\r\n***\r\n\r\nBefore Line one\r\n   Line two after.";
    expect((await save("a", text, 0)).status).toBe(200);
    expect((await save("b", destination, 0)).status).toBe(200);
    const moving = await create("a");
    expect((await link(moving.id, 1)).status).toBe(200);
    db.raw.prepare(`INSERT INTO margin_notes
      (id, project_id, chapter_id, quote, prefix, suffix, body, created_at, updated_at)
      VALUES ('drift', 'p', 'a', 'Line one Line two', '', '', 'Note', ?, ?)`).run(ts, ts);
    expect((await move(moving.id)).status).toBe(200);
    const updated = db.raw.prepare("SELECT chapter_id, quote, prefix, suffix FROM margin_notes WHERE id = 'drift'").get() as
      { chapter_id: string; quote: string; prefix: string; suffix: string };
    const newText = bucket.objects.get(toKey)!;
    expect(updated).toMatchObject({ chapter_id: "b", quote: "Line one Line two" });
    const start = newText.indexOf("Line one");
    expect(findAnchor(newText, updated)).toEqual({ from: start, to: start + "Line one\n   Line two".length });
  });

  it("transfers even when an exact destination duplicate masks a whitespace-drifted anchor", async () => {
    const text = "First.\n\n***\n\nBefore Line one\n  Line two after.";
    expect((await save("a", text, 0)).status).toBe(200);
    expect((await save("b", "Existing Line one Line two.\n\n***\n\nEnd.", 0)).status).toBe(200);
    const moving = await create("a");
    expect((await link(moving.id, 1)).status).toBe(200);
    db.raw.prepare(`INSERT INTO margin_notes
      (id, project_id, chapter_id, quote, prefix, suffix, body, created_at, updated_at)
      VALUES ('uncertain', 'p', 'a', 'Line one Line two', '', '', 'Note', ?, ?)`).run(ts, ts);
    expect((await move(moving.id)).status).toBe(200);
    const updated = db.raw.prepare("SELECT chapter_id, quote, prefix, suffix FROM margin_notes WHERE id = 'uncertain'").get() as
      { chapter_id: string; quote: string; prefix: string; suffix: string };
    const newText = bucket.objects.get(toKey)!;
    const start = newText.lastIndexOf("Line one");
    const end = start + "Line one\n  Line two".length;
    expect(updated).toEqual({ chapter_id: "b", quote: "Line one Line two",
      prefix: newText.slice(Math.max(0, start - 32), start), suffix: newText.slice(end, end + 32) });
  });

  it("transfers an indistinguishable destination duplicate as an orphan", async () => {
    const body = `${"x".repeat(40)} quote ${"y".repeat(40)}`;
    const text = `First.\n\n***\n\n${body}`;
    expect((await save("a", text, 0)).status).toBe(200);
    expect((await save("b", `${body}\n\n***\n\nEnd.`, 0)).status).toBe(200);
    const moving = await create("a");
    expect((await link(moving.id, 1)).status).toBe(200);
    note("tie", text, "quote");
    expect((await move(moving.id)).status).toBe(200);
    const updated = db.raw.prepare("SELECT chapter_id, quote, prefix, suffix FROM margin_notes WHERE id = 'tie'").get() as
      { chapter_id: string; quote: string; prefix: string; suffix: string };
    expect(updated.chapter_id).toBe("b");
    expect(findAnchor(bucket.objects.get(toKey)!, updated)).toBeNull();
  });

  it.each(["stale", "snapshot", "source", "final guard", "lost lock"] as const)(
    "does not transfer notes when the move fails at %s", async (failure) => {
      const { moving } = await setup();
      note("inside", source, "Moving passage.");
      const put = bucket.put.bind(bucket);
      bucket.put = async (key, value, options) => {
        if (failure === "snapshot" && key.includes("/history/")) throw new Error("snapshot failed");
        if (failure === "source" && key === fromKey) throw new Error("source failed");
        const result = await put(key, value, options);
        if (failure === "final guard" && key === fromKey) {
          db.raw.prepare("UPDATE chapters SET version = 9 WHERE id = 'a'").run();
        }
        if (failure === "lost lock" && key === fromKey) {
          db.raw.prepare("UPDATE chapters SET moving_until = NULL WHERE id = 'a'").run();
        }
        return result;
      };
      vi.spyOn(console, "error").mockImplementation(() => {});
      expect((await move(moving.id, 1, failure === "stale" ? 0 : 1, 1)).status).toBe(failure === "stale" ? 409 : 500);
      expect(noteChapter("inside")).toBe("a");
      expect(card(moving.id).chapter_id).toBe("a");
    },
  );

  it("rolls back note and scene changes if the final batch fails", async () => {
    const { moving } = await setup();
    note("inside", source, "Moving passage.");
    db.raw.exec(`CREATE TRIGGER reject_note_move BEFORE UPDATE OF chapter_id ON margin_notes
      BEGIN SELECT RAISE(ABORT, 'note update failed'); END`);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await move(moving.id)).status).toBe(500);
    expect(noteChapter("inside")).toBe("a");
    expect(card(moving.id).chapter_id).toBe("a");
    expect([chapter("a").version, chapter("b").version]).toEqual([1, 1]);
  });

  it("moves before an uncarded passage and preserves History and daily words", async () => {
    const { moving, target } = await setup();
    db.raw.prepare("UPDATE daily_words SET revised = 7").run();
    const daily = db.raw.prepare("SELECT SUM(words) AS words, SUM(revised) AS revised FROM daily_words").get();
    const response = await move(moving.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      from: { version: 2, word_count: 2 }, to: { version: 2, word_count: 6 },
      from_passage_index: 1, scene: { id: moving.id, chapter_id: "b", in_text: true, passage_index: 1, word_count: 2 },
    });
    expect(bucket.objects.get(fromKey)).toBe("First scene.");
    expect(bucket.objects.get(toKey)).toBe("Destination passage.\n\n***\n\nMoving passage.\n\n***\n\nUncarded passage.");
    expect((await bucket.get(fromKey))?.customMetadata?.version).toBe("2");
    expect((await bucket.get(toKey))?.customMetadata?.version).toBe("2");
    expect(card(target.id)).toMatchObject({ chapter_id: "b", in_text: 1, position: 0 });
    expect(card(moving.id)).toMatchObject({ chapter_id: "b", in_text: 1, position: 1 });
    expect(db.raw.prepare("SELECT chapter_id, version, reason FROM chapter_snapshots WHERE reason = 'move' ORDER BY chapter_id").all())
      .toEqual([{ chapter_id: "a", version: 1, reason: "move" }, { chapter_id: "b", version: 1, reason: "move" }]);
    expect(db.raw.prepare("SELECT SUM(words) AS words, SUM(revised) AS revised FROM daily_words").get()).toEqual(daily);
  });

  it.each([[0, 1], [1, 0]])("rejects stale versions %i/%i without changing either chapter", async (a, b) => {
    const { moving } = await setup();
    const response = await move(moving.id, null, a, b);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ from: { version: 1 }, to: { version: 1 } });
    expect(bucket.objects.get(fromKey)).toBe(source);
    expect(bucket.objects.get(toKey)).toBe(destination);
    expect(chapter("a").version).toBe(1);
    expect(chapter("b").version).toBe(1);
  });

  it("does not change text or versions if a History copy fails", async () => {
    const { moving } = await setup();
    const put = bucket.put.bind(bucket);
    bucket.put = async (key, value, options) => {
      if (key.includes("/history/")) throw new Error("snapshot failed");
      return put(key, value, options);
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await move(moving.id);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "Could not keep a copy in History, so nothing was moved" });
    expect(bucket.objects.get(fromKey)).toBe(source);
    expect(bucket.objects.get(toKey)).toBe(destination);
    expect([chapter("a").version, chapter("b").version]).toEqual([1, 1]);
    log.mockRestore();
  });

  it.each([false, true])("handles failed source write, restore fails: %s", async (failRestore) => {
    const { moving } = await setup();
    const put = bucket.put.bind(bucket);
    let destinationPuts = 0;
    bucket.put = async (key, value, options) => {
      if (key === fromKey) throw new Error("source failed");
      if (key === toKey && ++destinationPuts === 2 && failRestore) throw new Error("restore failed");
      return put(key, value, options);
    };
    const response = await move(moving.id);
    expect(response.status).toBe(500);
    if (failRestore) {
      expect(await response.json()).toMatchObject({ error: "The scene is now in both chapters. Delete one copy." });
      expect(bucket.objects.get(toKey)).toContain("Moving passage.");
      expect(chapter("b").version).toBe(2);
    } else {
      expect(bucket.objects.get(toKey)).toBe(destination);
      expect(chapter("b").version).toBe(1);
      expect((await bucket.get(toKey))?.customMetadata?.version).toBe("1");
    }
    expect(bucket.objects.get(fromKey)).toBe(source);
    expect(chapter("a").version).toBe(1);
    expect(card(moving.id).chapter_id).toBe("a");
  });

  it("matches duplicate anchors by the known passage mapping", async () => {
    await save("a", "Same.\n\n***\n\nSame.", 0);
    await save("b", "Same.", 0);
    const first = await create("a");
    const moving = await create("a");
    const target = await create("b");
    await link(first.id, 0);
    await link(moving.id, 1);
    await link(target.id, 0);
    const response = await move(moving.id, 0);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scene: { id: moving.id, passage_index: 0 } });
    expect(card(moving.id)).toMatchObject({ chapter_id: "b", position: 0, in_text: 1 });
    expect(card(target.id)).toMatchObject({ chapter_id: "b", position: 1, in_text: 1 });
    expect(card(first.id)).toMatchObject({ chapter_id: "a", in_text: 1 });
  });

  it("rejects invalid destination indexes and planned cards", async () => {
    const { moving } = await setup();
    expect((await move(moving.id, 5)).status).toBe(400);
    const planned = await create("a");
    expect((await move(planned.id)).status).toBe(400);
    expect(bucket.objects.get(fromKey)).toBe(source);
    expect(bucket.objects.get(toKey)).toBe(destination);
  });

  it("rejects an unexpected source without touching either chapter", async () => {
    const { moving } = await setup();
    const response = await request("POST", `/api/scenes/${moving.id}/move`, {
      expectedFromChapterId: "elsewhere", toChapterId: "b", beforePassageIndex: null,
      baseVersions: { from: 1, to: 1 },
    });
    expect(response.status).toBe(409);
    expect(bucket.objects.get(fromKey)).toBe(source);
    expect(bucket.objects.get(toKey)).toBe(destination);
  });

  it("restores the destination when the move runs out of time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
    const { moving } = await setup();
    const put = bucket.put.bind(bucket);
    let written = false;
    bucket.put = async (key, value, options) => {
      const result = await put(key, value, options);
      if (key === toKey && !written) {
        written = true;
        vi.setSystemTime(new Date("2026-03-01T00:00:31.000Z"));
      }
      return result;
    };
    const response = await move(moving.id);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "The move took too long; nothing was changed. Try again." });
    expect(bucket.objects.get(fromKey)).toBe(source);
    expect(bucket.objects.get(toKey)).toBe(destination);
    expect([chapter("a").version, chapter("b").version]).toEqual([1, 1]);
  });

  it("keeps scene reads available and blocks structural changes during a move", async () => {
    const { moving } = await setup();
    let resume!: () => void;
    let notify!: () => void;
    const started = new Promise<void>((resolve) => { notify = resolve; });
    const wait = new Promise<void>((resolve) => { resume = resolve; });
    const put = bucket.put.bind(bucket);
    bucket.put = async (key, value, options) => {
      if (key === toKey) { notify(); await wait; }
      return put(key, value, options);
    };
    const pending = move(moving.id);
    await started;
    expect((await request("GET", "/api/projects/p/scenes")).status).toBe(200);
    expect((await request("POST", "/api/chapters/a/scenes")).status).toBe(423);
    expect((await request("DELETE", `/api/scenes/${moving.id}`)).status).toBe(423);
    expect((await save("b", "Written while moving", 1)).status).toBe(423);
    expect((await request("PUT", "/api/chapters/a/scenes/arrangement", {
      baseVersion: 1, sceneIds: [],
    })).status).toBe(423);
    resume();
    expect((await pending).status).toBe(200);
    expect((await save("b", "Written after moving", 2)).status).toBe(200);
  });

  it("moves an only passage into an empty chapter", async () => {
    await save("a", "Only passage.", 0);
    const moving = await create("a");
    await link(moving.id, 0);
    const response = await move(moving.id, null, 1, 0);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scene: { id: moving.id, passage_index: 0 }, from_passage_index: 0 });
    expect(bucket.objects.get(fromKey)).toBe("");
    expect(bucket.objects.get(toKey)).toBe("Only passage.");
  });

  it.each([
    ["after the destination write and before the source write", false],
    ["after both writes and before the D1 batch", true],
  ])("recovers a crash %s", async (_description, sourceWritten) => {
    const { moving } = await setup();
    const put = bucket.put.bind(bucket);
    const get = bucket.get.bind(bucket);
    const batch = db.batch.bind(db);
    const prepare = db.prepare;
    let crashed = false;
    bucket.put = async (key, value, options) => {
      if (!sourceWritten && key === fromKey) {
        crashed = true;
        throw new Error("crash during source write");
      }
      const result = await put(key, value, options);
      if (sourceWritten && key === fromKey) crashed = true;
      return result;
    };
    bucket.get = async (key) => {
      if (crashed) throw new Error("worker stopped");
      return get(key);
    };
    db.prepare = (sql) => {
      if (crashed && !sourceWritten) throw new Error("worker stopped");
      return prepare(sql);
    };
    db.batch = async (statements) => {
      if (crashed) throw new Error("worker stopped");
      return batch(statements);
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await move(moving.id)).status).toBe(500);
    db.prepare = prepare;
    db.batch = batch;
    bucket.get = get;
    bucket.put = put;
    db.raw.prepare("UPDATE chapters SET moving_until = '2026-01-01T00:01:00.000Z' WHERE id IN ('a', 'b')").run();
    const destinationRead = await request("GET", "/api/chapters/b");
    const sourceRead = await request("GET", "/api/chapters/a");
    expect(await destinationRead.json()).toMatchObject({ version: 2, content: expect.stringContaining("Moving passage.") });
    expect(await sourceRead.json()).toMatchObject({ version: sourceWritten ? 2 : 1 });
    expect(chapter("b").version).toBe(2);
    expect(chapter("a").version).toBe(sourceWritten ? 2 : 1);
    expect(bucket.objects.get(toKey)).toContain("Moving passage.");
    expect(bucket.objects.get(fromKey)?.includes("Moving passage.")).toBe(!sourceWritten);
    expect(card(moving.id)).toBeDefined();
    expect((await save("b", "Old draft", 1)).status).toBe(409);
    if (sourceWritten) {
      expect((await save("a", "Old draft", 1)).status).toBe(409);
      const listing = await (await request("GET", "/api/projects/p/scenes")).json() as { scenes: { id: string; chapter_id: string; in_text: boolean }[] };
      expect(listing.scenes.find((scene) => scene.id === moving.id)).toMatchObject({ chapter_id: "b", in_text: true });
    }
    log.mockRestore();
  });

  it("recovers the card after a crash moving the only passage", async () => {
    expect((await save("a", "Moving passage.", 0)).status).toBe(200);
    expect((await save("b", destination, 0)).status).toBe(200);
    const moving = await create("a");
    const target = await create("b");
    expect((await link(moving.id, 0)).status).toBe(200);
    expect((await link(target.id, 0)).status).toBe(200);
    const put = bucket.put.bind(bucket);
    const batch = db.batch.bind(db);
    let written = false;
    bucket.put = async (key, value, options) => {
      const result = await put(key, value, options);
      if (key === fromKey) written = true;
      return result;
    };
    db.batch = async (statements) => {
      if (written) throw new Error("worker stopped");
      return batch(statements);
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await move(moving.id)).status).toBe(500);
    db.batch = batch;
    bucket.put = put;
    db.raw.prepare("UPDATE chapters SET moving_until = '2026-01-01T00:01:00.000Z' WHERE id IN ('a', 'b')").run();
    expect((await request("GET", "/api/chapters/a")).status).toBe(200);
    expect((await request("GET", "/api/chapters/b")).status).toBe(200);
    const listing = await (await request("GET", "/api/projects/p/scenes")).json() as { scenes: { id: string; chapter_id: string; in_text: boolean }[] };
    expect(listing.scenes.find((scene) => scene.id === moving.id)).toMatchObject({ chapter_id: "b", in_text: true });
    log.mockRestore();
  });

  it("does not restore over a newer destination when the lock expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
    const { moving } = await setup();
    const put = bucket.put.bind(bucket);
    bucket.put = async (key, value, options) => {
      if (key === fromKey) {
        vi.setSystemTime(new Date("2026-03-01T00:01:01.000Z"));
        await put(toKey, "Newer destination.", { customMetadata: { version: "3" } });
        throw new Error("source failed after lease expired");
      }
      return put(key, value, options);
    };
    const response = await move(moving.id);
    expect(response.status).toBe(500);
    expect(bucket.objects.get(toKey)).toBe("Newer destination.");
  });

  it("does not claim an older unversioned chapter object", async () => {
    const { moving } = await setup();
    await bucket.put(fromKey, source);
    expect((await move(moving.id)).status).toBe(409);
    expect(bucket.objects.get(fromKey)).toBe(source);
    expect(bucket.objects.get(toKey)).toBe(destination);
  });

  it("does not advise deleting a copy when the source put wrote before failing", async () => {
    const { moving } = await setup();
    const put = bucket.put.bind(bucket);
    bucket.put = async (key, value, options) => {
      const result = await put(key, value, options);
      if (key === fromKey) throw new Error("response lost after write");
      return result;
    };
    const response = await move(moving.id);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "The move may have completed. Reload and check both chapters." });
    expect(bucket.objects.get(fromKey)).toBe("First scene.");
    expect(bucket.objects.get(toKey)).toContain("Moving passage.");
  });

  it("reports uncertainty when restoration writes before its response fails", async () => {
    const { moving } = await setup();
    const put = bucket.put.bind(bucket);
    let destPuts = 0;
    bucket.put = async (key, value, options) => {
      if (key === fromKey) throw new Error("source failed");
      const result = await put(key, value, options);
      if (key === toKey && ++destPuts === 2) throw new Error("restore response lost");
      return result;
    };
    const response = await move(moving.id);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "The move may have completed. Reload and check both chapters." });
    expect(bucket.objects.get(fromKey)).toBe(source);
    expect(bucket.objects.get(toKey)).toBe(destination);
  });

  it("fences an already-running scene sync when a move starts before its batch", async () => {
    const { moving } = await setup();
    const row = await getChapterRow(env, "a");
    const before = card(moving.id);
    const batch = db.batch.bind(db);
    let injected = false;
    db.batch = async (statements) => {
      if (!injected) {
        injected = true;
        db.raw.prepare("UPDATE chapters SET moving_until = ? WHERE id = 'a'")
          .run(new Date(Date.now() + 60_000).toISOString());
      }
      return batch(statements);
    };
    await afterChapterWrite(env, row, "Changed text", row.version);
    expect(card(moving.id)).toEqual(before);
  });

  it("does not follow a card out of a locked chapter and leaves the destination repairable", async () => {
    const { moving, target } = await setup();
    db.raw.prepare("DELETE FROM scenes WHERE id = ?").run(target.id);
    db.raw.prepare("UPDATE scenes SET in_text = 0, unlinked_at = ? WHERE id = ?")
      .run(new Date().toISOString(), moving.id);
    db.raw.prepare("UPDATE chapters SET moving_until = ? WHERE id = 'a'")
      .run(new Date(Date.now() + 60_000).toISOString());
    db.raw.prepare("UPDATE chapters SET scenes_version = 0 WHERE id = 'b'").run();
    const row = await getChapterRow(env, "b");
    await afterChapterWrite(env, row, "Moving passage.", row.version);
    expect(card(moving.id)).toMatchObject({ chapter_id: "a", in_text: 0 });
    expect(db.raw.prepare("SELECT scenes_version FROM chapters WHERE id = 'b'").get()).toMatchObject({ scenes_version: 0 });
    db.raw.prepare("UPDATE chapters SET moving_until = ? WHERE id = 'a'")
      .run(new Date(Date.now() - 1).toISOString());
    await afterChapterWrite(env, row, "Moving passage.", row.version);
    expect(card(moving.id)).toMatchObject({ chapter_id: "b", in_text: 1 });
  });
});
