import type {
  AiStatus,
  BookCheckEvent,
  BookCheckResult,
  BibleEntryDraft,
  CheckResult,
  BibleEntry,
  BibleKind,
  ChapterMeta,
  ChapterWithContent,
  DeletedChapter,
  DeletedProject,
  ProjectDetail,
  ProjectSummary,
  SaveResult,
  Snapshot,
  SnapshotWithContent,
  Stats,
} from "../shared/types";
import { localDay } from "./when";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public data: Record<string, unknown> | null,
  ) {
    super(message);
  }
}

// A network failure (offline, or an expired Access session redirecting to the
// login page) throws a TypeError from fetch; callers treat that as "offline".
async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { keepalive?: boolean } = {},
): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    keepalive: opts.keepalive,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data);
  return data as T;
}

export const api = {
  listProjects: () => request<ProjectSummary[]>("GET", "/api/projects"),
  createProject: (title: string) =>
    request<{ id: string; title: string }>("POST", "/api/projects", { title }),
  getProject: (id: string) => request<ProjectDetail>("GET", `/api/projects/${id}`),
  renameProject: (id: string, title: string) =>
    request<{ id: string; title: string }>("PATCH", `/api/projects/${id}`, { title }),
  setArchived: (id: string, archived: boolean) =>
    request<{ id: string; archived_at: string | null }>("PATCH", `/api/projects/${id}`, { archived }),
  deleteProject: (id: string) => request<{ ok: true }>("DELETE", `/api/projects/${id}`),
  bible: (projectId: string) => request<BibleEntry[]>("GET", `/api/projects/${projectId}/bible`),
  createEntry: (projectId: string, entry: { name: string; kind: BibleKind; aliases?: string[]; body?: string }) =>
    request<BibleEntry>("POST", `/api/projects/${projectId}/bible`, entry),
  updateEntry: (id: string, patch: Partial<Pick<BibleEntry, "name" | "kind" | "aliases" | "body">>) =>
    request<BibleEntry>("PATCH", `/api/bible/${id}`, patch),
  deleteEntry: (id: string) => request<{ ok: true }>("DELETE", `/api/bible/${id}`),
  checkChapter: (chapterId: string, content: string) =>
    request<CheckResult>("POST", `/api/chapters/${chapterId}/check`, { content }),
  draftBibleEntry: (chapterId: string, content: string, quote: string) =>
    request<BibleEntryDraft>("POST", `/api/chapters/${chapterId}/draft-entry`, { content, quote }),
  lastBookCheck: (projectId: string) => request<BookCheckResult | null>("GET", `/api/projects/${projectId}/check-book`),
  aiStatus: () => request<AiStatus>("GET", "/api/ai/status"),
  aiTest: () =>
    request<{ ok: boolean; reply: string; model: string; ms: number; cost_usd: number }>("POST", "/api/ai/test"),
  stats: () => request<Stats>("GET", `/api/stats?today=${localDay()}`),
  setGoal: (dailyGoal: number | null) =>
    request<{ daily_goal: number | null }>("PUT", "/api/goal", { daily_goal: dailyGoal }),
  setTarget: (projectId: string, words: number | null, date: string | null) =>
    request<{ target_words: number | null; target_date: string | null }>(
      "PUT",
      `/api/projects/${projectId}/target`,
      { target_words: words, target_date: date },
    ),
  deletedProjects: () => request<DeletedProject[]>("GET", "/api/trash/projects"),
  restoreProject: (id: string) => request<ProjectSummary>("POST", `/api/projects/${id}/restore`),
  deletedChapters: (projectId: string) => request<DeletedChapter[]>("GET", `/api/projects/${projectId}/trash`),
  restoreChapter: (id: string) => request<ChapterMeta>("POST", `/api/chapters/${id}/restore`),
  createChapter: (projectId: string, title: string) =>
    request<ChapterMeta>("POST", `/api/projects/${projectId}/chapters`, { title }),
  reorder: (projectId: string, chapterIds: string[]) =>
    request<{ ok: true }>("PUT", `/api/projects/${projectId}/order`, { chapterIds }),
  getChapter: (id: string) => request<ChapterWithContent>("GET", `/api/chapters/${id}`),
  /** `snapshot` asks the server to keep the text being replaced in history. */
  saveChapter: (
    id: string,
    content: string,
    baseVersion: number,
    opts: { keepalive?: boolean; snapshot?: "restore" | "conflict"; writtenAt?: number } = {},
  ) =>
    request<SaveResult>(
      "PUT",
      `/api/chapters/${id}`,
      // `day` credits the words to the local date they were written on.
      { content, baseVersion, snapshot: opts.snapshot, day: localDay(opts.writtenAt) },
      { keepalive: opts.keepalive },
    ),
  updateChapter: (id: string, patch: { title?: string; synopsis?: string }) =>
    request<ChapterMeta>("PATCH", `/api/chapters/${id}`, patch),
  deleteChapter: (id: string) => request<{ ok: true }>("DELETE", `/api/chapters/${id}`),
  listHistory: (chapterId: string) => request<Snapshot[]>("GET", `/api/chapters/${chapterId}/history`),
  getSnapshot: (chapterId: string, snapshotId: string) =>
    request<SnapshotWithContent>("GET", `/api/chapters/${chapterId}/history/${snapshotId}`),
};

export function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return "You're signed out. Reload the page to sign in again.";
    if (e.status === 503) return e.message;
    return e.message;
  }
  return "Can't reach Lantern. Check your connection and try again.";
}

/**
 * Run a whole-book check, calling onEvent for each line the server streams
 * back. Refusals before the check starts (limits, too long, not set up) throw
 * an ApiError like any other request.
 */
export async function streamBookCheck(
  projectId: string,
  overrides: Record<string, string>,
  onEvent: (e: BookCheckEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/check-book`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ overrides }),
    signal,
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error ?? res.statusText, data);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffered += value;
    let nl: number;
    while ((nl = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (line) onEvent(JSON.parse(line) as BookCheckEvent);
    }
    if (done) break;
  }
}
