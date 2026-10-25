// Every keystroke lands here first, so a dropped connection or a closed tab
// never costs words. Milestone 2 moves this to IndexedDB with full sync.

export interface Draft {
  content: string;
  baseVersion: number;
  savedAt: number;
}

const key = (chapterId: string) => `lantern:draft:${chapterId}`;

export const drafts = {
  read(chapterId: string): Draft | null {
    try {
      const raw = localStorage.getItem(key(chapterId));
      return raw ? (JSON.parse(raw) as Draft) : null;
    } catch {
      return null;
    }
  },
  write(chapterId: string, content: string, baseVersion: number) {
    try {
      localStorage.setItem(key(chapterId), JSON.stringify({ content, baseVersion, savedAt: Date.now() }));
    } catch {
      /* storage full or blocked: the server save still runs */
    }
  },
  clear(chapterId: string) {
    try {
      localStorage.removeItem(key(chapterId));
    } catch {
      /* ignore */
    }
  },
};
