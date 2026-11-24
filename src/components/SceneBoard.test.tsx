import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pointerWithin } from "@dnd-kit/core";
import type { ChapterMeta, SceneMeta, ScenePlaceholder } from "../../shared/types";
import { SceneBoard, sceneDragOrder } from "./SceneBoard";

const chapter: ChapterMeta = {
  id: "c", project_id: "p", title: "Chapter one", synopsis: "", position: 0,
  word_count: 3, version: 1, updated_at: "", act_id: null,
};
const card: SceneMeta = {
  id: "s", project_id: "p", chapter_id: "c", title: "Planned scene", summary: "", pov: "", location: "",
  status: "planned", position: 0, in_text: false, word_count: 0, excerpt: "", passage_index: null,
  unconfirmed: false, unlinked_at: null, merged_into: null, created_at: "", updated_at: "",
};
const placeholder: ScenePlaceholder = { chapter_id: "c", passage_index: 0, words: 3, excerpt: "Some passage text" };
const render = (scenes: SceneMeta[], dismissed = false) => {
  vi.stubGlobal("localStorage", { getItem: () => dismissed ? "1" : null });
  return renderToStaticMarkup(<SceneBoard
    chapters={[chapter]} acts={[]} scenes={scenes} placeholders={[placeholder]} projectId="p" offline={false}
    onAdd={async () => null} onUpdate={async () => {}} onDelete={() => {}} onMove={() => {}} onOpen={() => {}}
  />);
};
afterEach(() => vi.unstubAllGlobals());

describe("scene pairing banner", () => {
  it("does not show for planned cards and placeholders alone", () => {
    const html = render([card]);
    expect(html).not.toContain("Check how your scene cards line up with the text.");
    expect(html).toContain("This is…");
  });

  describe("scene dragging", () => {
    it("only reorders an in-text card over another card in its own group", () => {
      const first = { ...card, id: "first", in_text: true, passage_index: 0 };
      const second = { ...card, id: "second", position: 1 };
      expect(sceneDragOrder([first, second], "first", "second")).toEqual(["second", "first"]);
      expect(sceneDragOrder([first, second], "first", null)).toBeNull();
      expect(sceneDragOrder([first, second], "first", "other-chapter")).toBeNull();
      expect(sceneDragOrder([first, second], "second", "first")).toBeNull();
    });

    it("does not snap an outside drop back to a source card", () => {
      const rect = { left: 0, right: 100, top: 0, bottom: 100, width: 100, height: 100 };
      const container = { id: "source", data: { current: {} }, disabled: false, node: { current: null }, rect: { current: rect } };
      const args = { pointerCoordinates: { x: 200, y: 200 }, droppableRects: new Map([["source", rect]]), droppableContainers: [container] };
      expect(pointerWithin(args as unknown as Parameters<typeof pointerWithin>[0])).toEqual([]);
    });
  });

  it("shows chapters with unconfirmed cards until dismissed or confirmed", () => {
    const unconfirmed = { ...card, in_text: true, unconfirmed: true, passage_index: 0 };
    const html = render([unconfirmed]);
    expect(html).toContain("Check how your scene cards line up with the text.");
    expect(html).toContain("Chapter one");
    expect(render([unconfirmed], true)).not.toContain("Check how your scene cards line up with the text.");
    expect(render([{ ...unconfirmed, unconfirmed: false }])).not.toContain("Check how your scene cards line up with the text.");
  });
});
