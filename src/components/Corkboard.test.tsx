import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChapterMeta, SceneMeta } from "../../shared/types";
import { Corkboard } from "./Corkboard";

describe("corkboard scene strips", () => {
  it("shows at most six in-text scenes in passage order", () => {
    const chapter: ChapterMeta = {
      id: "c", project_id: "p", title: "Chapter", synopsis: "A synopsis", position: 0,
      word_count: 50, version: 1, updated_at: "", act_id: null, revision_status: "drafting",
    };
    const scenes: SceneMeta[] = Array.from({ length: 8 }, (_, i) => ({
      id: `s${i}`, project_id: "p", chapter_id: "c", title: `Scene ${i}`, summary: "", pov: "", location: "",
      status: "drafted" as const, position: i, in_text: true, word_count: i + 1, excerpt: "", passage_index: i,
      unconfirmed: false, unlinked_at: null, merged_into: null, created_at: "", updated_at: "",
    })).reverse();
    scenes.push({ ...scenes[0], id: "planned", title: "Planned", in_text: false, passage_index: null });
    const html = renderToStaticMarkup(<Corkboard
      chapters={[chapter]} acts={[]} scenes={scenes} wordsFor={(c) => c.word_count} selectedId={undefined}
      onOpen={() => {}} onReorder={() => {}} onSynopsis={() => {}} onAdd={() => {}} onStatus={() => {}}
    />);
    expect(html.indexOf("A synopsis")).toBeLessThan(html.indexOf("Scene 0"));
    expect(html.indexOf("Scene 0")).toBeLessThan(html.indexOf("Scene 5"));
    expect(html).toContain("1 word");
    expect(html).toContain("6 words");
    expect(html).toContain("+2 more");
    expect(html).not.toContain("Scene 6");
    expect(html).not.toContain("Planned");
  });
});
