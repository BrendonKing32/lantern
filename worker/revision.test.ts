import { beforeEach, describe, expect, it } from "vitest";
import worker, { type Env } from "./index";
import { memoryR2, sqliteD1 } from "./testing/d1";

let db: ReturnType<typeof sqliteD1>;
let env: Env;
beforeEach(() => {
  db = sqliteD1();
  const bucket = memoryR2();
  env = { DB: db, BUCKET: bucket, ASSETS: { fetch: async () => new Response() }, DEV_BYPASS: "true" } as unknown as Env;
  db.raw.exec("INSERT INTO projects (id, title, created_at, updated_at) VALUES ('p', 'Book', '2026-01-01', '2026-01-01')");
  db.raw.exec("INSERT INTO chapters (id, project_id, title, position, created_at, updated_at) VALUES ('c', 'p', 'Chapter', 0, '2026-01-01', '2026-01-01')");
});
const request = (method: string, path: string, payload?: unknown) => worker.fetch(new Request(`https://test.local${path}`, {
  method, headers: payload === undefined ? {} : { "content-type": "application/json" },
  body: payload === undefined ? undefined : JSON.stringify(payload),
}), env);

describe("revision status and statistics", () => {
  it("counts capped author revisions, not restore, replacement, conflict or rejected saves", async () => {
    for (const [version, snapshot, revised] of [[0, undefined, 60_000], [1, "restore", 20], [2, "replace", 20], [3, "conflict", 20]] as const) {
      expect((await request("PUT", "/api/chapters/c", { content: `Text ${version}`, baseVersion: version, day: "2026-11-24", snapshot, revised })).status).toBe(200);
    }
    expect((await request("PUT", "/api/chapters/c", { content: "conflict", baseVersion: 0, revised: 99 })).status).toBe(409);
    expect(db.raw.prepare("SELECT revised FROM daily_words WHERE day = '2026-11-24'").get()).toEqual({ revised: 50_000 });
    expect((await request("PUT", "/api/chapters/c", { content: "bad", baseVersion: 4, revised: -1 })).status).toBe(400);
  });

  it("calculates current and best streaks with revision off and on", async () => {
    db.raw.exec("INSERT INTO settings (key, value) VALUES ('daily_goal', '10')");
    db.raw.exec("INSERT INTO daily_words (day, project_id, words, revised) VALUES ('2026-11-20','p',12,0), ('2026-11-21','p',0,11), ('2026-11-22','p',10,0), ('2026-11-23','p',0,15), ('2026-11-24','p',0,12)");
    const stats = async () => (await (await request("GET", "/api/stats?today=2026-11-24")).json()) as Record<string, unknown>;
    expect(await stats()).toMatchObject({ streak: 0, best_streak: 1, revised_today: 12, streak_counts_revision: false });
    await request("PUT", "/api/streak-revision", { streak_counts_revision: true });
    expect(await stats()).toMatchObject({ streak: 5, best_streak: 5, revised_today: 12, streak_counts_revision: true });
    await request("PUT", "/api/streak-revision", { streak_counts_revision: false });
    expect(await stats()).toMatchObject({ streak: 0, best_streak: 1 });
  });

  it("validates chapter and scene statuses", async () => {
    for (const status of ["drafting", "revising", "done"]) {
      expect((await request("PATCH", "/api/chapters/c", { revision_status: status })).status).toBe(200);
    }
    expect((await request("PATCH", "/api/chapters/c", { revision_status: "planned" })).status).toBe(400);
    const scene = await (await request("POST", "/api/chapters/c/scenes")).json() as { id: string };
    for (const status of ["planned", "drafted", "revising", "done"]) {
      expect((await request("PATCH", `/api/scenes/${scene.id}`, { status })).status).toBe(200);
    }
    expect((await request("PATCH", `/api/scenes/${scene.id}`, { status: "unknown" })).status).toBe(400);
  });

  it("does not overwrite omitted details in concurrent patches", async () => {
    const responses = await Promise.all([
      request("PATCH", "/api/chapters/c", { title: "New title" }),
      request("PATCH", "/api/chapters/c", { synopsis: "New synopsis" }),
      request("PATCH", "/api/chapters/c", { revision_status: "done" }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(db.raw.prepare("SELECT title, synopsis, revision_status FROM chapters WHERE id = 'c'").get())
      .toEqual({ title: "New title", synopsis: "New synopsis", revision_status: "done" });
  });

  it("counts revision-only days without a goal and keeps yesterday's streak until today qualifies", async () => {
    db.raw.exec("INSERT INTO settings (key, value) VALUES ('streak_counts_revision', '1')");
    db.raw.exec("INSERT INTO daily_words (day, project_id, words, revised) VALUES ('2026-11-22','p',0,1), ('2026-11-23','p',-2,2)");
    const stats = await (await request("GET", "/api/stats?today=2026-11-24")).json();
    expect(stats).toMatchObject({ streak: 2, best_streak: 2, revised_today: 0 });
  });
});
