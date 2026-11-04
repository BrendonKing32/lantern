import type {
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
