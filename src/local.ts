// Everything Lantern keeps on this device, in IndexedDB:
//   drafts    unsaved writing, one per chapter, written on every keystroke
//   chapters  the last text and version seen from the server, for offline reading
//   cache     the shelf and each novel's chapter list, for offline browsing
// If IndexedDB is unavailable (some private windows), every call quietly does
// nothing and Lantern behaves as it does online-only.

import type { BibleEntry, ChapterWithContent, ProjectDetail, ProjectSummary } from "../shared/types";

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
  dbPromise ??= new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("drafts", { keyPath: "chapterId" });
      db.createObjectStore("chapters", { keyPath: "id" });
      db.createObjectStore("cache");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  }).then(async (db) => {
    if (db) await migrateLegacyDrafts(db);
    return db;
  });
  return dbPromise;
}

type StoreName = "drafts" | "chapters" | "cache";

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
  read: (chapterId: string) =>
    run<Draft | undefined>("drafts", "readonly", (s) => s.get(chapterId)).then((d) => d ?? null),
  all: () => run<Draft[]>("drafts", "readonly", (s) => s.getAll()).then((d) => d ?? []),
  write: (chapterId: string, content: string, baseVersion: number) =>
    run("drafts", "readwrite", (s) => s.put({ chapterId, content, baseVersion, savedAt: Date.now() })),
  /** Remove the draft, but only if it still holds `content` (a newer keystroke wins). */
  clearIf: (chapterId: string, content: string) =>
    run("drafts", "readwrite", (s) => {
      const req = s.get(chapterId);
      req.onsuccess = () => {
        if (req.result && req.result.content === content) s.delete(chapterId);
      };
    }),
  clear: (chapterId: string) => run("drafts", "readwrite", (s) => s.delete(chapterId)),
};

export const chapters = {
  read: (id: string) =>
    run<ChapterWithContent | undefined>("chapters", "readonly", (s) => s.get(id)).then((c) => c ?? null),
  write: (chapter: ChapterWithContent) => run("chapters", "readwrite", (s) => s.put(chapter)),
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
  bible: (projectId: string) =>
    run<BibleEntry[]>("cache", "readonly", (s) => s.get(`bible:${projectId}`)).then((v) => v ?? null),
  setBible: (projectId: string, list: BibleEntry[]) => run("cache", "readwrite", (s) => s.put(list, `bible:${projectId}`)),
};
