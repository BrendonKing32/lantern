import type { Stats } from "../../shared/types";
import type { Env } from "../env";
import { body, HttpError, isDay, json, now, type Handler } from "../http";

const DAY_MS = 86_400_000;
const shiftDay = (day: string, by: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + by * DAY_MS).toISOString().slice(0, 10);

async function dailyGoal(env: Env): Promise<number | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'daily_goal'").first<{ value: string }>();
  const n = row ? Number(row.value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

export const getStats: Handler = async (req, env) => {
  const q = new URL(req.url).searchParams.get("today");
  const today = isDay(q) ? q : now().slice(0, 10);
  const goal = await dailyGoal(env);
  // A year back is plenty for the streak; the calendar shows the last 12 weeks.
  const { results } = await env.DB.prepare(
    `SELECT day, SUM(words) AS words FROM daily_words
      WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day`,
  )
    .bind(shiftDay(today, -400), today)
    .all<{ day: string; words: number }>();
  const byDay = new Map(results.map((r) => [r.day, r.words]));
  const met = (d: string) => (byDay.get(d) ?? 0) >= (goal ?? 1);

  // Today only adds to the streak once it's met; until then it can't break it.
  let streak = 0;
  for (let d = met(today) ? today : shiftDay(today, -1); met(d); d = shiftDay(d, -1)) streak++;

  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const r of results) {
    if (r.words < (goal ?? 1)) {
      run = 0;
    } else {
      run = prev !== null && shiftDay(prev, 1) === r.day && run > 0 ? run + 1 : 1;
      best = Math.max(best, run);
    }
    prev = r.day;
  }

  const since = shiftDay(today, -83);
  const stats: Stats = {
    daily_goal: goal,
    today: byDay.get(today) ?? 0,
    streak,
    best_streak: Math.max(best, streak),
    days: results.filter((r) => r.day >= since && r.words !== 0),
  };
  return json(stats);
};

export const setGoal: Handler = async (req, env) => {
  const b = await body<{ daily_goal?: unknown }>(req);
  const goal = b.daily_goal ?? null;
  if (goal !== null && !(Number.isInteger(goal) && (goal as number) > 0 && (goal as number) <= 1_000_000)) {
    throw new HttpError(400, "daily_goal must be a whole number above zero");
  }
  if (goal === null) {
    await env.DB.prepare("DELETE FROM settings WHERE key = 'daily_goal'").run();
  } else {
    await env.DB.prepare(
      "INSERT INTO settings (key, value) VALUES ('daily_goal', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
      .bind(String(goal))
      .run();
  }
  return json({ daily_goal: goal });
};
