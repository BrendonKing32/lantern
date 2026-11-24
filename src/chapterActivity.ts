// Track editor teardown and draft persistence even after the editor unmounts.
const pending = new Map<string, Set<Promise<unknown>>>();
const failedDrafts = new Map<string, string>();

export function trackChapterActivity<T>(id: string, operation: Promise<T>): Promise<T> {
  const tasks = pending.get(id) ?? new Set<Promise<unknown>>();
  pending.set(id, tasks);
  tasks.add(operation);
  void operation.then(
    () => { tasks.delete(operation); },
    () => { tasks.delete(operation); },
  );
  return operation;
}

export async function waitForChapterActivity(id: string): Promise<void> {
  do {
    await Promise.allSettled([...(pending.get(id) ?? [])]);
    // Let editor save callbacks enqueue their draft updates before checking again.
    await Promise.resolve();
  } while (pending.get(id)?.size);
}

export function draftWriteFailed(id: string, content: string) { failedDrafts.set(id, content); }
export function draftWriteSucceeded(id: string) { failedDrafts.delete(id); }
export function failedDraft(id: string) { return failedDrafts.get(id); }
