import type { AiEnv } from "./ai";
import type { BackupEnv } from "./backups";

export interface Env extends AiEnv, BackupEnv {
  ASSETS: Fetcher;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  DEV_BYPASS?: string;
}
