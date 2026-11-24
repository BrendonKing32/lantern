import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MarginNote } from "../../shared/types";
import worker from "../index";
import type { Env } from "../env";
import { sqliteD1, memoryR2 } from "../testing/d1";
import { captureNoteChapter, createChapterNote, listChapterNotes } from "./notes";

let db: ReturnType<typeof sqliteD1>;
let env: Env;
const ts = "2026-01-01T00:00:00.000Z";
const input = { quote: "A passage", prefix: "before ", suffix: " after", body: "A private note" };

beforeEach(() => {
  db = sqliteD1();
  env = { DB: db, BUCKET: memoryR2(), DEV_BYPASS: "true" } as unknown as Env;
  db.raw.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('p', 'Book', ?, ?)").run(ts, ts);
  db.raw.prepare("INSERT INTO chapters (id, project_id, title, position, created_at, updated_at) VALUES ('c', 'p', 'Chapter', 0, ?, ?)").run(ts, ts);
});

async function request(path: string, method = "GET", data?: unknown) {
  return worker.fetch(new Request(`https://lantern.test${path}`, {
    method, ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }), env);
}

async function create() {
  const res = await request("/api/chapters/c/notes", "POST", { ...input, author: "claude" });
  expect(res.status).toBe(201);
  return await res.json() as MarginNote;
}

describe("margin notes", () => {
  it("creates, lists, edits, resolves, reopens and deletes notes", async () => {
    const note = await create();
    expect(note).toMatchObject({ ...input, project_id: "p", chapter_id: "c", author: "writer", resolved_at: null });
    expect(await (await request("/api/chapters/c/notes")).json()).toEqual([note]);
    expect(await (await request("/api/chapters/c/notes?resolved=1")).json()).toEqual([]);
    const resolved = await (await request(`/api/notes/${note.id}`, "PATCH", { body: "Edited", resolved: true })).json() as MarginNote;
    expect(resolved).toMatchObject({ body: "Edited", resolved_at: expect.any(String) });
    expect(await (await request("/api/chapters/c/notes?resolved=0")).json()).toEqual([]);
    expect(await (await request("/api/chapters/c/notes?resolved=1")).json()).toEqual([resolved]);
    const again = await (await request(`/api/notes/${note.id}`, "PATCH", { resolved: true })).json() as MarginNote;
    expect(again.resolved_at).toBe(resolved.resolved_at);
    expect(await (await request(`/api/notes/${note.id}`, "PATCH", { resolved: false })).json()).toMatchObject({ body: "Edited", resolved_at: null });
    expect((await request(`/api/notes/${note.id}`, "DELETE")).status).toBe(200);
    expect((await request(`/api/notes/${note.id}`, "DELETE")).status).toBe(404);
  });

  it("allows trusted Claude creation with the same validation", async () => {
    const note = await createChapterNote(env, "c", input, "claude");
    expect(note.author).toBe("claude");
    expect(await listChapterNotes(env, "c", false)).toEqual([note]);
    await expect(createChapterNote(env, "c", { ...input, quote: "" }, "claude")).rejects.toMatchObject({ status: 400 });
  });

  it("validates all input instead of truncating or coercing", async () => {
    for (const changes of [
      { quote: "" }, { quote: "x".repeat(2001) }, { quote: 3 },
      { prefix: "x".repeat(33) }, { suffix: null }, { body: "x".repeat(4001) }, { body: null },
    ]) expect((await request("/api/chapters/c/notes", "POST", { ...input, ...changes })).status).toBe(400);
    expect((await request("/api/chapters/c/notes", "POST", null)).status).toBe(400);
    expect((await request("/api/chapters/c/notes?resolved=all")).status).toBe(400);
    const note = await create();
    for (const changes of [{ body: null }, { body: "x".repeat(4001) }, { resolved: 1 }, {}]) {
      expect((await request(`/api/notes/${note.id}`, "PATCH", changes)).status).toBe(400);
    }
  });

  it.each(["chapters", "projects"])("hides notes when their %s are deleted", async (table) => {
    const note = await create();
    db.raw.prepare(`UPDATE ${table} SET deleted_at = ? WHERE id = ?`).run(ts, table === "chapters" ? "c" : "p");
    expect((await request("/api/chapters/c/notes")).status).toBe(404);
    expect((await request("/api/chapters/c/notes", "POST", input)).status).toBe(404);
    expect((await request(`/api/notes/${note.id}`, "PATCH", { resolved: true })).status).toBe(404);
    expect((await request(`/api/notes/${note.id}`, "DELETE")).status).toBe(404);
  });

  it("blocks mutations during moves and permits them after expiration", async () => {
    const note = await create();
    db.raw.prepare("UPDATE chapters SET moving_until = ? WHERE id = 'c'").run(new Date(Date.now() + 60_000).toISOString());
    expect((await request("/api/chapters/c/notes", "POST", input)).status).toBe(423);
    expect((await request(`/api/notes/${note.id}`, "PATCH", { resolved: true })).status).toBe(423);
    expect((await request(`/api/notes/${note.id}`, "DELETE")).status).toBe(423);
    expect((await request("/api/chapters/c/notes")).status).toBe(200);
    db.raw.prepare("UPDATE chapters SET moving_until = ? WHERE id = 'c'").run(new Date(Date.now() - 1000).toISOString());
    expect((await request(`/api/notes/${note.id}`, "DELETE")).status).toBe(200);
  });

  it("rejects stale captured state after a move or chapter save", async () => {
    const captured = await captureNoteChapter(env, "c");
    db.raw.prepare("UPDATE chapters SET version = version + 1, moving_until = ? WHERE id = 'c'").run(new Date(Date.now() - 1000).toISOString());
    await expect(createChapterNote(env, "c", input, "claude", captured)).rejects.toMatchObject({ status: 409 });
    expect(await listChapterNotes(env, "c", false)).toEqual([]);
  });

  it.each(["POST", "PATCH", "DELETE"])("atomically guards %s against a move starting just before the write", async (method) => {
    const note = await create();
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
      const stmt = prepare(sql);
      if (sql.startsWith(method === "POST" ? "INSERT INTO margin_notes" : method === "PATCH" ? "UPDATE margin_notes" : "DELETE FROM margin_notes")) {
        const bind = stmt.bind.bind(stmt);
        vi.spyOn(stmt, "bind").mockImplementation((...args) => {
          const bound = bind(...args);
          const first = bound.first.bind(bound);
          vi.spyOn(bound, "first").mockImplementation(async (column) => {
            db.raw.prepare("UPDATE chapters SET moving_until = ? WHERE id = 'c'").run(new Date(Date.now() + 60_000).toISOString());
            return first(column);
          });
          return bound;
        });
      }
      return stmt;
    });
    const response = method === "POST"
      ? await request("/api/chapters/c/notes", method, input)
      : await request(`/api/notes/${note.id}`, method, method === "PATCH" ? { resolved: true } : undefined);
    expect(response.status).toBe(423);
    spy.mockRestore();
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM margin_notes WHERE resolved_at IS NULL").get()).toMatchObject({ n: 1 });
  });
});
