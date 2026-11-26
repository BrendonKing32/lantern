import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChangelogList } from "./Changelog";

describe("changelog list", () => {
  it("shows each merged PR's title, link, number, and merge date", () => {
    const mergedAt = "2026-11-21T18:00:00Z";
    const html = renderToStaticMarkup(<ChangelogList entries={[{
      number: 62,
      title: "Improve contrast",
      merged_at: mergedAt,
      url: "https://github.com/BrendonKing32/lantern/pull/62",
    }]} />);

    expect(html).toContain("Improve contrast");
    expect(html).toContain("PR #62");
    expect(html).toContain(`href="https://github.com/BrendonKing32/lantern/pull/62"`);
    expect(html).toContain(mergedAt);
    expect(html).toContain(new Date(mergedAt).toLocaleDateString(undefined, {
      month: "long", day: "numeric", year: "numeric",
    }));
  });

  it("explains an empty history", () => {
    expect(renderToStaticMarkup(<ChangelogList entries={[]} />)).toContain("No pull requests have been merged yet.");
  });
});
