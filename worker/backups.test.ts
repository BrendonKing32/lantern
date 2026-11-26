import { describe, expect, it, vi } from "vitest";
import { createBackup } from "./backups";
import { sqliteD1 } from "./testing/d1";

function fakeBucket(initialKeys: string[] = []) {
  const contents = new Map<string, { value: unknown; version: string }>();
  let nextVersion = 1;
  const store = (key: string, value: unknown) => contents.set(key, { value, version: `v${nextVersion++}` });
  for (const key of initialKeys) store(key, "saved");
  const bucket = {
    contents,
    store,
    beforeGet: undefined as ((key: string) => void) | undefined,
    list: vi.fn(async ({ prefix = "" }: { prefix?: string }) => ({
      objects: [...contents]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, { version }]) => ({ key, version })),
      truncated: false,
      cursor: undefined,
    })),
    get: vi.fn(async (key: string) => {
      bucket.beforeGet?.(key);
      const object = contents.get(key);
      if (!object) return null;
      return {
        key,
        version: object.version,
        body: new Response(String(object.value)).body,
        httpMetadata: { contentType: "text/markdown" },
        customMetadata: undefined,
      };
    }),
    put: vi.fn(async (key: string, value: unknown) => {
      store(key, value);
      return {};
    }),
    delete: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) contents.delete(key);
    }),
  };
  return bucket as unknown as R2Bucket & typeof bucket;
}

function fakeDatabase() {
  const tables: Record<string, Record<string, unknown>[]> = {
    projects: [{ id: "p1", title: "Writer's book" }],
    chapters: [{ id: "c1", project_id: "p1", version: 2 }],
    chapter_snapshots: [],
    claude_drafts: [{ chapter_id: "c1", project_id: "p1", version: 1, ops: "[]" }],
    milestones: [{ id: "m1", project_id: "p1", name: "First draft", complete: 1 }],
    milestone_chapters: [{ milestone_id: "m1", chapter_id: "c1", version: 2 }],
    daily_words: [],
    settings: [],
    bible_entries: [],
    ai_calls: [],
    book_checks: [],
    scenes: [{
      id: "s1",
      project_id: "p1",
      chapter_id: "c1",
      title: "The meeting",
      summary: "Mara learns the truth.",
      pov: "Mara",
      location: "The station",
      status: "planned",
      position: 0,
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
    }],
    project_shares: [{
      id: "share1",
      project_id: "p1",
      owner_email: "author@example.test",
      token_hash: "hashed-token",
      created_at: "2026-01-01",
      revoked_at: null,
    }],
    share_comments: [{
      id: "comment1",
      share_id: "share1",
      chapter_id: "c1",
      display_name: "Reader",
      body: "A private note",
      created_at: "2026-01-01",
    }],
  };
  const db = {
    tables,
    prepare: vi.fn((sql: string) => ({ sql })),
    batch: vi.fn(async (statements: { sql: string }[]) =>
      statements.map((statement) => ({
        results: structuredClone(tables[statement.sql.replace("SELECT * FROM ", "")] ?? []),
      })),
    ),
  };
  return db as unknown as D1Database & typeof db;
}

describe("scheduled backups", () => {
  it("restores milestone links and feedback with foreign keys enabled", async () => {
    const db = sqliteD1();
    db.raw.exec("PRAGMA foreign_keys = ON");
    db.raw.exec(`
      INSERT INTO projects (id, title, created_at, updated_at) VALUES ('p', 'Book', '2026', '2026');
      INSERT INTO chapters (id, project_id, title, position, created_at, updated_at) VALUES ('c', 'p', 'Chapter', 0, '2026', '2026');
      INSERT INTO milestones (id, project_id, name, created_at, complete) VALUES ('m', 'p', 'Draft', '2026', 1);
      INSERT INTO project_shares (id, project_id, owner_email, token_hash, created_at, milestone_id) VALUES ('s', 'p', 'writer', 'hash', '2026', 'm');
      INSERT INTO share_comments (id, share_id, chapter_id, body, created_at) VALUES ('f', 's', 'c', 'Note', '2026');
    `);
    const backups = fakeBucket();
    await createBackup({ DB: db as unknown as D1Database, BUCKET: fakeBucket(), BACKUPS: backups });
    const entry = [...backups.contents.entries()].find(([key]) => key.endsWith("/database.sql"));
    expect(entry).toBeDefined();
    db.raw.exec(entry![1].value as string);
    expect(db.raw.prepare("SELECT milestone_id FROM project_shares WHERE id = 's'").get()).toEqual({ milestone_id: "m" });
    expect(db.raw.prepare("SELECT body FROM share_comments WHERE id = 'f'").get()).toEqual({ body: "Note" });
    expect(db.raw.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.raw.close();
  });

  it("writes a restorable D1 export, copies manuscript objects, then marks the run complete", async () => {
    const manuscriptKey = "projects/p1/chapters/c1.md";
    const draftKey = "projects/p1/chapters/c1/claude-draft.md";
    const milestoneKey = "projects/p1/milestones/m1/c1.md";
    const manuscripts = fakeBucket([manuscriptKey, draftKey, milestoneKey]);
    const expiredKey = "backups/2026-09-01T03-17-00-000Z/manifest.json";
    const backups = fakeBucket([expiredKey]);
    const env = {
      DB: fakeDatabase(),
      BUCKET: manuscripts,
      BACKUPS: backups,
    };

    await createBackup(env);

    const manifestKey = [...backups.contents.keys()].find((key) => key.endsWith("/manifest.json"));
    expect(manifestKey).toBeDefined();
    const backupRoot = manifestKey!.replace("manifest.json", "");
    expect(backups.contents.has(`${backupRoot}r2/${manuscriptKey}`)).toBe(true);
    expect(backups.contents.has(`${backupRoot}r2/${draftKey}`)).toBe(true);
    expect(backups.contents.has(`${backupRoot}r2/${milestoneKey}`)).toBe(true);
    const sql = backups.contents.get(`${backupRoot}database.sql`)?.value as string;
    expect(sql).toContain("'Writer''s book'");
    expect(sql).toContain(`INSERT INTO "claude_drafts" ("chapter_id", "project_id", "version", "ops") VALUES ('c1', 'p1', 1, '[]');`);
    expect(sql).toContain(`INSERT INTO "milestones" ("id", "project_id", "name", "complete") VALUES ('m1', 'p1', 'First draft', 1);`);
    expect(sql).toContain(`INSERT INTO "milestone_chapters" ("milestone_id", "chapter_id", "version") VALUES ('m1', 'c1', 2);`);
    expect(sql).toContain(`INSERT INTO "scenes" ("id", "project_id", "chapter_id", "title", "summary", "pov", "location", "status", "position", "created_at", "updated_at") VALUES ('s1', 'p1', 'c1', 'The meeting', 'Mara learns the truth.', 'Mara', 'The station', 'planned', 0, '2026-01-01', '2026-01-01');`);
    expect(sql).toContain(`INSERT INTO "project_shares" ("id", "project_id", "owner_email", "token_hash", "created_at", "revoked_at") VALUES ('share1', 'p1', 'author@example.test', 'hashed-token', '2026-01-01', NULL);`);
    expect(sql).toContain(`INSERT INTO "share_comments" ("id", "share_id", "chapter_id", "display_name", "body", "created_at") VALUES ('comment1', 'share1', 'c1', 'Reader', 'A private note', '2026-01-01');`);
    expect(sql.indexOf('INSERT INTO "project_shares"')).toBeLessThan(sql.indexOf('INSERT INTO "share_comments"'));
    expect(manifestsLast(backups.put.mock.calls.map(([key]) => String(key)))).toBe(true);
    expect(backups.contents.has(expiredKey)).toBe(false);
  });

  async function expectIncomplete(
    change: (env: { DB: ReturnType<typeof fakeDatabase>; BUCKET: ReturnType<typeof fakeBucket> }) => void,
    message: string,
  ) {
    const backups = fakeBucket();
    const env = {
      DB: fakeDatabase(),
      BUCKET: fakeBucket(["projects/p1/chapters/c1.md", "projects/p1/chapters/c1/history/h1.md"]),
      BACKUPS: backups,
    };
    let changed = false;
    env.BUCKET.beforeGet = () => {
      if (changed) return;
      changed = true;
      change(env);
    };

    await expect(createBackup(env)).rejects.toThrow(message);
    expect([...backups.contents.keys()].some((key) => key.endsWith("/manifest.json"))).toBe(false);
  }

  it("does not mark a backup complete if a chapter changes during the copy", async () => {
    await expectIncomplete(({ DB }) => {
      DB.tables.chapters[0].version = 3;
    }, "The database changed during backup");
  });

  it("restores open and resolved margin notes with foreign keys enabled", async () => {
    const db = sqliteD1();
    db.raw.exec("PRAGMA foreign_keys = ON");
    const ts = "2026-01-01T00:00:00.000Z";
    db.raw.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run("p", "Book", ts, ts);
    db.raw.prepare("INSERT INTO chapters (id, project_id, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("c", "p", "Chapter", 0, ts, ts);
    const insert = db.raw.prepare(
      `INSERT INTO margin_notes (id, project_id, chapter_id, quote, prefix, suffix, body, author, resolved_at, created_at, updated_at)
       VALUES (?, 'p', 'c', ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("open", "Writer's quote", "before ", " after", "Private 'note'", "writer", null, ts, ts);
    insert.run("resolved", "Passage", "", "", "Claude's note", "claude", ts, ts, ts);
    const original = db.raw.prepare("SELECT * FROM margin_notes ORDER BY id").all();
    const backups = fakeBucket();
    await createBackup({ DB: db as unknown as D1Database, BUCKET: fakeBucket(), BACKUPS: backups });
    const sql = [...backups.contents.entries()].find(([key]) => key.endsWith("/database.sql"))?.[1].value as string;
    expect(sql).toContain('INSERT INTO "margin_notes"');
    db.raw.prepare("UPDATE margin_notes SET body = 'changed'").run();
    insert.run("extra", "Other", "", "", "New", "writer", null, ts, ts);
    db.raw.exec(sql);
    expect(db.raw.prepare("SELECT * FROM margin_notes ORDER BY id").all()).toEqual(original);
  });

  it("does not mark a backup complete if any other database record changes during the copy", async () => {
    await expectIncomplete(({ DB }) => {
      DB.tables.share_comments.push({
        id: "comment2",
        share_id: "share1",
        chapter_id: "c1",
        display_name: "Reader",
        body: "Another note",
        created_at: "2026-01-02",
      });
    }, "The database changed during backup");
  });

  it("does not mark a backup complete if an R2 object is added during the copy", async () => {
    await expectIncomplete(({ BUCKET }) => {
      BUCKET.store("projects/p1/chapters/c1/history/h2.md", "new history");
    }, "Manuscript storage changed during backup");
  });

  it("does not mark a backup complete if an R2 object is replaced during the copy", async () => {
    await expectIncomplete(({ BUCKET }) => {
      BUCKET.store("projects/p1/chapters/c1.md", "edited before it was copied");
    }, "Manuscript object projects/p1/chapters/c1.md changed during backup");
  });

  it("does not mark a backup complete if an already copied R2 object changes", async () => {
    const backups = fakeBucket();
    const env = {
      DB: fakeDatabase(),
      BUCKET: fakeBucket(["projects/p1/chapters/c1.md", "projects/p1/chapters/c1/history/h1.md"]),
      BACKUPS: backups,
    };
    env.BUCKET.beforeGet = (key) => {
      if (key === "projects/p1/chapters/c1/history/h1.md") env.BUCKET.store("projects/p1/chapters/c1.md", "edited");
    };

    await expect(createBackup(env)).rejects.toThrow("Manuscript storage changed during backup");
    expect([...backups.contents.keys()].some((key) => key.endsWith("/manifest.json"))).toBe(false);
  });

  it("does not mark a backup complete if an R2 object is deleted during the copy", async () => {
    await expectIncomplete(({ BUCKET }) => {
      BUCKET.contents.delete("projects/p1/chapters/c1/history/h1.md");
    }, "changed during backup");
  });
});

function manifestsLast(keys: string[]): boolean {
  return keys.at(-1)?.endsWith("/manifest.json") ?? false;
}
