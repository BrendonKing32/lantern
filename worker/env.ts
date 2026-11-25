import type { AiEnv } from "./ai";
import type { BackupEnv } from "./backups";

export interface Env extends AiEnv, BackupEnv {
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  DEV_BYPASS?: string;
  /** MCP connector OAuth state. Absent on Previews, which then refuse /mcp. */
  OAUTH_KV?: KVNamespace;
  /** Comma-separated HTTPS callback hosts (default claude.ai,claude.com,chatgpt.com). */
  MCP_REDIRECT_HOSTS?: string;
  /** Comma-separated exact callbacks; HTTPS, or HTTP on loopback for desktop clients. */
  MCP_REDIRECT_URIS?: string;
}
