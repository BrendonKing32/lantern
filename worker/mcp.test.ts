import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import worker, { type Env } from "./index";
import { findMatches, READ_LIMIT } from "./mcp/tools";
import { isOAuthPath, pageCsp, publicOrigin, redirectAllowed } from "./mcp/oauth";
import { createMcpServer } from "./mcp/server";

// ---------- fakes ----------

const project = {
  id: "novel-1",
  title: "The Lamplighter",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-02-01T00:00:00.000Z",
  archived_at: null,
  deleted_at: null,
  target_words: 90000,
  target_date: null,
  dialect: "british",
};

const chapterRows = [
  { id: "ch-1", project_id: "novel-1", title: "Arrival", synopsis: "Mara reaches the harbour.", position: 0, word_count: 7, version: 3, updated_at: "2026-02-01T00:00:00.000Z", act_id: null },
  { id: "ch-2", project_id: "novel-1", title: "The Tower", synopsis: "", position: 1, word_count: 6, version: 1, updated_at: "2026-02-01T00:00:00.000Z", act_id: null },
];

const texts: Record<string, string> = {
  "projects/novel-1/chapters/ch-1.md": "Mara stepped off the boat.\nThe lamp was lit.",
  "projects/novel-1/chapters/ch-2.md": "[[Mara|She]] climbed the tower. The lamp went out.",
  "projects/novel-1/chapters/ch-1/history/snap-1.md": "An earlier opening.",
};

const entries = [
  { id: "e-1", project_id: "novel-1", kind: "character", name: "Mara Venn", aliases: '["Mara"]', body: "Keeper of the light.", created_at: "", updated_at: "" },
  { id: "e-2", project_id: "novel-1", kind: "place", name: "The Tower", aliases: "[]", body: "x".repeat(400), created_at: "", updated_at: "" },
];

const scenes = [
  { id: "s-1", chapter_id: "ch-1", title: "Landing", summary: "She lands.", pov: "Mara", location: "Harbour", status: "drafted", position: 0 },
  { id: "s-2", chapter_id: null, title: "Storm", summary: "", pov: "", location: "", status: "planned", position: 0 },
];

const snapshots = [{ id: "snap-1", chapter_id: "ch-1", version: 2, word_count: 3, reason: "auto", created_at: "2026-01-20T00:00:00.000Z" }];

function fakeDb() {
  const run = (sql: string, args: unknown[]) => {
    const q = sql.replace(/\s+/g, " ");
    if (q.includes("FROM projects p")) {
      return [{ ...project, archived: 0, chapter_count: chapterRows.length, word_count: 13 }];
    }
    if (q.includes("FROM projects WHERE id = ?")) return args[0] === project.id ? [project] : [];
    if (q.includes("FROM chapters WHERE id = ?") || q.includes("FROM chapters WHERE id = ? AND")) {
      return chapterRows.filter((c) => c.id === args[0]);
    }
    if (q.includes("FROM chapters WHERE project_id = ?")) return chapterRows.filter((c) => c.project_id === args[0]);
    if (q.includes("FROM scenes")) return scenes;
    if (q.includes("FROM acts")) return [];
    if (q.includes("FROM bible_entries")) {
      return entries.filter((e) => e.project_id === args[0] && (args.length < 2 || e.kind === args[1]));
    }
    if (q.includes("FROM chapter_snapshots WHERE id = ?")) {
      return snapshots.filter((s) => s.id === args[0] && s.chapter_id === args[1]);
    }
    if (q.includes("FROM chapter_snapshots")) return snapshots.filter((s) => s.chapter_id === args[0]);
    if (q.includes("FROM claude_drafts")) return [];
    throw new Error(`unexpected query: ${q}`);
  };
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => statement(sql, a),
    all: async () => ({ results: run(sql, args) }),
    first: async () => run(sql, args)[0] ?? null,
    run: async () => {
      throw new Error("the connector must not write");
    },
  });
  return { prepare: (sql: string) => statement(sql) };
}

function fakeBucket() {
  return {
    get: async (key: string) => (key in texts ? { text: async () => texts[key] } : null),
    put: async () => {
      throw new Error("the connector must not write");
    },
  };
}

function fakeKv() {
  const store = new Map<string, { value: string; expires?: number }>();
  const live = (key: string) => {
    const item = store.get(key);
    if (item?.expires && item.expires * 1000 < Date.now()) store.delete(key);
    return store.get(key);
  };
  return {
    async get(key: string, opts?: string | { type?: string }) {
      const item = live(key);
      if (!item) return null;
      const type = typeof opts === "string" ? opts : opts?.type;
      return type === "json" ? JSON.parse(item.value) : item.value;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number; expiration?: number }) {
      const expires = opts?.expiration ?? (opts?.expirationTtl ? Date.now() / 1000 + opts.expirationTtl : undefined);
      store.set(key, { value, expires });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(opts: { prefix?: string; limit?: number } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? "") && live(k)).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: "" };
    },
  };
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response("asset") },
    DB: fakeDb(),
    BUCKET: fakeBucket(),
    OAUTH_KV: fakeKv(),
    ACCESS_TEAM_DOMAIN: "",
    ACCESS_AUD: "",
    DEV_BYPASS: "true",
    MCP_REDIRECT_HOSTS: "claude.ai,claude.com",
    ...overrides,
  } as unknown as Env;
}

const ctx = () => ({ waitUntil() {}, passThroughOnException() {}, props: {} }) as unknown as ExecutionContext;

async function connect(e: Env) {
  const server = createMcpServer(e);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  return client;
}

const textOf = (result: unknown) => ((result as { content: { text: string }[] }).content[0]?.text ?? "");
const jsonOf = (result: unknown) => JSON.parse(textOf(result));

// ---------- helpers ----------

describe("connector routing", () => {
  it("claims only the OAuth and MCP paths", () => {
    for (const p of ["/mcp", "/authorize", "/oauth/token", "/oauth/register", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"]) {
      expect(isOAuthPath(p)).toBe(true);
    }
    for (const p of ["/", "/api/projects", "/share/abc", "/mcpx", "/authorized", "/assets/app.js"]) {
      expect(isOAuthPath(p)).toBe(false);
    }
  });

  it("sends tokens only to the allowed https hosts", () => {
    const e = env();
    expect(redirectAllowed(e, "https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(redirectAllowed(e, "https://claude.com/api/mcp/auth_callback")).toBe(true);
    expect(redirectAllowed(e, "http://claude.ai/api/mcp/auth_callback")).toBe(false);
    expect(redirectAllowed(e, "https://claude.ai.evil.example/cb")).toBe(false);
    expect(redirectAllowed(e, "https://evil.example/cb")).toBe(false);
    expect(redirectAllowed(e, "not a url")).toBe(false);
  });

  it("accepts local callbacks only in local development", () => {
    expect(redirectAllowed(env({ DEV_BYPASS: undefined }), "http://localhost:6274/oauth/callback")).toBe(false);
    expect(redirectAllowed(env(), "http://localhost:6274/oauth/callback")).toBe(true);
    expect(redirectAllowed(env(), "http://127.0.0.1:6274/cb")).toBe(true);
  });

  it("treats every host but loopback as https", async () => {
    expect(publicOrigin(new URL("http://lantern.example/mcp"))).toBe("https://lantern.example");
    expect(publicOrigin(new URL("https://lantern.example/mcp"))).toBe("https://lantern.example");
    expect(publicOrigin(new URL("http://127.0.0.1:8787/mcp"))).toBe("http://127.0.0.1:8787");
    expect(publicOrigin(new URL("http://localhost:8787/mcp"))).toBe("http://localhost:8787");
    const res = await worker.fetch(new Request("http://lantern.test/.well-known/oauth-authorization-server"), env(), ctx());
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("https://lantern.test/.well-known/oauth-authorization-server");
    const post = await worker.fetch(new Request("http://lantern.test/oauth/token", { method: "POST" }), env(), ctx());
    expect(post.status).toBe(400);
  });

  it("refuses the connector where it has no storage, as on Previews", async () => {
    const res = await worker.fetch(new Request("https://lantern.test/mcp", { method: "POST" }), env({ OAUTH_KV: undefined }), ctx());
    expect(res.status).toBe(503);
  });
});

describe("findMatches", () => {
  const chapter = (id: string) => ({ ...chapterRows[0], id });
  it("finds every literal match in reading order with context", () => {
    const r = findMatches(
      [
        { chapter: chapter("a"), number: 1, content: "the Lamp\nno\nlamp, lamp" },
        { chapter: chapter("b"), number: 2, content: "LAMP" },
      ],
      "lamp",
      false,
    );
    expect(r.total).toBe(4);
    expect(r.matches.map((m) => [m.chapter_id, m.line])).toEqual([["a", 1], ["a", 3], ["a", 3], ["b", 1]]);
  });

  it("can match case and caps the results it returns", () => {
    const books = [{ chapter: chapter("a"), number: 1, content: "Lamp lamp Lamp" }];
    expect(findMatches(books, "Lamp", true).total).toBe(2);
    const capped = findMatches(books, "lamp", false, 1);
    expect(capped.total).toBe(3);
    expect(capped.matches).toHaveLength(1);
  });

  it("trims long lines around the match", () => {
    const line = `${"a".repeat(500)}NEEDLE${"b".repeat(500)}`;
    const [m] = findMatches([{ chapter: chapter("a"), number: 1, content: line }], "needle", false).matches;
    expect(m.text.startsWith("…")).toBe(true);
    expect(m.text.endsWith("…")).toBe(true);
    expect(m.text.length).toBeLessThan(260);
  });
});

// ---------- tools ----------

describe("connector tools", () => {
  it("offers only read-only tools", async () => {
    const client = await connect(env());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_outline", "get_story_entry", "get_story_guide", "list_history", "list_novels", "read_chapter", "read_draft", "read_version",
      "search_book",
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("lists novels and outlines one", async () => {
    const client = await connect(env());
    const novels = jsonOf(await client.callTool({ name: "list_novels", arguments: {} }));
    expect(novels).toEqual([expect.objectContaining({ id: "novel-1", title: "The Lamplighter", archived: false, chapter_count: 2 })]);

    const outline = jsonOf(await client.callTool({ name: "get_outline", arguments: { novel_id: "novel-1" } }));
    expect(outline.dialect).toBe("british");
    expect(outline.word_count).toBe(13);
    expect(outline.chapters.map((c: { number: number; title: string }) => [c.number, c.title])).toEqual([[1, "Arrival"], [2, "The Tower"]]);
    expect(outline.chapters[0].scenes).toEqual([
      { id: "s-1", title: "Landing", summary: "She lands.", pov: "Mara", location: "Harbour", status: "drafted" },
    ]);
    expect(outline.chapters[1].scenes).toEqual([]);
    expect(outline.unassigned_scenes).toEqual([
      { id: "s-2", title: "Storm", summary: "", pov: "", location: "", status: "planned" },
    ]);
  });

  it("reads a chapter with its version", async () => {
    const client = await connect(env());
    const out = textOf(await client.callTool({ name: "read_chapter", arguments: { chapter_id: "ch-1" } }));
    expect(out).toContain("# Arrival");
    expect(out).toContain("version 3");
    expect(out).toContain("Mara stepped off the boat.\nThe lamp was lit.");
  });

  it("reads long chapters in slices", async () => {
    const long = "w".repeat(READ_LIMIT + 10);
    texts["projects/novel-1/chapters/ch-2.md"] = long;
    try {
      const client = await connect(env());
      const first = textOf(await client.callTool({ name: "read_chapter", arguments: { chapter_id: "ch-2" } }));
      expect(first).toContain(`continue with offset ${READ_LIMIT}`);
      const rest = textOf(await client.callTool({ name: "read_chapter", arguments: { chapter_id: "ch-2", offset: READ_LIMIT } }));
      expect(rest.endsWith("w".repeat(10))).toBe(true);
      expect(rest).not.toContain("continue with");
    } finally {
      texts["projects/novel-1/chapters/ch-2.md"] = "[[Mara|She]] climbed the tower. The lamp went out.";
    }
  });

  it("reports a missing chapter as a tool error", async () => {
    const client = await connect(env());
    const r = await client.callTool({ name: "read_chapter", arguments: { chapter_id: "nope" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Chapter not found");
  });

  it("searches the whole book", async () => {
    const client = await connect(env());
    const r = jsonOf(await client.callTool({ name: "search_book", arguments: { novel_id: "novel-1", query: "lamp" } }));
    expect(r.total).toBe(2);
    expect(r.matches.map((m: { chapter: number }) => m.chapter)).toEqual([1, 2]);
  });

  it("previews the story guide and finds an entry by alias", async () => {
    const client = await connect(env());
    const guide = jsonOf(await client.callTool({ name: "get_story_guide", arguments: { novel_id: "novel-1" } }));
    expect(guide.map((e: { name: string }) => e.name)).toEqual(["Mara Venn", "The Tower"]);
    expect(guide[1].notes.length).toBe(301);

    const places = jsonOf(await client.callTool({ name: "get_story_guide", arguments: { novel_id: "novel-1", kind: "place" } }));
    expect(places.map((e: { name: string }) => e.name)).toEqual(["The Tower"]);

    const mara = jsonOf(await client.callTool({ name: "get_story_entry", arguments: { novel_id: "novel-1", entry: "mara" } }));
    expect(mara).toMatchObject({ id: "e-1", name: "Mara Venn", aliases: ["Mara"], body: "Keeper of the light." });
  });

  it("lists and reads earlier versions", async () => {
    const client = await connect(env());
    const history = jsonOf(await client.callTool({ name: "list_history", arguments: { chapter_id: "ch-1" } }));
    expect(history).toEqual([expect.objectContaining({ id: "snap-1", reason: "auto" })]);
    const v = textOf(await client.callTool({ name: "read_version", arguments: { chapter_id: "ch-1", version_id: "snap-1" } }));
    expect(v).toContain("An earlier opening.");
    const wrong = await client.callTool({ name: "read_version", arguments: { chapter_id: "ch-2", version_id: "snap-1" } });
    expect(wrong.isError).toBe(true);
  });
});

// ---------- OAuth, end to end ----------

const ORIGIN = "https://lantern.test";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

const send = (e: Env, path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), e, ctx());

async function register(e: Env, redirect = REDIRECT) {
  const res = await send(e, "/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { client_id: string };
}

function authorizeUrl(clientId: string, challenge: string, redirect = REDIRECT) {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    scope: "lantern:read offline_access",
    resource: `${ORIGIN}/mcp`,
  });
  return `/authorize?${q}`;
}

const cookiesFrom = (res: Response) =>
  res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

async function signIn(e: Env, access?: "read" | "edit") {
  const { client_id } = await register(e);
  const { verifier, challenge } = await pkce();
  const consent = await send(e, authorizeUrl(client_id, challenge));
  expect(consent.status).toBe(200);
  const html = await consent.text();
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1] ?? "";
  const approve = await send(e, "/authorize", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookiesFrom(consent) },
    body: new URLSearchParams({ handle, decision: "approve", ...(access ? { access } : {}) }),
  });
  expect(approve.status).toBe(302);
  const back = new URL(approve.headers.get("location") ?? "");
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
  expect(back.searchParams.get("state")).toBe("xyz");
  const token = await send(e, "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: back.searchParams.get("code") ?? "",
      redirect_uri: REDIRECT,
      client_id,
      code_verifier: verifier,
      resource: `${ORIGIN}/mcp`,
    }),
  });
  expect(token.status).toBe(200);
  return { html, token: (await token.json()) as { access_token: string; refresh_token?: string; scope: string } };
}

const rpc = (e: Env, token: string, body: object) =>
  send(e, "/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify(body),
  });

describe("connector sign-in", () => {
  it("publishes discovery documents", async () => {
    const e = env();
    const resource = await send(e, "/.well-known/oauth-protected-resource/mcp");
    expect(resource.status).toBe(200);
    expect(await resource.json()).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    const server = await (await send(e, "/.well-known/oauth-authorization-server")).json();
    expect(server).toMatchObject({ authorization_endpoint: `${ORIGIN}/authorize`, token_endpoint: `${ORIGIN}/oauth/token` });
  });

  it("challenges /mcp without a token", async () => {
    const res = await send(env(), "/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("asks before connecting, then serves the tools with the token", async () => {
    const e = env();
    const { html, token } = await signIn(e);
    expect(html).toContain("Connect Claude to Lantern?");
    expect(html).toMatch(/name="access" value="read" checked/);
    expect(token.scope.split(" ")).not.toContain("lantern:write");
    expect(html).toContain("claude.ai");
    expect(html).toContain("dev@localhost");
    expect(token.scope.split(" ")).toContain("lantern:read");
    expect(token.refresh_token).toBeTruthy();

    const init = await rpc(e, token.access_token, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    expect(init.status).toBe(200);
    const initBody = (await init.json()) as { result: { serverInfo: { name: string }; instructions: string } };
    expect(initBody.result.serverInfo.name).toBe("lantern");
    expect(initBody.result.instructions).toContain("can read but not change");

    const call = await rpc(e, token.access_token, {
      jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_novels", arguments: {} },
    });
    const body = (await call.json()) as { result: { content: { text: string }[] } };
    expect(JSON.parse(body.result.content[0].text)[0].title).toBe("The Lamplighter");
  });

  it("lets the consent form's redirect reach Claude, and nowhere else", async () => {
    // Browsers apply form-action to the redirect after Allow or Deny; with only
    // 'self', Chrome stays on the page after approving and a second click fails.
    const e = env();
    const { client_id } = await register(e);
    const { challenge } = await pkce();
    const consent = await send(e, authorizeUrl(client_id, challenge));
    const csp = consent.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("form-action 'self' https://claude.ai;");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(pageCsp()).toContain("form-action 'self';");
  });

  it("serves the write tools only to a connection allowed to edit", async () => {
    const e = env();
    const reader = await signIn(e, "read");
    const editor = await signIn(e, "edit");
    expect(editor.token.scope.split(" ")).toEqual(expect.arrayContaining(["lantern:read", "lantern:write"]));
    const list = async (token: string) => {
      const res = await rpc(e, token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
      return ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    };
    expect(await list(reader.token.access_token)).not.toContain("edit_chapter");
    expect(await list(editor.token.access_token)).toContain("edit_chapter");
  });

  it("rejects a forged or reused consent form", async () => {
    const e = env();
    const { client_id } = await register(e);
    const { challenge } = await pkce();
    const consent = await send(e, authorizeUrl(client_id, challenge));
    const handle = (await consent.text()).match(/name="handle" value="([^"]+)"/)?.[1] ?? "";
    // No binding cookie: a form posted from another site.
    const forged = await send(e, "/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle, decision: "approve" }),
    });
    expect(forged.status).toBe(400);
    expect(forged.headers.get("location")).toBeNull();
  });

  it("refuses to send access anywhere but Claude", async () => {
    const e = env();
    const evil = "https://evil.example/callback";
    const { client_id } = await register(e, evil);
    const { challenge } = await pkce();
    const res = await send(e, authorizeUrl(client_id, challenge, evil));
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('name="handle"');
  });

  it("needs the Access sign-in to show the consent page", async () => {
    const e = env({ DEV_BYPASS: undefined, ACCESS_TEAM_DOMAIN: "team.example.com", ACCESS_AUD: "aud" });
    const res = await send(e, "/authorize?client_id=x");
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Sign in to Lantern first");
  });

  it("denies cleanly", async () => {
    const e = env();
    const { client_id } = await register(e);
    const { challenge } = await pkce();
    const consent = await send(e, authorizeUrl(client_id, challenge));
    const handle = (await consent.text()).match(/name="handle" value="([^"]+)"/)?.[1] ?? "";
    const res = await send(e, "/authorize", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookiesFrom(consent) },
      body: new URLSearchParams({ handle, decision: "deny" }),
    });
    expect(res.status).toBe(302);
    const back = new URL(res.headers.get("location") ?? "");
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("xyz");
  });
});
