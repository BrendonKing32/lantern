import type { ChangelogEntry } from "../shared/types";

const PULLS_URL = "https://api.github.com/repos/BrendonKing32/lantern/pulls";
const PAGE_SIZE = 100;

export class ChangelogError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function entryFrom(value: unknown): ChangelogEntry | null {
  if (!isRecord(value)) throw new ChangelogError("GitHub sent an unreadable pull request response.");
  if (value.merged_at === null) return null;
  if (
    typeof value.number !== "number" ||
    !Number.isSafeInteger(value.number) ||
    value.number < 1 ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    typeof value.merged_at !== "string" ||
    !Number.isFinite(Date.parse(value.merged_at))
  ) {
    throw new ChangelogError("GitHub sent an unreadable pull request response.");
  }
  return {
    number: value.number,
    title: value.title,
    merged_at: value.merged_at,
    url: `https://github.com/BrendonKing32/lantern/pull/${value.number}`,
  };
}

export async function fetchChangelog(token: string): Promise<ChangelogEntry[]> {
  const entries = new Map<number, ChangelogEntry>();
  for (let page = 1; ; page++) {
    const query = new URLSearchParams({
      state: "closed",
      base: "main",
      sort: "created",
      direction: "desc",
      per_page: String(PAGE_SIZE),
      page: String(page),
    });
    let response: Response;
    try {
      response = await fetch(`${PULLS_URL}?${query}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "Lantern-Changelog",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ChangelogError("Couldn't reach GitHub for the changelog. Try again later.");
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        throw new ChangelogError(
          `GitHub returned ${response.status}. Check the changelog token, repository permissions, or API rate limit.`,
        );
      }
      throw new ChangelogError(`GitHub returned ${response.status} while loading the changelog. Try again later.`);
    }

    let pulls: unknown;
    try {
      pulls = await response.json();
    } catch {
      throw new ChangelogError("GitHub sent an unreadable pull request response.");
    }
    if (!Array.isArray(pulls) || pulls.length > PAGE_SIZE) {
      throw new ChangelogError("GitHub sent an unreadable pull request response.");
    }
    for (const pull of pulls) {
      const entry = entryFrom(pull);
      if (entry && !entries.has(entry.number)) entries.set(entry.number, entry);
    }
    if (pulls.length < PAGE_SIZE) break;
  }

  return [...entries.values()].sort(
    (a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at) || b.number - a.number,
  );
}
