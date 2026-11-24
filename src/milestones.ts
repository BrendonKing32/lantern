import { api } from "./api";
import { flushForSceneMove, SceneMoveError } from "./sceneArrangement";
import type { ChapterMeta } from "../shared/types";

export async function saveMilestoneChapters(
  chapters: ChapterMeta[],
  active: { id: string; save: () => Promise<void> } | null,
): Promise<void> {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    throw new Error("Saving a milestone needs a connection. Reconnect and try again.");
  }
  for (const chapter of chapters) {
    if (chapter.id === active?.id) {
      try {
        await active.save();
      } catch (e) {
        throw new SceneMoveError(`Save ${chapter.title} first: ${e instanceof Error ? e.message : "Try again."}`);
      }
    } else {
      await flushForSceneMove(chapter);
    }
  }
}

export async function createMilestone(
  projectId: string, name: string, note: string,
  active: { id: string; save: () => Promise<void> } | null,
) {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    throw new Error("Saving a milestone needs a connection. Reconnect and try again.");
  }
  const project = await api.getProject(projectId);
  await saveMilestoneChapters(project.chapters, active);
  return api.createMilestone(projectId, name, note);
}
