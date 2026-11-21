import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const problem = vi.hoisted(() => ({ unreadable: false }));

vi.mock("../sync", () => ({
  draftReadProblem: { get: () => problem.unreadable, subscribe: () => () => undefined },
  syncDrafts: vi.fn(),
}));

import { SyncNotice } from "./SyncNotice";

describe("sync notice", () => {
  it("stays hidden while drafts can be read", () => {
    problem.unreadable = false;
    expect(renderToStaticMarkup(<SyncNotice />)).toBe("");
  });

  it("tells the writer when drafts on this device can't be read", () => {
    problem.unreadable = true;
    const html = renderToStaticMarkup(<SyncNotice />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("can&#x27;t read the unsaved drafts on this device");
    expect(html).toContain("Try again");
  });
});
