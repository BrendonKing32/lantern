import { useEffect, useState, type FormEvent } from "react";
import { api, describeError } from "../api";
import { localDay } from "../when";
import type { Stats } from "../../shared/types";

const WEEKS = 12;

/** Today's words, the daily goal, the streak and a 12-week calendar, for the shelf. */
export function TodayPanel() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Stats need the server; offline the panel simply doesn't appear.
    api.stats().then(setStats).catch(() => {});
  }, []);

  if (!stats) return null;

  const goal = stats.daily_goal;
  const today = Math.max(0, stats.today);
  const done = goal !== null && today >= goal;
  const streakDone = done || (goal !== null && stats.streak_counts_revision && stats.revised_today >= goal);

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const raw = new FormData(e.currentTarget).get("goal")?.toString().replace(/[^\d]/g, "") ?? "";
    const n = raw ? Number(raw) : null;
    try {
      await api.setGoal(n && n > 0 ? n : null);
      setStats(await api.stats());
      setEditing(false);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  };

  return (
    <section className="today" aria-label="Today's writing">
      <div className="today-top">
        <div>
          <p className="today-words">
            <strong>{today.toLocaleString()}</strong>
            {goal !== null ? ` of ${goal.toLocaleString()} words today` : ` ${today === 1 ? "word" : "words"} today`}
          </p>
          {stats.revised_today > 0 && <p>{stats.revised_today.toLocaleString()} words revised today</p>}
          <p className="today-streak">
            {stats.streak > 0
              ? `${stats.streak}-day streak${streakDone || goal === null ? "" : ". Reach today's goal to keep it going"}`
              : goal !== null
                ? "Meet today's goal to start a streak"
                : "Write today to start a streak"}
            {stats.best_streak > stats.streak && ` · best ${stats.best_streak}`}
          </p>
        </div>
        {!editing && (
          <button className="btn btn-quiet" onClick={() => setEditing(true)}>
            {goal === null ? "Set a daily goal" : "Change goal"}
          </button>
        )}
      </div>

      <label>
        <input type="checkbox" checked={stats.streak_counts_revision} onChange={(e) => {
          const enabled = e.currentTarget.checked;
          void api.setStreakRevision(enabled).then(() => api.stats()).then((value) => { setStats(value); setError(null); }).catch((err) => setError(describeError(err)));
        }} /> Count revising toward my streak
      </label>
      {error && !editing && <p className="shelf-error" role="alert">{error}</p>}

      {goal !== null && (
        <div
          className={`meter${done ? " is-done" : ""}`}
          role="progressbar"
          aria-label="Today's goal"
          aria-valuemin={0}
          aria-valuemax={goal}
          aria-valuenow={Math.min(today, goal)}
        >
          <span style={{ width: `${Math.min(100, (today / goal) * 100)}%` }} />
        </div>
      )}

      {editing && (
        <form className="goal-form" onSubmit={save}>
          <label htmlFor="goal">Words a day</label>
          <input id="goal" name="goal" inputMode="numeric" defaultValue={goal ?? ""} placeholder="e.g. 500" autoFocus />
          <button className="btn btn-lamp" type="submit">Save</button>
          <button className="btn btn-quiet" type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
          <p className="goal-hint">Leave it empty for no goal; then any writing keeps the streak.</p>
          {error && <p className="shelf-error" role="alert">{error}</p>}
        </form>
      )}

      <Calendar stats={stats} />
    </section>
  );
}

export function Calendar({ stats }: { stats: Stats }) {
  const [selectedDay, setSelectedDay] = useState(() => localDay());
  const words = new Map(stats.days.map((d) => [d.day, d.words]));
  const goal = stats.daily_goal;
  const peak = Math.max(1, ...stats.days.map((d) => d.words));
  const now = new Date();
  // Columns are weeks ending with this one; rows run Sunday to Saturday.
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay() - (WEEKS - 1) * 7);
  const firstDay = localDay(start);
  const today = localDay(now);
  const dateOptions: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };

  const cells = [];
  let selectedLabel = "";
  for (let i = 0; i < WEEKS * 7; i++) {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const day = localDay(date);
    const future = day > today;
    const w = words.get(day) ?? 0;
    // Shade by share of the goal, or of the busiest day when there's no goal.
    const level = w <= 0 ? 0 : Math.min(4, Math.ceil((w / (goal ?? peak)) * 4));
    const label = `${date.toLocaleDateString(undefined, { weekday: "short", ...dateOptions })}: ${w.toLocaleString()} ${w === 1 ? "word" : "words"}`;
    if (!future && day === selectedDay) selectedLabel = label;
    cells.push(
      <span
        key={day}
        className={`cal-day lv${level}${future ? " is-future" : ""}${day === today ? " is-today" : ""}`}
        title={future ? undefined : label}
        aria-label={future ? undefined : label}
        role={future ? undefined : "img"}
      />,
    );
  }
  return (
    <div className="calendar-section">
      <p className="calendar-range">Writing activity: {start.toLocaleDateString(undefined, dateOptions)} – {now.toLocaleDateString(undefined, dateOptions)}</p>
      <div className="calendar" aria-label="Writing activity over the last 12 weeks">
        {cells}
      </div>
      <div className="calendar-legend">
        <span>Less</span>
        <span className="cal-day lv0" aria-hidden="true" />
        <span className="cal-day lv1" aria-hidden="true" />
        <span className="cal-day lv2" aria-hidden="true" />
        <span className="cal-day lv3" aria-hidden="true" />
        <span className="cal-day lv4" aria-hidden="true" />
        <span>More</span>
      </div>
      <p className="calendar-hint">Darker means more net words, in quarters of {goal === null ? "the busiest day's count" : "the daily goal"}; the darkest shade means 100% or more. The lightest shade means zero or fewer net words.</p>
      <div className="calendar-inspect">
        <label htmlFor="calendar-date">Inspect a date</label>
        <input id="calendar-date" type="date" min={firstDay} max={today} value={selectedDay} onChange={(e) => setSelectedDay(e.currentTarget.value)} />
        <output aria-live="polite">{selectedLabel || "Choose a date in the range."}</output>
      </div>
    </div>
  );
}
