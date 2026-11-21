import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env";
import { HttpError } from "./http";

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authorize(req: Request, env: Env): Promise<string> {
  if (env.DEV_BYPASS === "true") return "dev@localhost";
  // Fail closed: if Access isn't configured yet, no private API request gets in.
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new HttpError(503, "Access is not configured for this deployment");
  }
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new HttpError(401, "Not signed in");
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  try {
    let jwks = jwksByIssuer.get(issuer);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      jwksByIssuer.set(issuer, jwks);
    }
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: env.ACCESS_AUD });
    return typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "unknown";
  } catch {
    throw new HttpError(401, "Invalid Access token");
  }
}
