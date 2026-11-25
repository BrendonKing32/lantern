import { api, ApiError, describeError } from "./api";
import { chapters, draftToSave, drafts, reopenStorage } from "./local";
import { forgetChapter, openEditors, rememberSaved } from "./sync";
import type { ChapterMeta, ChapterWithContent, SaveResult } from "../shared/types";
import { failedDraft, waitForChapterActivity } from "./chapterActivity";

export class SceneMoveError extends Error {}

/** Save this device's draft before asking the server to move any passage. */
export async function flushForSceneMove(chapter: ChapterMeta): Promise<ChapterWithContent> {
  try {
    if (typeof navigator !== "undefined" && !navigator.onLine) throw new Error("Reconnect and try again.");
    if (openEditors.has(chapter.id)) throw new Error("This chapter is open in another window. Close it there and try again.");
    await waitForChapterActivity(chapter.id);
    await reopenStorage();
    let draft = await drafts.read(chapter.id);
    let current = await api.getChapter(chapter.id);
    const unsaved = failedDraft(chapter.id);
    if (unsaved !== undefined && unsaved !== current.content && unsaved !== draft?.content) {
      throw new Error("The latest draft wasn't saved on this device. Open the chapter and save it first.");
    }
    while (draft) {
      if (draft.baseVersion !== current.version && ((draft.revised ?? 0) > 0 || draft.snapshot)) {
        throw new Error("This chapter changed elsewhere. Open it and resolve the conflict.");
      }
      const sent = draftToSave(draft);
      if (draft.content !== current.content || (((draft.revised ?? 0) > 0 || draft.snapshot) && draft.baseVersion === current.version)) {
        try {
          const saved = await api.saveChapter(chapter.id, sent.content, sent.baseVersion, { writtenAt: sent.savedAt, revised: sent.revised ?? 0, ...(sent.snapshot ? { snapshot: sent.snapshot } : {}) });
          await rememberSaved(chapter.id, sent.content, saved);
          await drafts.acknowledge(sent, saved.version);
        } catch (e) {
          // An editor's final save or the sync queue may have saved this exact draft.
          if (!(e instanceof ApiError && e.status === 409)) throw e;
          current = await api.getChapter(chapter.id);
          if (current.content !== draft.content || (draft.revised ?? 0) > 0 || draft.snapshot) throw e;
          await drafts.acknowledge(draft, current.version);
        }
      }
      else {
        await drafts.acknowledge(draft, current.version);
      }
      const next = await drafts.read(chapter.id);
      if (next && (!sent.snapshot || next.generation !== sent.generation || next.baseVersion !== sent.baseVersion + 1)) {
        throw new Error("A newer draft is waiting to save. Try again.");
      }
      current = await api.getChapter(chapter.id);
      if (current.content !== sent.content) throw new Error("This chapter changed elsewhere. Open it and resolve the conflict.");
      draft = next;
    }
    return current;
  } catch (e) {
    const reason = e instanceof ApiError && e.status === 409
      ? "This chapter changed elsewhere. Open it and resolve the conflict."
      : e instanceof Error && !(e instanceof ApiError) && !(e instanceof TypeError)
        ? e.message
        : describeError(e);
    throw new SceneMoveError(`Save ${chapter.title} first: ${reason}`);
  }
}

/** Move using the current server version, then replace or discard the cached text. */
export async function arrangeChapterScenes(
  chapter: ChapterMeta,
  sceneIds: string[],
  expected?: { projectId: string; sceneIds: string[] },
): Promise<SaveResult> {
  const current = await flushForSceneMove(chapter);
  if (expected) {
    const listing = await api.scenes(expected.projectId);
    const order = listing.scenes.filter((scene) => scene.chapter_id === chapter.id)
      .sort((a, b) => a.position - b.position).map((scene) => scene.id);
    if (order.length !== expected.sceneIds.length || order.some((id, i) => id !== expected.sceneIds[i])) {
      throw new SceneMoveError("Scenes changed elsewhere. Reload the scene list and try again.");
    }
  }
  // Even an interrupted or unreadable response may have changed the server.
  await forgetChapter(chapter.id);
  let result: SaveResult;
  try {
    result = await api.arrangeScenes(chapter.id, current.version, sceneIds);
  } finally {
    await forgetChapter(chapter.id);
  }
  try {
    const fresh = await api.getChapter(chapter.id);
    if (fresh.version >= result.version) await chapters.restore(fresh);
  } catch {
    // The old text is already discarded; the next online open will fetch it.
  }
  return result;
}

/** Flush both drafts and discard both cached chapters even if the move response is lost. */
export async function moveSceneBetweenChapters(
  sceneId: string, from: ChapterMeta, to: ChapterMeta, beforePassageIndex: number | null,
  undo?: { projectId: string; destinationVersion: number },
) {
  const source = await flushForSceneMove(from);
  const destination = await flushForSceneMove(to);
  const listing = await api.scenes(undo?.projectId ?? from.project_id);
  const scene = listing.scenes.find((item) => item.id === sceneId);
  if (!scene?.in_text || scene.chapter_id !== from.id) {
    throw new SceneMoveError("This scene moved elsewhere. Reload the scene list and try again.");
  }
  if (undo && destination.version !== undo.destinationVersion) {
    throw new SceneMoveError(`The text in ${to.title} changed after the move. Use History to restore it instead.`);
  }
  if (!undo && beforePassageIndex !== null && destination.version !== to.version) {
    throw new SceneMoveError(`The text in ${to.title} changed. Reload the scene list and try again.`);
  }
  await Promise.all([forgetChapter(from.id), forgetChapter(to.id)]);
  let result: Awaited<ReturnType<typeof api.moveScene>>;
  try {
    result = await api.moveScene(sceneId, to.id, beforePassageIndex, {
      from: source.version, to: destination.version,
    }, from.id);
  } finally {
    await Promise.all([forgetChapter(from.id), forgetChapter(to.id)]);
  }
  await Promise.all([from, to].map(async (chapter) => {
    try {
      const fresh = await api.getChapter(chapter.id);
      const version = chapter.id === from.id ? result.from.version : result.to.version;
      if (fresh.version >= version) await chapters.restore(fresh);
    } catch {
      // The old text is already discarded; the next online open will fetch it.
    }
  }));
  return result;
}
