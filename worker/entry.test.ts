import { describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";

// Covers what the entry point itself does: routing, authorization and how
// errors become responses. Feature behavior is tested elsewhere.

function env(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response("asset") },
    DB: {
      prepare() {
        throw new Error("database unavailable");
      },
    },
    ACCESS_TEAM_DOMAIN: "",
    ACCESS_AUD: "",
    DEV_BYPASS: "true",
    ...overrides,
  } as unknown as Env;
}

const call = (e: Env, method: string, path: string, init: RequestInit = {}) =>
  worker.fetch(new Request(`https://lantern.test${path}`, { method, ...init }), e);

describe("Worker entry point", () => {
  it("serves non-API paths from static assets", async () => {
    const res = await call(env(), "GET", "/projects/abc");
    expect(await res.text()).toBe("asset");
  });

  it("fails closed when Access isn't configured", async () => {
    const res = await call(env({ DEV_BYPASS: undefined }), "GET", "/api/projects");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Access is not configured for this deployment" });
  });

  it("rejects private routes without an Access token", async () => {
    const e = env({ DEV_BYPASS: undefined, ACCESS_TEAM_DOMAIN: "team.example.com", ACCESS_AUD: "aud" });
    const res = await call(e, "GET", "/api/projects");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not signed in" });
  });

  it("answers unknown API routes and methods with 404", async () => {
    expect((await call(env(), "GET", "/api/nothing-here")).status).toBe(404);
    const res = await call(env(), "POST", "/api/stats");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("turns handler HttpErrors into JSON error replies", async () => {
    const res = await call(env(), "POST", "/api/projects", { body: "{not json" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid JSON body" });
  });

  it("hides unexpected failures behind a generic 500", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call(env(), "GET", "/api/projects");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Server error" });
    log.mockRestore();
  });
});
