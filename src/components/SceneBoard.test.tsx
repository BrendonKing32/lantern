import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChapterMeta, SceneMeta, ScenePlaceholder } from "../../shared/types";
import { SceneBoard } from "./SceneBoard";

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

  it("shows chapters with unconfirmed cards until dismissed or confirmed", () => {
    const unconfirmed = { ...card, in_text: true, unconfirmed: true, passage_index: 0 };
    const html = render([unconfirmed]);
    expect(html).toContain("Check how your scene cards line up with the text.");
    expect(html).toContain("Chapter one");
    expect(render([unconfirmed], true)).not.toContain("Check how your scene cards line up with the text.");
    expect(render([{ ...unconfirmed, unconfirmed: false }])).not.toContain("Check how your scene cards line up with the text.");
  });
});
