import { describe, expect, it } from "vitest";
import { parseRoute } from "./router";

describe("changelog routing", () => {
  it("opens the changelog by hash without changing project routes", () => {
    expect(parseRoute("/", "#/changelog")).toEqual({ changelog: true });
    expect(parseRoute("/", "#/changelog/")).toEqual({ changelog: true });
    expect(parseRoute("/", "#/p/project-1/chapter-1")).toEqual({
      projectId: "project-1",
      chapterId: "chapter-1",
    });
  });

  it("keeps a public share route ahead of the changelog hash", () => {
    expect(parseRoute("/share/example%20token", "#/changelog")).toEqual({ shareToken: "example token" });
  });
});
