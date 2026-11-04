/** "Deleted just now", "Deleted 5 min ago", "Deleted Oct 26" and so on. */
export function ago(verb: string, iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return `${verb} just now`;
  if (mins < 60) return `${verb} ${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${verb} ${hrs} hr ago`;
  return `${verb} ${new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

/** The writer's local calendar date as YYYY-MM-DD. */
export function localDay(at: Date | number = new Date()): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
