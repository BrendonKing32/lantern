import { fetchChangelog } from "../changelog";
import { HttpError, json, type Handler } from "../http";

export const getChangelog: Handler = async (_req, env) => {
  const token = env.GITHUB_CHANGELOG_TOKEN?.trim();
  if (!token) throw new HttpError(503, "Changelog isn't configured. Add the GITHUB_CHANGELOG_TOKEN secret to Lantern.");
  return json(await fetchChangelog(token));
};
