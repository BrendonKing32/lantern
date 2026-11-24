import { strFromU8, unzipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChapterMeta, ProjectDetail } from "../../shared/types";
import { findBookMatches } from "../search";
import { exportBook } from "./index";

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
    await exportBook(detail, "md", "");
    expect(exported).toBeDefined();
    const files = unzipSync(new Uint8Array(await exported!.arrayBuffer()));
    expect(Object.values(files).some((file) => strFromU8(file).includes(manuscript))).toBe(true);
    for (const file of Object.values(files)) expect(strFromU8(file)).not.toContain(privateNote);
    expect(findBookMatches([chapter], new Map([["c", manuscript]]), privateNote)).toEqual([]);
  });
});
