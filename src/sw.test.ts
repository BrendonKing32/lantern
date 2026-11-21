import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Runs the real public/sw.js against a fake service worker global and records
// which requests it takes over.

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

type Listener = (event: unknown) => void;
type FakeResponse = { ok: boolean; type: string; clone: () => FakeResponse; text: () => Promise<string> };

function load() {
  const listeners: Record<string, Listener> = {};
  const saved: { cache: string; key: string; body: string }[] = [];
  const deleted: string[] = [];
  const self = {
    location: { origin: "https://lantern.test" },
    addEventListener: (type: string, fn: Listener) => (listeners[type] = fn),
    skipWaiting() {},
    clients: { claim: async () => {} },
  };
  const caches = {
    open: async (cache: string) => ({
      add: async () => {},
      match: async () => undefined,
      put: async (key: string | { url: string }, res: FakeResponse) =>
        saved.push({ cache, key: typeof key === "string" ? key : key.url, body: await res.text() }),
    }),
    keys: async () => ["lantern-shell-v1", "lantern-assets-v1"],
    delete: async (name: string) => deleted.push(name),
    match: async () => undefined,
  };
  const fetch = async (req: { url: string }): Promise<FakeResponse> => {
    const body = `page for ${new URL(req.url).pathname}`;
    const res: FakeResponse = { ok: true, type: "basic", clone: () => res, text: async () => body };
    return res;
  };
  new Function("self", "caches", "fetch", source)(self, caches, fetch);

  async function navigate(path: string, method = "GET") {
    const request = { url: `https://lantern.test${path}`, method, mode: "navigate" };
    let responded: Promise<FakeResponse> | undefined;
    listeners.fetch({ request, respondWith: (r: Promise<FakeResponse>) => (responded = r) });
    if (responded) await responded;
    await new Promise((r) => setTimeout(r, 0));
    return responded !== undefined;
  }
  return { listeners, saved, deleted, navigate };
}

describe("service worker", () => {
  it("leaves the connector's sign-in pages to the browser", async () => {
    const sw = load();
    for (const path of ["/authorize?client_id=x", "/mcp", "/oauth/token", "/.well-known/oauth-authorization-server", "/api/projects", "/cdn-cgi/access/authorized"]) {
      expect(await sw.navigate(path), path).toBe(false);
    }
    expect(sw.saved).toEqual([]);
  });

  it("still serves app pages and keeps them as the offline shell", async () => {
    const sw = load();
    expect(await sw.navigate("/")).toBe(true);
    expect(await sw.navigate("/projects/abc")).toBe(true);
    expect(sw.saved.map((s) => [s.cache, s.key])).toEqual([
      ["lantern-shell-v2", "/"],
      ["lantern-shell-v2", "/"],
    ]);
  });

  it("ignores form posts", async () => {
    expect(await load().navigate("/authorize", "POST")).toBe(false);
  });

  it("drops the old shell, which may hold a saved consent page", async () => {
    const sw = load();
    let done: Promise<unknown> | undefined;
    sw.listeners.activate({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    expect(sw.deleted).toEqual(["lantern-shell-v1"]);
  });
});
