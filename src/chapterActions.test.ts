import { describe, expect, it } from "vitest";
import {
  closeOtherChapterActions,
  shouldCloseChapterActions,
} from "./chapterActions";

describe("chapter action disclosures", () => {
  it("closes another open disclosure", () => {
    const opened = { open: true } as HTMLDetailsElement;
    const current = { open: true } as HTMLDetailsElement;

    closeOtherChapterActions(opened, current);

    expect(current.open).toBe(false);
  });

  it("does not close a disclosure when interacting with it", () => {
    const target = {} as Node;
    const actions = {
      open: true,
      contains: (candidate: Node) => candidate === target,
    } as unknown as HTMLDetailsElement;

    expect(shouldCloseChapterActions(actions, target)).toBe(false);
  });

  it("closes an open disclosure when interacting outside it", () => {
    const target = {} as Node;
    const actions = {
      open: true,
      contains: () => false,
    } as unknown as HTMLDetailsElement;

    expect(shouldCloseChapterActions(actions, target)).toBe(true);
  });
});
