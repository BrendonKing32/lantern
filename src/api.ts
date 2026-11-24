import type { BibleEntry, BibleKind, BookCheckEvent, Dialect, SceneMeta } from "../shared/types";
import * as schema from "./schemas";
import { array, type Check, nullable, ShapeError } from "./validate";
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

/** What an ApiError's data.code says when the reply wasn't what this page expects. */
export const INVALID_RESPONSE = "invalid_response";

const INVALID_MESSAGE = "Lantern sent back a reply this page couldn't read. Reload the page and try again.";

// The server answered, but not with the shape this version of the page
// expects (an old tab after a deploy, a proxy's HTML page, a cut-off reply).
// It's an ApiError so callers don't mistake it for being offline.
function invalidResponse(status: number, detail: string): ApiError {
  return new ApiError(status, INVALID_MESSAGE, { error: INVALID_MESSAGE, code: INVALID_RESPONSE, detail });
}

function parse<T>(status: number, text: string, check: Check<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalidResponse(status, "not JSON");
  }
  try {
    return check(value, "");
  } catch (e) {
    if (e instanceof ShapeError) throw invalidResponse(status, e.message);
    throw e;
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  const data: unknown = await res.json().catch(() => null);
  const record = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  const message = typeof record?.error === "string" ? record.error : res.statusText || `Request failed (${res.status})`;
  return new ApiError(res.status, message, record);
}

// A network failure (offline, or an expired Access session redirecting to the
// login page) throws a TypeError from fetch; callers treat that as "offline".
async function request<T>(
  check: Check<T>,
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
  if (!res.ok) throw await errorFrom(res);
  return parse(res.status, await res.text(), check);
}

export const api = {
  listProjects: () => request(array(schema.projectSummary), "GET", "/api/projects"),
  createProject: (title: string) => request(schema.projectRef, "POST", "/api/projects", { title }),
  getProject: (id: string) => request(schema.projectDetail, "GET", `/api/projects/${id}`),
  renameProject: (id: string, title: string) => request(schema.projectRef, "PATCH", `/api/projects/${id}`, { title }),
  setArchived: (id: string, archived: boolean) =>
    request(schema.projectArchived, "PATCH", `/api/projects/${id}`, { archived }),
  deleteProject: (id: string) => request(schema.ok, "DELETE", `/api/projects/${id}`),
  bible: (projectId: string) => request(array(schema.bibleEntry), "GET", `/api/projects/${projectId}/bible`),
  createEntry: (projectId: string, entry: { name: string; kind: BibleKind; aliases?: string[]; body?: string }) =>
    request(schema.bibleEntry, "POST", `/api/projects/${projectId}/bible`, entry),
  updateEntry: (id: string, patch: Partial<Pick<BibleEntry, "name" | "kind" | "aliases" | "body">>) =>
    request(schema.bibleEntry, "PATCH", `/api/bible/${id}`, patch),
  deleteEntry: (id: string) => request(schema.ok, "DELETE", `/api/bible/${id}`),
  checkChapter: (chapterId: string, content: string) =>
    request(schema.checkResult, "POST", `/api/chapters/${chapterId}/check`, { content }),
  draftBibleEntry: (chapterId: string, content: string, quote: string) =>
    request(schema.bibleEntryDraft, "POST", `/api/chapters/${chapterId}/draft-entry`, { content, quote }),
  lastBookCheck: (projectId: string) =>
    request(nullable(schema.bookCheckResult), "GET", `/api/projects/${projectId}/check-book`),
  aiStatus: () => request(schema.aiStatus, "GET", "/api/ai/status"),
  aiTest: () => request(schema.aiTest, "POST", "/api/ai/test"),
  stats: () => request(schema.stats, "GET", `/api/stats?today=${localDay()}`),
  setGoal: (dailyGoal: number | null) => request(schema.goal, "PUT", "/api/goal", { daily_goal: dailyGoal }),
  setTarget: (projectId: string, words: number | null, date: string | null) =>
    request(schema.target, "PUT", `/api/projects/${projectId}/target`, { target_words: words, target_date: date }),
  setDialect: (projectId: string, dialect: Dialect) =>
    request(schema.dialectSetting, "PUT", `/api/projects/${projectId}/dialect`, { dialect }),
  deletedProjects: () => request(array(schema.deletedProject), "GET", "/api/trash/projects"),
  restoreProject: (id: string) => request(schema.projectSummary, "POST", `/api/projects/${id}/restore`),
  deletedChapters: (projectId: string) =>
    request(array(schema.deletedChapter), "GET", `/api/projects/${projectId}/trash`),
  restoreChapter: (id: string) => request(schema.chapterMeta, "POST", `/api/chapters/${id}/restore`),
  createChapter: (projectId: string, title: string) =>
    request(schema.chapterMeta, "POST", `/api/projects/${projectId}/chapters`, { title }),
  /** The whole book in order; with `acts`, also every act in order and each chapter's act. */
  reorder: (
    projectId: string,
    chapterIds: string[],
    acts?: { actIds: string[]; chapterActs: Record<string, string | null> },
  ) => request(schema.ok, "PUT", `/api/projects/${projectId}/order`, { chapterIds, ...acts }),
  /** A new act; from `startChapterId` to the end of that chapter's act, or empty at the end. */
  createAct: (projectId: string, title: string | undefined, startChapterId: string | null) =>
    request(schema.outline, "POST", `/api/projects/${projectId}/acts`, { title, startChapterId }),
  renameAct: (id: string, title: string) => request(schema.act, "PATCH", `/api/acts/${id}`, { title }),
  deleteAct: (id: string) => request(schema.outline, "DELETE", `/api/acts/${id}`),
  getChapter: (id: string) => request(schema.chapterWithContent, "GET", `/api/chapters/${id}`),
  /** `snapshot` asks the server to keep the text being replaced in history. */
  saveChapter: (
    id: string,
    content: string,
    baseVersion: number,
    opts: {
      keepalive?: boolean;
      snapshot?: "restore" | "conflict" | "replace";
      snapshotContent?: string;
      writtenAt?: number;
    } = {},
  ) =>
    request(
      schema.saveResult,
      "PUT",
      `/api/chapters/${id}`,
      // `day` credits the words to the local date they were written on.
      {
        content,
        baseVersion,
        snapshot: opts.snapshot,
        snapshotContent: opts.snapshotContent,
        day: localDay(opts.writtenAt),
      },
      { keepalive: opts.keepalive },
    ),
  updateChapter: (id: string, patch: { title?: string; synopsis?: string }) =>
    request(schema.chapterMeta, "PATCH", `/api/chapters/${id}`, patch),
  scenes: (projectId: string) => request(schema.sceneListing, "GET", `/api/projects/${projectId}/scenes`),
  createScene: (projectId: string, chapterId: string | null) =>
    request(schema.sceneMeta, "POST", `/api/projects/${projectId}/scenes`, { chapterId }),
  updateScene: (
    id: string,
    patch: Partial<Pick<SceneMeta, "title" | "summary" | "pov" | "location" | "status" | "chapter_id">> & {
      link?: { passage_index: number }; unlink?: true; confirm?: true;
    },
  ) => request(schema.sceneMeta, "PATCH", `/api/scenes/${id}`, patch),
  deleteScene: (id: string) => request(schema.ok, "DELETE", `/api/scenes/${id}`),
  reorderScenes: (projectId: string, chapterId: string | null, sceneIds: string[]) =>
    request(schema.ok, "PUT", `/api/projects/${projectId}/scenes/order`, { chapterId, sceneIds }),
  deleteChapter: (id: string) => request(schema.ok, "DELETE", `/api/chapters/${id}`),
  listHistory: (chapterId: string) => request(array(schema.snapshot), "GET", `/api/chapters/${chapterId}/history`),
  getSnapshot: (chapterId: string, snapshotId: string) =>
    request(schema.snapshotWithContent, "GET", `/api/chapters/${chapterId}/history/${snapshotId}`),
  claudeChanges: (projectId: string) =>
    request(array(schema.claudeChange), "GET", `/api/projects/${projectId}/claude-changes`),
  shareStatus: (projectId: string) => request(schema.shareStatus, "GET", `/api/projects/${projectId}/share`),
  createShare: (projectId: string) => request(schema.shareCreated, "POST", `/api/projects/${projectId}/share`),
  revokeShare: (projectId: string) => request(schema.ok, "DELETE", `/api/projects/${projectId}/share`),
  shareComments: (projectId: string) =>
    request(array(schema.shareComment), "GET", `/api/projects/${projectId}/share/comments`),
  deleteShareComment: (projectId: string, commentId: string) =>
    request(schema.ok, "DELETE", `/api/projects/${projectId}/share/comments/${commentId}`),
  getSharedProject: (token: string) =>
    request(schema.sharedProject, "GET", `/api/share/${encodeURIComponent(token)}`),
  getSharedChapter: (token: string, chapterId: string) =>
    request(
      schema.sharedChapter,
      "GET",
      `/api/share/${encodeURIComponent(token)}/chapters/${encodeURIComponent(chapterId)}`,
    ),
  postShareComment: (token: string, chapterId: string, displayName: string, comment: string) =>
    request(schema.ok, "POST", `/api/share/${encodeURIComponent(token)}/comments`, {
      chapterId,
      displayName,
      body: comment,
    }),
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
  if (!res.ok || !res.body) throw await errorFrom(res);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  // Each line is checked before onEvent sees it. A bad line ends the check
  // with an ApiError and stops reading the rest of the reply.
  const deliver = async (line: string) => {
    let event: BookCheckEvent;
    try {
      event = parse(res.status, line, schema.bookCheckEvent);
    } catch (e) {
      await reader.cancel().catch(() => {});
      throw e;
    }
    onEvent(event);
  };
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffered += value;
    let nl: number;
    while ((nl = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (line) await deliver(line);
    }
    if (done) break;
  }
  // The server ends every line with a newline, so anything left was cut off.
  if (buffered.trim()) await deliver(buffered.trim());
}
