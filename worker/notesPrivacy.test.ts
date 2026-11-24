import { describe, expect, it, vi } from "vitest";
import type { ChapterMeta } from "../shared/types";
import { countWords } from "../shared/wordcount";
import worker, { type Env } from "./index";
import { findMatches } from "./mcp/tools";
import { memoryR2, sqliteD1 } from "./testing/d1";

const checks = vi.hoisted(() => ({ chapter: vi.fn(), book: vi.fn() }));
vi.mock("./check", () => ({
  checkChapter: checks.chapter,
  draftBibleEntry: vi.fn(),
}));
vi.mock("./bookCheck", () => ({ prepareBookCheck: checks.book }));

describe("margin note privacy", () => {
  it("keeps notes out of shared chapters, search, and continuity checks", async () => {
    const db = sqliteD1();
    const bucket = memoryR2();
    const env = { DB: db, BUCKET: bucket, ASSETS: { fetch: async () => new Response() }, DEV_BYPASS: "true" } as unknown as Env;
    const timestamp = "2026-01-01T00:00:00.000Z";
    const manuscript = "A lantern glows.";
    const privateNote = "Private reminder to revise";
    const token = "a".repeat(64);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    db.raw.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('p', 'Book', ?, ?)").run(timestamp, timestamp);
    db.raw.prepare("INSERT INTO chapters (id, project_id, title, position, created_at, updated_at) VALUES ('c', 'p', 'Chapter', 0, ?, ?)")
      .run(timestamp, timestamp);
    db.raw.prepare("INSERT INTO project_shares (id, project_id, owner_email, token_hash, created_at) VALUES ('s', 'p', 'writer', ?, ?)")
      .run(hash, timestamp);
    db.raw.prepare(`INSERT INTO margin_notes (id, project_id, chapter_id, quote, prefix, suffix, body, created_at, updated_at)
      VALUES ('n', 'p', 'c', 'lantern', 'A ', ' glows.', ?, ?, ?)`).run(privateNote, timestamp, timestamp);
    bucket.objects.set("projects/p/chapters/c.md", manuscript);

    const request = (method: string, path: string, body?: unknown) => worker.fetch(new Request(`https://lantern.test${path}`, {
      method, headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    const shared = await request("GET", `/api/share/${token}/chapters/c`);
    expect(shared.status).toBe(200);
    const sharedText = await shared.text();
    expect(sharedText).not.toContain(privateNote);
    expect(JSON.parse(sharedText).content).toBe(manuscript);

    const chapterResponse = await request("GET", "/api/chapters/c");
    const chapter = await chapterResponse.json() as ChapterMeta & { content: string };
    expect(countWords(chapter.content)).toBe(countWords(manuscript));
    expect(findMatches([{ chapter, number: 1, content: chapter.content }], privateNote, false).total).toBe(0);

    checks.chapter.mockResolvedValue({});
    checks.book.mockResolvedValue({
      call: { reservedUsd: 0 }, chapters: 1, words: 3,
      finish: async () => ({ checked_at: timestamp }),
    });
    expect((await request("POST", "/api/chapters/c/check", {})).status).toBe(200);
    const bookCheck = await request("POST", "/api/projects/p/check-book", {});
    expect(bookCheck.status).toBe(200);
    await bookCheck.text();
    expect(JSON.stringify(checks.chapter.mock.calls)).not.toContain(privateNote);
    expect(JSON.stringify(checks.book.mock.calls)).not.toContain(privateNote);
    expect(checks.chapter.mock.calls[0][1].chapter.content).toBe(manuscript);
    expect(checks.book.mock.calls[0][1].chapters[0].content).toBe(manuscript);
  });
});
