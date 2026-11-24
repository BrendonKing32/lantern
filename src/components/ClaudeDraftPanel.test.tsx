import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ClaudeDraft } from "../../shared/types";
import { ClaudeDraftPanel } from "./ClaudeDraftPanel";

const draft: ClaudeDraft = {
  chapter_id: "c", version: 1, base_version: 0, word_count: 2,
  created_at: "2026-01-01", updated_at: "2026-01-01", content: "new text",
  ops: [
    { kind: "replace", old_text: "old", new_text: "new" },
    { kind: "replace", old_text: "gone", new_text: "found" },
  ],
};

function render(chapterText: string, chapterChanged: boolean, blockedBy: string | null = null) {
  return renderToStaticMarkup(<ClaudeDraftPanel
    title="Chapter" draft={draft} chapterText={chapterText} chapterChanged={chapterChanged}
    blockedBy={blockedBy} busy={false} error={null} onAccept={() => {}} onDiscard={() => {}} onClose={() => {}}
  />);
}

describe("Claude's draft review", () => {
  it("shows failed quotes and the number of applicable edits", () => {
    const html = render("old text and later writing", true);
    expect(html).toContain("since Claude started this draft");
    expect(html).toContain("No longer in the chapter");
    expect(html).toContain("<q>gone</q>");
    expect(html).toContain("Accept 1 of 2 edits");
  });

  it("only offers discard when nothing applies", () => {
    const html = render("unrelated writing", true);
    expect(html).toContain("None of Claude&#x27;s edits fit");
    expect(html).toContain("Discard draft");
    expect(html).not.toContain("Accept 0 of 2 edits");
  });

  it("disables acceptance until writing is saved", () => {
    const html = render("old text", false, "Your latest writing must be saved before accepting.");
    expect(html).toContain("disabled=\"\"");
    expect(html).toContain("must be saved before accepting");
  });
});
