// The MCP endpoint itself. Stateless: each POST gets a fresh server and
// transport, so nothing has to live between requests (no Durable Object).
import { insufficientScope, type OAuthResourceAuth } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Env } from "../env";
import { registerTools } from "./tools";

export const READ_SCOPE = "lantern:read";

export const SERVER_INSTRUCTIONS = `Lantern is the author's novel-writing app. Each novel has chapters of markdown text, \
chapter synopses, scene cards, and a story guide of characters, places, things and notes. \
In chapter text, [[Name]] and [[Name|shown words]] link to story guide entries; \
***, --- or a lone # on its own line marks a scene break. \
Start with list_novels, then get_outline for chapter ids. This connection can read but not change anything.`;

export interface McpProps {
  email: string;
}

type Ctx = ExecutionContext & { props?: McpProps; auth?: OAuthResourceAuth };

export function createMcpServer(env: Env): McpServer {
  const server = new McpServer(
    { name: "lantern", title: "Lantern", version: "1.0.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, env);
  return server;
}

export async function handleMcp(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") {
    // Stateless server: no standalone event stream and no sessions to close.
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  const server = createMcpServer(env);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // JSON responses are complete once handleRequest resolves.
    void server.close();
  }
}

export const mcpApiHandler = {
  async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    // The provider only calls this with a valid token, so auth and props are set.
    if (!ctx.auth || !ctx.props?.email) return new Response("Unauthorized", { status: 401 });
    if (!ctx.auth.scope.includes(READ_SCOPE)) return insufficientScope(ctx.auth, [READ_SCOPE]);
    return handleMcp(req, env);
  },
};
