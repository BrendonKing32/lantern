import { describe, expect, it, vi } from "vitest";
import { createBackup } from "./backups";

function fakeBucket(initialKeys: string[] = []) {
  const contents = new Map<string, unknown>(initialKeys.map((key) => [key, "saved"]));
  const bucket = {
    contents,
    list: vi.fn(async ({ prefix = "" }: { prefix?: string }) => ({
      objects: [...contents.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
      truncated: false,
      cursor: undefined,
    })),
    get: vi.fn(async (key: string) => {
      if (!contents.has(key)) return null;
      return {
        body: new Response(String(contents.get(key))).body,
        httpMetadata: { contentType: "text/markdown" },
        customMetadata: undefined,
      };
    }),
    put: vi.fn(async (key: string, value: unknown) => {
      contents.set(key, value);
      return {};
    }),
    delete: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) contents.delete(key);
    }),
  };
  return bucket as unknown as R2Bucket & typeof bucket;
}

function fakeDatabase(versionReads: number[] = [2, 2]) {
  const tables: Record<string, Record<string, unknown>[]> = {
    projects: [{ id: "p1", title: "Writer's book" }],
    chapters: [{ id: "c1", project_id: "p1", version: 2 }],
    chapter_snapshots: [],
    daily_words: [],
    settings: [],
    bible_entries: [],
    ai_calls: [],
    book_checks: [],
  };
  let versionRead = 0;
  const db = {
    prepare: vi.fn((sql: string) => ({
      all: vi.fn(async () => ({
        results: [{ id: "c1", version: versionReads[Math.min(versionRead++, versionReads.length - 1)] }],
      })),
      sql,
    })),
    batch: vi.fn(async (statements: { sql: string }[]) =>
      statements.map((statement) => ({
        results: tables[statement.sql.replace("SELECT * FROM ", "")] ?? [],
      })),
    ),
  };
  return db as unknown as D1Database & typeof db;
}

describe("scheduled backups", () => {
  it("writes a restorable D1 export, copies manuscript objects, then marks the run complete", async () => {
    const manuscriptKey = "projects/p1/chapters/c1.md";
    const manuscripts = fakeBucket([manuscriptKey]);
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
    const sql = backups.contents.get(`${backupRoot}database.sql`) as string;
    expect(sql).toContain("'Writer''s book'");
    expect(manifestsLast(backups.put.mock.calls.map(([key]) => String(key)))).toBe(true);
    expect(backups.contents.has(expiredKey)).toBe(false);
  });

  it("does not mark a backup complete if a chapter changes during the copy", async () => {
    const backups = fakeBucket();
    const env = {
      DB: fakeDatabase([2, 3]),
      BUCKET: fakeBucket(["projects/p1/chapters/c1.md"]),
      BACKUPS: backups,
    };

    await expect(createBackup(env)).rejects.toThrow("Chapter versions changed");
    expect([...backups.contents.keys()].some((key) => key.endsWith("/manifest.json"))).toBe(false);
  });
});

function manifestsLast(keys: string[]): boolean {
  return keys.at(-1)?.endsWith("/manifest.json") ?? false;
}
