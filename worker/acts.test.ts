import { beforeEach, describe, expect, it } from "vitest";
import { arrangeChapters } from "../shared/acts";
import type { Outline, ProjectDetail } from "../shared/types";
import worker, { type Env } from "./index";
import { memoryR2, sqliteD1 } from "./testing/d1";

// Acts against real SQLite with Lantern's migrations applied.

const NOVEL = "novel-1";
let db: ReturnType<typeof sqliteD1>;
let env: Env;

beforeEach(() => {
  db = sqliteD1();
  env = { DB: db, BUCKET: memoryR2(), ASSETS: { fetch: async () => new Response() }, DEV_BYPASS: "true" } as unknown as Env;
  const ts = "2026-11-01T00:00:00.000Z";
  db.raw.prepare("INSERT INTO projects (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(NOVEL, "The Lamplighter", ts, ts);
  ["a", "b", "c", "d"].forEach((id, i) =>
    db.raw
      .prepare("INSERT INTO chapters (id, project_id, title, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, NOVEL, `Chapter ${id}`, i, ts, ts),
  );
});

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await worker.fetch(
    new Request(`https://lantern.test${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
  return { status: res.status, data: (await res.json()) as T };
}

const project = async () => (await call<ProjectDetail>("GET", `/api/projects/${NOVEL}`)).data;
/** Book order as "act:chapter" pairs, with "-" for no act. */
const layout = (d: Pick<Outline, "acts" | "chapters">) =>
  d.chapters.map((c) => `${d.acts.find((a) => a.id === c.act_id)?.title ?? "-"}:${c.id}`);

describe("acts", () => {
  it("starts an act at a chapter, taking the rest of the book", async () => {
    const one = await call<Outline>("POST", `/api/projects/${NOVEL}/acts`, { startChapterId: "a" });
    expect(one.status).toBe(201);
    expect(one.data.acts.map((a) => a.title)).toEqual(["Act 1"]);
    expect(layout(one.data)).toEqual(["Act 1:a", "Act 1:b", "Act 1:c", "Act 1:d"]);

    const two = await call<Outline>("POST", `/api/projects/${NOVEL}/acts`, { startChapterId: "c", title: "Part Two" });
    expect(layout(two.data)).toEqual(["Act 1:a", "Act 1:b", "Part Two:c", "Part Two:d"]);
    expect(layout(await project())).toEqual(["Act 1:a", "Act 1:b", "Part Two:c", "Part Two:d"]);
  });

  it("inserts a split act right after the act it was split from", async () => {
    await call("POST", `/api/projects/${NOVEL}/acts`, { startChapterId: "a", title: "I" });
    await call("POST", `/api/projects/${NOVEL}/acts`, { startChapterId: "d", title: "III" });
    const r = await call<Outline>("POST", `/api/projects/${NOVEL}/acts`, { startChapterId: "b", title: "II" });
    expect(r.data.acts.map((a) => a.title)).toEqual(["I", "II", "III"]);
    expect(layout(r.data)).toEqual(["I:a", "II:b", "II:c", "III:d"]);
  });

  it("adds an empty act at the end, and new chapters join the last act", async () => {
    await call("POST", `/api/projects/${NOVEL}/acts`, { startChapterId: "a", title: "I" });
    const r = await call<Outline>("POST", `/api/projects/${NOVEL}/acts`, { title: "II" });
    expect(layout(r.data)).toEqual(["I:a", "I:b", "I:c", "I:d"]);
    const ch = await call<{ id: string; act_id: string }>("POST", `/api/projects/${NOVEL}/chapters`, { title: "New" });
    expect(ch.data.act_id).toBe(r.data.acts[1].id);
    expect(layout(await project()).at(-1)).toBe(`II:${ch.data.id}`);
  });

  it("moves chapters between acts and keeps each act's chapters together", async () => {
    await call("POST", `/api/projects/${NOVEL}/acts`, { startChapterId: "a", title: "I" });
    const { data } = await call<Outline>("POST", `/api/projects/${NOVEL}/acts`, { startChapterId: "c", title: "II" });
    const [one, two] = data.acts;
    // Move a into act II, and put act II first.
    const r = await call("PUT", `/api/projects/${NOVEL}/order`, {
      chapterIds: ["b", "c", "a", "d"],
      chapterActs: { a: two.id },
      actIds: [two.id, one.id],
    });
    expect(r.status).toBe(200);
    expect(layout(await project())).toEqual(["II:c", "II:a", "II:d", "I:b"]);
  });

  it("keeps acts when chapters are reordered without naming them", async () => {
    await call("POST", `/api/projects/${NOVEL}/acts`, { startChapterId: "c", title: "II" });
    await call("PUT", `/api/projects/${NOVEL}/order`, { chapterIds: ["d", "c", "b", "a"] });
    // Chapters with no act stay ahead of act II.
    expect(layout(await project())).toEqual(["-:b", "-:a", "II:d", "II:c"]);
  });

  it("refuses an out-of-date arrangement", async () => {
    const { data } = await call<Outline>("POST", `/api/projects/${NOVEL}/acts`, { startChapterId: "a" });
    expect((await call("PUT", `/api/projects/${NOVEL}/order`, { chapterIds: ["a", "b", "c"] })).status).toBe(409);
    expect(
      (await call("PUT", `/api/projects/${NOVEL}/order`, { chapterIds: ["a", "b", "c", "d"], actIds: [] })).status,
    ).toBe(409);
    expect(
      (await call("PUT", `/api/projects/${NOVEL}/order`, { chapterIds: ["a", "b", "c", "d"], chapterActs: { a: "nope" } }))
        .status,
    ).toBe(409);
    expect(layout(await project())).toEqual(layout(data));
  });

  it("renames an act", async () => {
    const { data } = await call<Outline>("POST", `/api/projects/${NOVEL}/acts`, { startChapterId: "a" });
    const r = await call<{ title: string }>("PATCH", `/api/acts/${data.acts[0].id}`, { title: "  The Harbour  " });
    expect(r.data.title).toBe("The Harbour");
    expect((await project()).acts[0].title).toBe("The Harbour");
  });

  it("removing an act keeps its chapters in place, in the act before it", async () => {
    await call("POST", `/api/projects/${NOVEL}/acts`, { startChapterId: "a", title: "I" });
    const { data } = await call<Outline>("POST", `/api/projects/${NOVEL}/acts`, { startChapterId: "c", title: "II" });
    const r = await call<Outline>("DELETE", `/api/acts/${data.acts[1].id}`);
    expect(r.status).toBe(200);
    expect(layout(r.data)).toEqual(["I:a", "I:b", "I:c", "I:d"]);
    expect((await call<Outline>("DELETE", `/api/acts/${data.acts[0].id}`)).data.acts).toEqual([]);
    const after = await project();
    expect(after.acts).toEqual([]);
    expect(after.chapters.map((c) => [c.id, c.act_id])).toEqual([["a", null], ["b", null], ["c", null], ["d", null]]);
  });

  it("restores a deleted chapter into the last act", async () => {
    const { data } = await call<Outline>("POST", `/api/projects/${NOVEL}/acts`, { startChapterId: "c", title: "II" });
    await call("DELETE", `/api/chapters/a`);
    const r = await call<{ act_id: string }>("POST", `/api/chapters/a/restore`);
    expect(r.data.act_id).toBe(data.acts[0].id);
    expect(layout(await project())).toEqual(["-:b", "II:c", "II:d", "II:a"]);
  });
});

describe("arrangeChapters", () => {
  it("puts chapters with no act first, then each act in order, and renumbers", () => {
    const acts = [{ id: "y", position: 1 }, { id: "x", position: 0 }];
    const out = arrangeChapters(
      [
        { id: "1", act_id: "y", position: 0 },
        { id: "2", act_id: null, position: 1 },
        { id: "3", act_id: "x", position: 2 },
        { id: "4", act_id: "gone", position: 3 },
      ],
      acts,
    );
    expect(out.map((c) => [c.id, c.act_id, c.position])).toEqual([
      ["2", null, 0],
      ["4", null, 1],
      ["3", "x", 2],
      ["1", "y", 3],
    ]);
  });
});
