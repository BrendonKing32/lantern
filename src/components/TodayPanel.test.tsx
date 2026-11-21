import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Stats } from "../../shared/types";
import { Calendar } from "./TodayPanel";

const stats: Stats = {
  daily_goal: 100,
  today: 50,
  streak: 0,
  best_streak: 0,
  days: [
    { day: "2025-12-31", words: 1 },
    { day: "2026-01-01", words: 50 },
  ],
};

afterEach(() => vi.useRealTimers());

describe("writing activity calendar", () => {
  it("shows its date range, goal-based legend, and today's details", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12));
    const html = renderToStaticMarkup(<Calendar stats={stats} />);

    expect(html).toContain("Writing activity: Oct 12, 2025 – Jan 1, 2026");
    expect(html).toContain("in quarters of the daily goal");
    expect(html).toContain('type="date" min="2025-10-12" max="2026-01-01" value="2026-01-01"');
    expect(html).toContain("Thu, Jan 1, 2026: 50 words");
    expect(html).toContain("Wed, Dec 31, 2025: 1 word");
    expect(html).toContain('class="cal-day lv2 is-today"');
    expect(html).toContain('class="cal-day lv0 is-future"');
  });

  it("explains the busiest-day scale when there is no goal", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12));
    const html = renderToStaticMarkup(<Calendar stats={{ ...stats, daily_goal: null }} />);

    expect(html).toContain("in quarters of the busiest day&#x27;s count");
    expect(html).toContain("The lightest shade means no words.");
    expect(html).toContain('class="cal-day lv4 is-today"');
    expect(html).toContain('aria-live="polite"');
  });
});
