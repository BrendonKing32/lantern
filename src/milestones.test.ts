import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChapterMeta } from "../shared/types";

const mocks = vi.hoisted(() => ({ project: vi.fn(), create: vi.fn(), flush: vi.fn() }));
vi.mock("./api", () => ({ api: { getProject: mocks.project, createMilestone: mocks.create } }));
vi.mock("./sceneArrangement", () => ({
  flushForSceneMove: mocks.flush,
  SceneMoveError: class SceneMoveError extends Error {},
}));
import { createMilestone } from "./milestones";

const chapters = [
  { id: "a", title: "First" },
  { id: "b", title: "Second" },
  { id: "c", title: "Third" },
] as ChapterMeta[];

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("navigator", { onLine: true });
  mocks.project.mockResolvedValue({ chapters });
});

describe("saving a milestone", () => {
  it("saves the open chapter and flushes every other chapter before creating", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    await createMilestone("p", "Draft", "note", { id: "b", save });
    expect(mocks.flush.mock.calls.map(([chapter]) => chapter.id)).toEqual(["a", "c"]);
    expect(save).toHaveBeenCalledOnce();
    expect(mocks.create).toHaveBeenCalledWith("p", "Draft", "note");
    expect(mocks.create).toHaveBeenCalledAfter(save);
    expect(mocks.create).toHaveBeenCalledAfter(mocks.flush);
  });

  it("names a chapter whose editor could not save and does not create", async () => {
    const save = vi.fn().mockRejectedValue(new Error("Resolve the conflict."));
    await expect(createMilestone("p", "Draft", "", { id: "b", save }))
      .rejects.toThrow("Save Second first: Resolve the conflict.");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.flush).toHaveBeenCalledTimes(1);
  });

  it("refuses offline creation before making a request", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    await expect(createMilestone("p", "Draft", "", null)).rejects.toThrow("needs a connection");
    expect(mocks.project).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
