// Reads that fall back to this device when the network is gone, and the queue
// that sends unsaved drafts to the server once it's back.

import { api, ApiError } from "./api";
import { cache, chapters, DraftStorageError, drafts, reopenStorage } from "./local";
import type { Draft } from "./local";
import type { BibleEntry, ChapterWithContent, ProjectDetail, ProjectSummary, SaveResult } from "../shared/types";

export interface Loaded<T> {
  data: T;
  /** True when this came from the device because the server couldn't be reached. */
  offline: boolean;
}

// ApiError means the server answered; anything else (TypeError from fetch,
// or an expired Access session redirecting) means we couldn't reach it.
export const isNetworkError = (e: unknown) => !(e instanceof ApiError);

async function withFallback<T>(fetcher: () => Promise<T>, remember: (v: T) => unknown, local: () => Promise<T | null>): Promise<Loaded<T>> {
  try {
    const data = await fetcher();
    void remember(data);
    return { data, offline: false };
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    const saved = await local();
    if (saved === null) throw e;
    return { data: saved, offline: true };
  }
}

export const loadShelf = (): Promise<Loaded<ProjectSummary[]>> =>
  withFallback(api.listProjects, cache.setShelf, cache.shelf);

export async function loadProject(id: string): Promise<Loaded<ProjectDetail>> {
  const res = await withFallback(() => api.getProject(id), cache.setProject, () => cache.project(id));
  if (!res.offline) {
    void addToShelf(res.data);
    void prefetchChapters(res.data);
  }
  return res;
}

// Keep the saved shelf in step with a novel opened since the shelf was last
// seen, so it's there to pick offline.
async function addToShelf(d: ProjectDetail) {
  const shelf = (await cache.shelf()) ?? [];
  const old = shelf.find((p) => p.id === d.project.id);
  const entry: ProjectSummary = {
    ...d.project,
    archived_at: old?.archived_at ?? null,
    chapter_count: d.chapters.length,
    word_count: d.chapters.reduce((n, c) => n + c.word_count, 0),
  };
  const rest = shelf.filter((p) => p.id !== d.project.id);
  await cache.setShelf([entry, ...rest].sort((a, b) => b.updated_at.localeCompare(a.updated_at)));
}

export const loadBible = (projectId: string): Promise<Loaded<BibleEntry[]>> =>
  withFallback(
    () => api.bible(projectId),
    (list) => cache.setBible(projectId, list),
    () => cache.bible(projectId),
  );

/**
 * A chapter's current text on this device: an unsaved draft first, then the
 * saved copy, then the server. Null if none of those can be had.
 */
export async function chapterText(id: string): Promise<string | null> {
  const draft = await drafts.read(id);
  if (draft) return draft.content;
  const known = await chapters.read(id);
  if (known) return known.content;
  try {
    return (await loadChapter(id)).data.content;
  } catch {
    return null;
  }
}

export const loadChapter = (id: string): Promise<Loaded<ChapterWithContent>> =>
  withFallback(() => api.getChapter(id), chapters.write, () => chapters.read(id));

/** Update this device's copy of a chapter after a successful save. */
export async function rememberSaved(chapterId: string, content: string, res: SaveResult) {
  const known = await chapters.read(chapterId);
  if (known) await chapters.write({ ...known, ...res, content });
}

// Download every chapter whose text this device doesn't have at the current
// version, so the whole novel opens offline. One at a time, in the background.
const prefetching = new Set<string>();
async function prefetchChapters(detail: ProjectDetail) {
  const projectId = detail.project.id;
  if (prefetching.has(projectId)) return;
  prefetching.add(projectId);
  try {
    const have = await chapters.versions();
    for (const c of detail.chapters) {
      if (have.get(c.id) === c.version) continue;
      try {
        await chapters.write(await api.getChapter(c.id));
      } catch (e) {
        if (isNetworkError(e)) return;
      }
    }
  } finally {
    prefetching.delete(projectId);
  }
}

// ---------- sync queue ----------

/** Chapters open in an editor right now; the editor saves those itself. */
export const openEditors = new Set<string>();

/**
 * How a sync pass ended:
 *   done           every draft that could be sent was (some may wait for the writer)
 *   offline        the server couldn't be reached; drafts stay queued
 *   storage-error  the drafts on this device couldn't be read, so nothing was sent
 *   busy           another pass was already running
 */
export type SyncOutcome = "done" | "offline" | "storage-error" | "busy";

let syncing = false;

// Whether the last sync pass couldn't read this device's drafts, for the
// notice that tells the writer (see SyncNotice). Clears on the next good read.
let draftsUnreadable = false;
const listeners = new Set<() => void>();

function setDraftsUnreadable(value: boolean) {
  if (draftsUnreadable === value) return;
  draftsUnreadable = value;
  for (const l of listeners) l();
}

export const draftReadProblem = {
  get: () => draftsUnreadable,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
};

/**
 * Send every draft left on this device (from chapters that aren't open) to the
 * server. A draft that conflicts with a newer save elsewhere is left alone:
 * opening that chapter shows the usual "which version" choice.
 */
export async function syncDrafts(): Promise<SyncOutcome> {
  if (syncing) return "busy";
  syncing = true;
  try {
    let queue: Draft[];
    try {
      // If storage failed to open earlier, try again rather than waiting for a reload.
      await reopenStorage();
      queue = await drafts.all();
    } catch (e) {
      // Not knowing what's queued is not the same as an empty queue.
      if (e instanceof DraftStorageError) {
        console.warn(e.message);
        setDraftsUnreadable(true);
        return "storage-error";
      }
      throw e;
    }
    setDraftsUnreadable(false);
    for (const d of queue) {
      if (openEditors.has(d.chapterId)) continue;
      try {
        const res = await api.saveChapter(d.chapterId, d.content, d.baseVersion, { writtenAt: d.savedAt });
        await drafts.clearIf(d.chapterId, d.content);
        await rememberSaved(d.chapterId, d.content, res);
      } catch (e) {
        if (isNetworkError(e)) return "offline"; // still offline; try again later
        // 409 (saved elsewhere), 404 (chapter deleted) and the like wait for the writer.
      }
    }
    return "done";
  } finally {
    syncing = false;
  }
}

export function startSync() {
  const kick = () => void syncDrafts();
  kick();
  window.addEventListener("online", kick);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") kick();
  });
  window.setInterval(kick, 60_000);
}
