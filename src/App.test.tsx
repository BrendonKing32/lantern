import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Route } from "./router";

const state = vi.hoisted(() => ({ route: {} as Route }));

vi.mock("./router", () => ({ useRoute: () => state.route }));
vi.mock("./components/Changelog", () => ({ Changelog: () => "Changelog" }));
vi.mock("./components/ProjectList", () => ({ ProjectList: () => "Shelf" }));
vi.mock("./components/ProjectView", () => ({ ProjectView: () => "Project" }));
vi.mock("./components/PublicShareView", () => ({ PublicShareView: () => "Shared project" }));
vi.mock("./components/SyncNotice", () => ({ SyncNotice: () => "Sync notice" }));

import { App } from "./App";

describe("app routing", () => {
  it("keeps the sync notice visible on the private changelog", () => {
    state.route = { changelog: true };
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain("Changelog");
    expect(html).toContain("Sync notice");
  });

  it("does not show the private sync notice on public shares", () => {
    state.route = { shareToken: "token" };
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain("Shared project");
    expect(html).not.toContain("Sync notice");
  });
});
