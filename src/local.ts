// Everything Lantern keeps on this device, in IndexedDB:
//   drafts    unsaved writing, one per chapter, written on every keystroke
//   chapters  the last text and version seen from the server, for offline reading
//   cache     the shelf and each novel's chapter list, for offline browsing
// If IndexedDB is unavailable (some private windows), every call quietly does
// nothing and Lantern behaves as it does online-only.

import type { BibleEntry, ChapterWithContent, ProjectDetail, ProjectSummary } from "../shared/types";
import { draftWriteFailed, draftWriteSucceeded, trackChapterActivity } from "./chapterActivity";

export interface Draft {
  chapterId: string;
  content: string;
  /** The server version this draft was written on top of. */
  baseVersion: number;
  savedAt: number;
}

const DB_NAME = "lantern";
const DB_VERSION = 1;
const LEGACY_PREFIX = "lantern:draft:";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  const opening: Promise<IDBDatabase | null> = new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const settle = (db: IDBDatabase | null) => {
      // A request reported as blocked can still succeed later; don't keep that
      // stray connection open, since we've already given up on it.
      if (settled) return db?.close();
      settled = true;
      resolve(db);
    };
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("drafts", { keyPath: "chapterId" });
      db.createObjectStore("chapters", { keyPath: "id" });
      db.createObjectStore("cache");
    };
    req.onsuccess = () => {
      const db = req.result;
      // The browser can close the connection itself (storage cleared, disk
      // trouble). Open a fresh one next time rather than reusing a dead one.
      db.onclose = () => {
        if (dbPromise === opening) dbPromise = null;
      };
      settle(db);
    };
    req.onerror = () => settle(null);
    req.onblocked = () => settle(null);
  }).then(async (db) => {
    if (db) {
      try {
        await migrateLegacyDrafts(db);
      } catch {
        /* the old drafts stay in localStorage for next time */
      }
    }
    return db;
  });
  dbPromise = opening;
  return opening;
}

/**
 * Try opening this device's storage again if the last attempt failed, so a
 * failure (a blocked upgrade, a busy disk) doesn't last until the page reloads.
 * A working connection is left alone.
 */
export async function reopenStorage(): Promise<void> {
  const current = dbPromise;
  if (current && (await current) === null && dbPromise === current) dbPromise = null;
}

type StoreName = "drafts" | "chapters" | "cache";

export class DraftStorageError extends Error {
  constructor(message = "Lantern couldn't save this draft on this device.") {
    super(message);
    this.name = "DraftStorageError";
  }
}

// Readwrite transactions on the same store run in the order they're created,
// so a clear() issued after a write() always lands after it.
async function run<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

async function writeDraft(chapterId: string, content: string, baseVersion: number): Promise<void> {
  const db = await open();
  if (!db) throw new DraftStorageError();
  await new Promise<void>((resolve, reject) => {
    try {
      const tx = db.transaction("drafts", "readwrite");
      tx.objectStore("drafts").put({ chapterId, content, baseVersion, savedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(new DraftStorageError());
    } catch {
      reject(new DraftStorageError());
    }
  });
}

async function readDraft(chapterId: string): Promise<Draft | null> {
  const db = await open();
  if (!db) throw new DraftStorageError();
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction("drafts", "readonly");
      const request = tx.objectStore("drafts").get(chapterId);
      let draft: Draft | undefined;
      request.onsuccess = () => {
        draft = request.result as Draft | undefined;
      };
      tx.oncomplete = () => resolve(draft ?? null);
      tx.onerror = tx.onabort = () => reject(new DraftStorageError());
    } catch {
      reject(new DraftStorageError());
    }
  });
}

const READ_ALL_FAILED = "Lantern couldn't read the unsaved drafts on this device.";

/** Every draft on this device. Rejects with DraftStorageError if they can't be read, so a failure never looks like "no drafts". */
async function allDrafts(): Promise<Draft[]> {
  const db = await open();
  if (!db) throw new DraftStorageError(READ_ALL_FAILED);
  return new Promise((resolve, reject) => {
    try {
      const tx = db.transaction("drafts", "readonly");
      const request = tx.objectStore("drafts").getAll();
      let list: Draft[] | undefined;
      request.onsuccess = () => {
        list = request.result as Draft[];
      };
      tx.oncomplete = () => (list ? resolve(list) : reject(new DraftStorageError(READ_ALL_FAILED)));
      tx.onerror = tx.onabort = () => reject(new DraftStorageError(READ_ALL_FAILED));
    } catch {
      reject(new DraftStorageError(READ_ALL_FAILED));
    }
  });
}

// Milestone 1 kept drafts in localStorage. Move any that are still there.
async function migrateLegacyDrafts(db: IDBDatabase) {
  let legacy: Draft[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(LEGACY_PREFIX)) continue;
      const d = JSON.parse(localStorage.getItem(k) ?? "null");
      if (d && typeof d.content === "string") legacy.push({ ...d, chapterId: k.slice(LEGACY_PREFIX.length) });
    }
  } catch {
    legacy = [];
  }
  if (!legacy.length) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction("drafts", "readwrite");
    for (const d of legacy) tx.objectStore("drafts").put(d);
    tx.oncomplete = () => {
      try {
        for (const d of legacy) localStorage.removeItem(LEGACY_PREFIX + d.chapterId);
      } catch {
        /* ignore */
      }
      resolve();
    };
    tx.onerror = tx.onabort = () => resolve();
  });
}

export const drafts = {
  read: readDraft,
  all: allDrafts,
  write: (id: string, content: string, baseVersion: number) => trackChapterActivity(id, writeDraft(id, content, baseVersion).then(
    () => draftWriteSucceeded(id),
    (error) => { draftWriteFailed(id, content); throw error; },
  )),
  /** Remove the draft, but only if it still holds `content` (a newer keystroke wins). */
  clearIf: (chapterId: string, content: string) =>
    trackChapterActivity(chapterId, run("drafts", "readwrite", (s) => {
      const req = s.get(chapterId);
      req.onsuccess = () => {
        if (req.result && req.result.content === content) s.delete(chapterId);
      };
    })),
  clear: (chapterId: string) => run("drafts", "readwrite", (s) => s.delete(chapterId)),
};

// A moved chapter has no trustworthy cached text until it is fetched again.
const chapterFloors = new Map<string, number>();
export const chapters = {
  read: (id: string) =>
    run<ChapterWithContent | undefined>("chapters", "readonly", (s) => s.get(id)).then((c) => c ?? null),
  write: (chapter: ChapterWithContent) => run("chapters", "readwrite", (s) => {
    if (chapter.version < (chapterFloors.get(chapter.id) ?? 0)) return;
    const request = s.get(chapter.id);
    request.onsuccess = () => {
      if (chapter.version >= (chapterFloors.get(chapter.id) ?? 0) && (!request.result || request.result.version <= chapter.version)) s.put(chapter);
    };
  }),
  invalidate: (id: string) => {
    chapterFloors.set(id, Infinity);
    return run("chapters", "readwrite", (s) => s.delete(id));
  },
  restore: (chapter: ChapterWithContent) => {
    const floor = chapterFloors.get(chapter.id);
    if (floor !== undefined && floor !== Infinity && chapter.version < floor) return Promise.resolve(undefined);
    chapterFloors.set(chapter.id, chapter.version);
    return chapters.write(chapter);
  },
  /** Which chapters (id → version) are already stored, to skip re-downloading them. */
  versions: async () => {
    const all = (await run<ChapterWithContent[]>("chapters", "readonly", (s) => s.getAll())) ?? [];
    return new Map(all.map((c) => [c.id, c.version]));
  },
};

export const cache = {
  shelf: () => run<ProjectSummary[]>("cache", "readonly", (s) => s.get("shelf")).then((v) => v ?? null),
  setShelf: (list: ProjectSummary[]) => run("cache", "readwrite", (s) => s.put(list, "shelf")),
  project: (id: string) =>
    run<ProjectDetail>("cache", "readonly", (s) => s.get(`project:${id}`)).then((v) => v ?? null),
  setProject: (d: ProjectDetail) => run("cache", "readwrite", (s) => s.put(d, `project:${d.project.id}`)),
  lastChapter: (projectId: string) =>
    run<string>("cache", "readonly", (s) => s.get(`lastChapter:${projectId}`)).then((v) => typeof v === "string" ? v : null),
  setLastChapter: (projectId: string, chapterId: string) =>
    run("cache", "readwrite", (s) => s.put(chapterId, `lastChapter:${projectId}`)),
  bible: (projectId: string) =>
    run<BibleEntry[]>("cache", "readonly", (s) => s.get(`bible:${projectId}`)).then((v) => v ?? null),
  setBible: (projectId: string, list: BibleEntry[]) => run("cache", "readwrite", (s) => s.put(list, `bible:${projectId}`)),
};
