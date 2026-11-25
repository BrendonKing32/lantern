import { strFromU8, unzipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChapterMeta, Milestone, ProjectDetail } from "../../shared/types";
import { api } from "../api";
import { findBookMatches } from "../search";
import { chapterTexts, exportBook, milestoneTexts } from "./index";

const manuscript = "A lantern glows.";
const privateNote = "Private reminder to revise";
vi.mock("../local", () => ({ drafts: { read: async () => null } }));
vi.mock("../sync", () => ({
  loadChapter: async () => ({ data: { content: manuscript }, offline: false }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("margin note privacy in exports", () => {
  it("exports and searches only chapter text", async () => {
    let exported: Blob | undefined;
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      exported = blob as Blob;
      return "blob:test";
    });
    vi.stubGlobal("document", {
      createElement: () => ({ click() {}, remove() {} }),
      body: { append() {} },
    });
    vi.stubGlobal("window", { setTimeout() {} });
    const chapter = { id: "c", title: "Chapter", act_id: null } as ChapterMeta;
    const detail: ProjectDetail = {
      project: { id: "p", title: "Book", created_at: "", updated_at: "", target_words: null, target_date: null, dialect: "american" },
      chapters: [chapter], acts: [],
    };
    await exportBook(detail, "md", "", await chapterTexts(detail));
    expect(exported).toBeDefined();
    const files = unzipSync(new Uint8Array(await exported!.arrayBuffer()));
    expect(Object.values(files).some((file) => strFromU8(file).includes(manuscript))).toBe(true);
    for (const file of Object.values(files)) expect(strFromU8(file)).not.toContain(privateNote);
    expect(findBookMatches([chapter], new Map([["c", manuscript]]), privateNote)).toEqual([]);
  });

  it("uses the same export for milestone and live chapter texts", async () => {
    const outputs: Blob[] = [];
    const filenames: string[] = [];
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
      outputs.push(blob as Blob);
      return "blob:test";
    });
    vi.stubGlobal("document", {
      createElement: () => ({ download: "", click() { filenames.push(this.download); }, remove() {} }),
      body: { append() {} },
    });
    vi.stubGlobal("window", { setTimeout() {} });
    const chapter = { id: "c", title: "Chapter", act_id: null } as ChapterMeta;
    const detail: ProjectDetail = {
      project: { id: "p", title: "Book", created_at: "", updated_at: "", target_words: null, target_date: null, dialect: "american" },
      chapters: [chapter], acts: [],
    };
    const milestone = { id: "m", name: "Draft 1" } as Milestone;
    const row = { milestone_id: "m", chapter_id: "c", position: 0, title: "Chapter", act_title: null, version: 1, word_count: 3 };
    vi.spyOn(api, "milestoneChapters").mockResolvedValue([row]);
    vi.spyOn(api, "milestoneChapter").mockResolvedValue({ ...row, content: manuscript });
    const live = await chapterTexts(detail);
    const copied = await milestoneTexts(milestone);
    expect(copied).toEqual(live);
    await exportBook(detail, "md", "", live);
    await exportBook(detail, "md", "", copied, milestone.name);
    const unpack = async (blob: Blob) => Object.fromEntries(
      Object.entries(unzipSync(new Uint8Array(await blob.arrayBuffer()))).map(([name, bytes]) => [name, strFromU8(bytes)]),
    );
    expect(await unpack(outputs[1])).toEqual(await unpack(outputs[0]));
    expect(filenames).toEqual(["Book.zip", "Book – Draft 1.zip"]);
  });
});
