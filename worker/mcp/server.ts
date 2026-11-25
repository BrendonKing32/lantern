// The MCP endpoint itself. Stateless: each POST gets a fresh server and
// transport, so nothing has to live between requests (no Durable Object).
import { insufficientScope, type OAuthResourceAuth } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Env } from "../env";
import { registerTools } from "./tools";
import { registerWriteTools } from "./writes";

export const READ_SCOPE = "lantern:read";
export const WRITE_SCOPE = "lantern:write";

const ABOUT = `Lantern is the author's novel-writing app. Each novel has chapters of markdown text, \
chapter synopses, scene cards, and a story guide of characters, places, things and notes. \
In chapter text, [[Name]] and [[Name|shown words]] link to story guide entries; \
***, --- or a lone # on its own line marks a scene break. Scene cards can be tied to passages between breaks. \
Start with list_novels, then get_outline for chapter ids.`;

const MILESTONE_INSTRUCTIONS = "Milestones are read-only through this connection.";

export const READ_ONLY_INSTRUCTIONS = `${ABOUT} ${MILESTONE_INSTRUCTIONS} This connection can read but not change anything.`;

export const WRITE_INSTRUCTIONS = `${ABOUT} ${MILESTONE_INSTRUCTIONS}

This connection can also make changes. The manuscript is the author's own work, so:
- Change only what the author asked for, and keep their voice. Don't tidy, restyle or "improve" anything else.
- Your changes to chapter text never go straight into the chapter. They collect in an AI draft of that \
chapter, kept beside it until the author accepts or discards it in Lantern. Tell the author which chapters \
have a draft waiting and what you changed.
- Read a chapter before editing it, and pass the version read_chapter gives as base_version. Once a chapter \
has a draft, edits apply to the draft: read it with read_draft and pass its draft version instead. If the \
text has changed since you read it, the edit is refused: read it again and redo it.
- Prefer edit_chapter with small, exact passages over rewriting large stretches.
- A margin note is often a better way to suggest a change than editing the chapter.
- move_scene moves an in-text card with its passage and keeps a History copy.
- Nothing can be deleted through this connection.`;

export interface McpProps {
  email: string;
}

type Ctx = ExecutionContext & { props?: McpProps; auth?: OAuthResourceAuth };

export function createMcpServer(env: Env, { canWrite = false } = {}): McpServer {
  const server = new McpServer(
    { name: "lantern", title: "Lantern", version: "1.1.0" },
    { instructions: canWrite ? WRITE_INSTRUCTIONS : READ_ONLY_INSTRUCTIONS },
  );
  registerTools(server, env);
  if (canWrite) registerWriteTools(server, env);
  return server;
}

export async function handleMcp(req: Request, env: Env, canWrite = false): Promise<Response> {
  if (req.method !== "POST") {
    // Stateless server: no standalone event stream and no sessions to close.
    return new Response(null, { status: 405, headers: { allow: "POST" } });
  }
  const server = createMcpServer(env, { canWrite });
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
    // Connections allowed to edit see the write tools too; the others never do.
    return handleMcp(req, env, ctx.auth.scope.includes(WRITE_SCOPE));
  },
};
