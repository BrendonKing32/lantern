import type { AiEnv } from "./ai";
import type { BackupEnv } from "./backups";

export interface Env extends AiEnv, BackupEnv {
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  DEV_BYPASS?: string;
  GITHUB_CHANGELOG_TOKEN?: string;
  /** Claude connector OAuth state. Absent on Previews, which then refuse /mcp. */
  OAUTH_KV?: KVNamespace;
  /** Comma-separated hosts the connector may send tokens to (default claude.ai,claude.com). */
  MCP_REDIRECT_HOSTS?: string;
}
