import { describe, expect, it } from "vitest";
import { compareHistory } from "./historyDiff";

describe("History comparison", () => {
  it("shows what's removed from the snapshot and added in the draft", () => {
    expect(compareHistory("Opening\nOld middle\nEnding\n", "Opening\nNew middle\nEnding\n")).toEqual({
      kind: "changes",
      rows: [
        { kind: "unchanged", count: 1 },
        { kind: "removed", text: "Old middle" },
        { kind: "added", text: "New middle" },
        { kind: "unchanged", count: 1 },
      ],
      truncated: false,
    });
  });

  it("distinguishes identical drafts from an empty draft", () => {
    expect(compareHistory("One line\n", "One line\n")).toEqual({ kind: "identical" });
    expect(compareHistory("One line\n", "")).toEqual({
      kind: "changes",
      rows: [{ kind: "removed", text: "One line" }],
      truncated: false,
    });
  });

  it("limits both the number of rendered lines and the length of a single line", () => {
    const manyLines = compareHistory("", "An added line\n".repeat(301));
    expect(manyLines).toMatchObject({ kind: "changes", truncated: true });
    if (manyLines.kind === "changes") expect(manyLines.rows).toHaveLength(300);

    const longLine = compareHistory("", "a".repeat(60_001));
    expect(longLine).toEqual({
      kind: "changes",
      rows: [{ kind: "added", text: "a".repeat(60_000) + "…" }],
      truncated: true,
    });
  });

  it("declines a comparison above the edit limit", () => {
    expect(compareHistory("", "An added line\n".repeat(4_001))).toEqual({ kind: "too-large" });
  });
});
