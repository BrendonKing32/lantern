import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, describeError, INVALID_RESPONSE, streamBookCheck } from "./api";
import type { BookCheckEvent, BookCheckResult, ProjectSummary } from "../shared/types";

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => fetchMock.mockReset());

const json = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const summary: ProjectSummary = {
  id: "p1",
  title: "The Lighthouse",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  archived_at: null,
  chapter_count: 3,
  word_count: 1200,
};

async function failure(p: Promise<unknown>): Promise<ApiError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ApiError);
  return e as ApiError;
}

describe("request validation", () => {
  it("validates the private changelog response", async () => {
    const entry = {
      number: 62,
      title: "Improve contrast",
      merged_at: "2026-11-21T21:52:19Z",
      url: "https://github.com/BrendonKing32/lantern/pull/62",
    };
    fetchMock.mockResolvedValueOnce(json([entry])).mockResolvedValueOnce(json([{ ...entry, merged_at: null }]));
    await expect(api.changelog()).resolves.toEqual([entry]);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/changelog");
    expect((await failure(api.changelog())).data?.detail).toContain("merged_at");
  });

  it("returns a reply with the expected shape", async () => {
    fetchMock.mockResolvedValue(json([summary]));
    await expect(api.listProjects()).resolves.toEqual([summary]);
  });

  it("keeps fields the page doesn't know about", async () => {
    fetchMock.mockResolvedValue(json({ id: "p1", title: "T", created_at: "x", updated_at: "x" }));
    await expect(api.createProject("T")).resolves.toMatchObject({ id: "p1", created_at: "x" });
  });

  it("reports a reply that isn't JSON as an API error", async () => {
    fetchMock.mockResolvedValue(new Response("<!doctype html><title>Sign in</title>", { status: 200 }));
    const e = await failure(api.listProjects());
    expect(e.status).toBe(200);
    expect(e.data).toMatchObject({ code: INVALID_RESPONSE, detail: "not JSON" });
    expect(describeError(e)).toMatch(/couldn't read/);
  });

  it("reports an empty reply as an API error", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    const e = await failure(api.deleteProject("p1"));
    expect(e.data?.code).toBe(INVALID_RESPONSE);
  });

  it("names where a reply's shape went wrong", async () => {
    fetchMock.mockResolvedValue(json([summary, { ...summary, word_count: "1200" }]));
    const e = await failure(api.listProjects());
    expect(e.data).toMatchObject({ code: INVALID_RESPONSE });
    expect(e.data?.detail).toBe('[1].word_count: expected a number, got "1200"');
  });

  it("rejects a missing field in a nested object", async () => {
    fetchMock.mockResolvedValue(
      json({
        project: { id: "p1", title: "T", created_at: "x", updated_at: "x", target_words: null, target_date: null },
        chapters: [],
      }),
    );
    const e = await failure(api.getProject("p1"));
    expect(e.data?.detail).toBe('project.dialect: expected "american" or "british", got undefined');
  });

  it("rejects an object where a list was expected", async () => {
    fetchMock.mockResolvedValue(json({ projects: [summary] }));
    const e = await failure(api.listProjects());
    expect(e.data?.detail).toBe("response: expected an array, got an object");
  });

  it("rejects null where the type doesn't allow it", async () => {
    fetchMock.mockResolvedValue(
      json({ version: 2, word_count: 10, updated_at: "x", today_words: null }),
    );
    const e = await failure(api.saveChapter("c1", "text", 1));
    expect(e.data?.detail).toBe("today_words: expected a number, got null");
  });

  it("accepts null where the type allows it", async () => {
    fetchMock.mockResolvedValue(json(null));
    await expect(api.lastBookCheck("p1")).resolves.toBeNull();
  });

  it("still reports server errors with the server's message", async () => {
    fetchMock.mockResolvedValue(json({ error: "conflict", version: 5 }, 409));
    const e = await failure(api.saveChapter("c1", "text", 1));
    expect(e.status).toBe(409);
    expect(e.message).toBe("conflict");
    expect(e.data).toEqual({ error: "conflict", version: 5 });
  });

  it("doesn't trust an error reply's shape either", async () => {
    fetchMock.mockResolvedValue(json(["nope"], 500));
    const e = await failure(api.listProjects());
    expect(e.status).toBe(500);
    expect(e.data).toBeNull();
    fetchMock.mockResolvedValue(json({ error: { nested: true } }, 400));
    expect((await failure(api.listProjects())).message).not.toContain("[object");
  });

  it("leaves network failures as TypeErrors", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(api.listProjects()).rejects.toBeInstanceOf(TypeError);
  });
});

// A streamed reply that arrives in the given chunks.
function stream(chunks: string[]) {
  const enc = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(enc.encode(next));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { response: new Response(body, { status: 200 }), cancelled: () => cancelled };
}

const result: BookCheckResult = {
  summary: "Mostly consistent.",
  findings: [
    {
      kind: "timeline",
      chapter_id: "c2",
      chapter_title: "Two",
      quote: "the next morning",
      conflicts_with: "Chapter 1",
      explanation: "Chapter 1 says a week passes.",
      suggestion: "",
    },
  ],
  chapters_checked: 2,
  words_checked: 5000,
  entries_checked: 4,
  model: "claude",
  cost_usd: 0.12,
  checked_at: "2026-01-01T00:00:00Z",
};

const line = (e: unknown) => `${JSON.stringify(e)}\n`;

describe("streamBookCheck", () => {
  it("delivers each valid event, even when lines are split across chunks", async () => {
    const started = line({ type: "started", reserved_usd: 0.5, chapters: 2, words: 5000 });
    const { response } = stream([started.slice(0, 10), started.slice(10) + line({ type: "progress", seconds: 10 }), line({ type: "result", result })]);
    fetchMock.mockResolvedValue(response);
    const events: BookCheckEvent[] = [];
    await streamBookCheck("p1", {}, (e) => events.push(e));
    expect(events.map((e) => e.type)).toEqual(["started", "progress", "result"]);
    expect(events[2]).toEqual({ type: "result", result });
  });

  it("stops at an event with an unknown type, before calling back", async () => {
    const s = stream([line({ type: "progress", seconds: 10 }), line({ type: "finished" }), line({ type: "result", result })]);
    fetchMock.mockResolvedValue(s.response);
    const onEvent = vi.fn();
    const e = await failure(streamBookCheck("p1", {}, onEvent));
    expect(e.data).toMatchObject({ code: INVALID_RESPONSE, detail: 'type: expected "started" or "progress" or "result" or "error", got "finished"' });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(s.cancelled()).toBe(true);
  });

  it("rejects an event whose fields are the wrong shape", async () => {
    fetchMock.mockResolvedValue(stream([line({ type: "progress", seconds: "ten" })]).response);
    const onEvent = vi.fn();
    const e = await failure(streamBookCheck("p1", {}, onEvent));
    expect(e.data?.detail).toBe('seconds: expected a number, got "ten"');
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("rejects a result whose findings are malformed", async () => {
    const bad = { ...result, findings: [{ ...result.findings[0], kind: "vibes" }] };
    fetchMock.mockResolvedValue(stream([line({ type: "result", result: bad })]).response);
    const onEvent = vi.fn();
    const e = await failure(streamBookCheck("p1", {}, onEvent));
    expect(e.data?.detail).toBe('result.findings[0].kind: expected "contradiction" or "timeline" or "bible", got "vibes"');
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("rejects a line that isn't JSON", async () => {
    fetchMock.mockResolvedValue(stream(["{not json}\n"]).response);
    const onEvent = vi.fn();
    const e = await failure(streamBookCheck("p1", {}, onEvent));
    expect(e.data).toMatchObject({ code: INVALID_RESPONSE, detail: "not JSON" });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("rejects a reply cut off partway through a line", async () => {
    const full = line({ type: "result", result });
    fetchMock.mockResolvedValue(stream([line({ type: "progress", seconds: 10 }), full.slice(0, 40)]).response);
    const onEvent = vi.fn();
    const e = await failure(streamBookCheck("p1", {}, onEvent));
    expect(e.data?.code).toBe(INVALID_RESPONSE);
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it("reports refusals before the stream starts like any other request", async () => {
    fetchMock.mockResolvedValue(json({ error: "Daily limit reached", code: "daily_limit" }, 429));
    const e = await failure(streamBookCheck("p1", {}, vi.fn()));
    expect(e.status).toBe(429);
    expect(e.message).toBe("Daily limit reached");
  });
});
