import { api, ApiError } from "./api";

export const shareTokenKey = (id: string) => `lantern:share:${id}`;

export async function migrateShareToken(storage: Storage, projectId: string, linkIds: string[]): Promise<"done" | "deferred"> {
  const oldKey = shareTokenKey(projectId);
  const token = storage.getItem(oldKey);
  if (token && linkIds.length === 1 && shareTokenKey(linkIds[0]) !== oldKey && !storage.getItem(shareTokenKey(linkIds[0]))) {
    try {
      await api.getSharedProject(token);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) return "deferred";
      if (storage.getItem(oldKey) === token) storage.removeItem(oldKey);
      return "done";
    }
    if (storage.getItem(oldKey) !== token) return "deferred";
    if (!storage.getItem(shareTokenKey(linkIds[0]))) storage.setItem(shareTokenKey(linkIds[0]), token);
  }
  if (!linkIds.includes(projectId) && storage.getItem(oldKey) === token) storage.removeItem(oldKey);
  return "done";
}
