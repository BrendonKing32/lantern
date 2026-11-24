import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pointerWithin } from "@dnd-kit/core";
import type { ChapterMeta, SceneMeta, ScenePlaceholder } from "../../shared/types";
import { SceneBoard, sceneDragOrder, sceneDrop } from "./SceneBoard";
import { api, INVALID_RESPONSE } from "../api";

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
    onAdd={async () => null} onUpdate={async () => {}} onDelete={() => {}} onMove={() => {}} onMoveAcross={() => {}} onOpen={() => {}}
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

    it("resolves chapter, placeholder, planned card and Unassigned targets", () => {
      const source = { ...card, id: "source", in_text: true, passage_index: 0 };
      const planned = { ...card, id: "planned", chapter_id: "d", position: 0 };
      const destination = { ...card, id: "dest", chapter_id: "d", position: 1, in_text: true, passage_index: 2 };
      const gap = { ...placeholder, chapter_id: "d", passage_index: 1 };
      const scenes = [source, planned, destination];
      const drop = (id: string) => sceneDrop(scenes, [gap], ["c", "d", "empty"], "source", id);
      expect(drop("scene-group:")).toEqual({ kind: "unassigned" });
      expect(drop("scene-group:empty")).toMatchObject({ kind: "across", chapterId: "empty", beforePassageIndex: null });
      expect(drop("scene-group:d")).toMatchObject({ kind: "across", beforePassageIndex: null });
      expect(drop("scene-placeholder:d:1")).toMatchObject({ kind: "across", beforePassageIndex: 1 });
      expect(drop("planned")).toMatchObject({ kind: "across", beforePassageIndex: 1 });
      expect(drop("dest")).toMatchObject({ kind: "across", beforePassageIndex: 2 });
      expect(sceneDrop(scenes, [gap], ["c", "d"], "planned", "source")).toBeNull();
      expect(drop("outside")).toBeNull();
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

  describe("move API validation", () => {
    it("sends passage index and versions and rejects malformed responses", async () => {
      const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
        from: { version: 3, word_count: 2 }, to: { version: 4, word_count: 5 },
        scene: card, from_passage_index: 1,
      }))).mockResolvedValueOnce(new Response(JSON.stringify({
        from: { version: 3, word_count: 2 }, to: { version: 4, word_count: 5 }, scene: card, from_passage_index: -1,
      })));
      vi.stubGlobal("fetch", fetch);
      await expect(api.moveScene("s", "d", 0, { from: 2, to: 3 }, "c")).resolves.toMatchObject({ from_passage_index: 1 });
      expect(fetch.mock.calls[0][0]).toBe("/api/scenes/s/move");
      expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ toChapterId: "d", beforePassageIndex: 0, baseVersions: { from: 2, to: 3 }, expectedFromChapterId: "c" });
      await expect(api.moveScene("s", "d", null, { from: 2, to: 3 })).rejects.toMatchObject({ data: { code: INVALID_RESPONSE } });
    });
  });
});
