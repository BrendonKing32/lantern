// OAuth for the Claude connector. The Worker is its own authorization server
// (@cloudflare/workers-oauth-provider, state in the OAUTH_KV namespace) and the
// /mcp endpoint is the only resource it protects.
//
// Signing in is left to Cloudflare Access: /authorize stays behind Access like
// the rest of the app, so by the time a request reaches it the author has
// signed in, and the Worker checks the Access token exactly as the private API
// does. Only /mcp, the token and registration endpoints and the discovery
// documents bypass Access; each checks its own credentials.
import OAuthProvider, {
  AuthorizationError,
  CimdFetchError,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { authorize as accessUser } from "../auth";
import type { Env } from "../env";
import { HttpError } from "../http";
import { mcpApiHandler, READ_SCOPE, type McpProps } from "./server";

export const MCP_PATH = "/mcp";
export const AUTHORIZE_PATH = "/authorize";
const TOKEN_PATH = "/oauth/token";
const REGISTER_PATH = "/oauth/register";
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/;

/** Paths the OAuth provider answers. Everything else is the app as before. */
export function isOAuthPath(pathname: string): boolean {
  return (
    pathname === MCP_PATH ||
    pathname.startsWith(`${MCP_PATH}/`) ||
    pathname === AUTHORIZE_PATH ||
    pathname.startsWith("/oauth/") ||
    pathname.startsWith("/.well-known/oauth-")
  );
}

/** Where tokens may be sent. Claude's connector callback lives on these hosts. */
export function allowedRedirectHosts(env: Env): string[] {
  return (env.MCP_REDIRECT_HOSTS ?? "claude.ai,claude.com")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

export function redirectAllowed(env: Env, redirectUri: string): boolean {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }
  // Local development only: MCP clients on this machine call back to localhost.
  if (env.DEV_BYPASS === "true" && LOOPBACK.test(url.hostname)) return true;
  return url.protocol === "https:" && allowedRedirectHosts(env).includes(url.hostname.toLowerCase());
}

type OAuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The consent page's CSP. Browsers apply form-action to every redirect a form
 * submission follows, so the Allow and Deny forms, which post here and are
 * then redirected back to the client, must name the client's callback origin
 * as well as 'self'. Only the one origin already checked against
 * MCP_REDIRECT_HOSTS is added.
 */
export function pageCsp(formTarget?: string): string {
  const formAction = formTarget ? `'self' ${new URL(formTarget).origin}` : "'self'";
  return `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`;
}

function page(title: string, body: string, status = 200, headers = new Headers(), formTarget?: string): Response {
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("content-security-policy", pageCsp(formTarget));
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  return new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · Lantern</title>
<style>
  :root { color-scheme: dark; --bg:#17130f; --card:#221c16; --text:#f1e7d8; --muted:#c3b39c; --amber:#e8a548; --line:#3a3027; }
  @media (prefers-color-scheme: light) { :root { color-scheme: light; --bg:#f6efe3; --card:#fffaf2; --text:#2a2118; --muted:#5e4f3d; --amber:#9a5b0c; --line:#e2d5c1; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px; background:var(--bg); color:var(--text);
         font: 16px/1.5 Georgia, "Iowan Old Style", serif; }
  main { width:100%; max-width:440px; background:var(--card); border:1px solid var(--line); border-radius:14px; padding:28px; }
  h1 { font-size:1.35rem; margin:0 0 12px; font-weight:600; }
  p, li { color:var(--muted); margin:0 0 12px; }
  strong { color:var(--text); }
  ul { padding-left:20px; margin:0 0 16px; }
  .warn { color:var(--text); border-left:3px solid var(--amber); padding-left:10px; }
  .row { display:flex; gap:10px; margin-top:20px; }
  button { flex:1; font:inherit; font-size:1rem; padding:10px 14px; border-radius:10px; cursor:pointer;
           border:1px solid var(--line); background:transparent; color:var(--text); }
  button.allow { background:var(--amber); border-color:var(--amber); color:#1b140c; font-weight:600; }
  button:focus-visible { outline:2px solid var(--amber); outline-offset:2px; }
</style></head>
<body><main>${body}</main></body></html>`,
    { status, headers },
  );
}

function consentPage(details: ConsentDescription, handle: string, email: string, headers: Headers): Response {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name isn't verified.";
  return page(
    `Connect ${details.clientName}`,
    `<h1>Let ${name} read your novels?</h1>
<p>${origin} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
<p>Signed in as <strong>${escape(email)}</strong>. If you allow it, it can:</p>
<ul>
  <li>List your novels and read their outlines, chapters and scene cards</li>
  <li>Read the story guide and search the text</li>
  <li>Read earlier versions in History</li>
</ul>
<p>It can't change, add or delete anything. You can disconnect it at any time from the app you're connecting.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <div class="row">
    <button type="submit" name="decision" value="deny">Deny</button>
    <button type="submit" name="decision" value="approve" class="allow">Allow</button>
  </div>
</form>`,
    200,
    headers,
    details.redirectUri,
  );
}

const refused = (message: string, status = 400) =>
  page("Can't connect", `<h1>Can't connect</h1><p>${escape(message)}</p>`, status);

function grantedScopes(requested: string[]): string[] {
  return requested.includes("offline_access") ? [READ_SCOPE, "offline_access"] : [READ_SCOPE];
}

async function handleAuthorize(req: Request, env: OAuthEnv): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") return new Response(null, { status: 405 });
  let email: string;
  try {
    email = await accessUser(req, env);
  } catch (e) {
    if (e instanceof HttpError) return refused("Sign in to Lantern first, then start connecting again.", e.status);
    throw e;
  }
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (req.method === "GET") {
      const request = await oauth.parseAuthRequest(req);
      if (!redirectAllowed(env, request.redirectUri)) {
        return refused(
          `Lantern only connects to ${allowedRedirectHosts(env).join(" or ")}. This request would send access somewhere else.`,
          403,
        );
      }
      const details = await oauth.describeConsent(request);
      const consent = await oauth.beginConsent(request);
      return consentPage(details, consent.handle, email, consent.headers);
    }

    const form = await req.formData();
    const handle = String(form.get("handle") ?? "");
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(req, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const approved = await oauth.approveConsent(req, handle);
    // Checked again on the stored request, never on anything the form sent.
    if (!redirectAllowed(env, approved.request.redirectUri)) return refused("That app isn't allowed to connect.", 403);
    const scope = grantedScopes(approved.request.scope);
    const props: McpProps = { email };
    const { redirectTo } = await oauth.completeAuthorization({
      request: { ...approved.request, scope },
      userId: encodeURIComponent(email),
      metadata: { connectedAt: new Date().toISOString() },
      scope,
      props,
    });
    approved.headers.set("location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectUri) {
      const url = new URL(error.redirectUri);
      url.searchParams.set("error", error.code);
      url.searchParams.set("error_description", error.description);
      if (error.state) url.searchParams.set("state", error.state);
      if (error.issuer) url.searchParams.set("iss", error.issuer);
      if (redirectAllowed(env, error.redirectUri)) return Response.redirect(url.toString(), 302);
      return refused(error.description);
    }
    if (error instanceof AuthorizationError) {
      return refused(`${error.description}. Start connecting again from Claude.`);
    }
    if (error instanceof CimdFetchError) return refused("This app couldn't be verified.");
    throw error;
  }
}

const providers = new Map<string, OAuthProvider<Env>>();

// The resource URL has to name the origin it's served from (production, or
// localhost under `wrangler dev`), so one provider is kept per origin.
function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: MCP_PATH,
      apiHandler: mcpApiHandler as never,
      defaultHandler: {
        fetch: (req: Request, env: Env) => {
          if (new URL(req.url).pathname === AUTHORIZE_PATH) return handleAuthorize(req, env as OAuthEnv);
          return Promise.resolve(new Response("Not found", { status: 404 }));
        },
      } as never,
      authorizeEndpoint: AUTHORIZE_PATH,
      tokenEndpoint: TOKEN_PATH,
      clientRegistrationEndpoint: REGISTER_PATH,
      scopesSupported: [READ_SCOPE, "offline_access"],
      resourceMetadata: {
        resource: `${origin}${MCP_PATH}`,
        authorization_servers: [origin],
        resource_name: "Lantern",
      },
      requiredScopes: [READ_SCOPE],
      // Access tokens last an hour; Claude refreshes them. A connection that
      // goes unused for 30 days has to be approved again.
      accessTokenTTL: 3600,
      refreshTokenTTL: 30 * 24 * 3600,
      refreshTokenIdleTTL: 30 * 24 * 3600,
      clientRegistrationTTL: 90 * 24 * 3600,
      clientIdMetadataDocumentEnabled: true,
      disallowPublicClientRegistration: false,
    });
    providers.set(origin, provider);
  }
  return provider;
}

/** The public origin: https everywhere but a loopback host under `wrangler dev`. */
export function publicOrigin(url: URL): string {
  return LOOPBACK.test(url.hostname) ? url.origin : `https://${url.host}`;
}

export async function handleOAuth(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Pull request Previews have no bindings, so there is nothing to connect to.
  if (!env.OAUTH_KV || !env.DB || !env.BUCKET) {
    return new Response(JSON.stringify({ error: "The Claude connector isn't set up on this deployment" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  const url = new URL(req.url);
  const origin = publicOrigin(url);
  // OAuth only happens over https; an http request is moved there first.
  if (origin !== url.origin) {
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Use https", { status: 400 });
    return Response.redirect(`${origin}${url.pathname}${url.search}`, 301);
  }
  return providerFor(origin).fetch(req, env, ctx);
}
