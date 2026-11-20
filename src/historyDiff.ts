import { diffLines } from "diff";

export type HistoryDiffRow =
  | { kind: "unchanged"; count: number }
  | { kind: "added" | "removed"; text: string };

export type HistoryDiff =
  | { kind: "identical" | "too-large" }
  | { kind: "changes"; rows: HistoryDiffRow[]; truncated: boolean };

const MAX_ROWS = 300;
const MAX_TEXT = 60_000;

export function compareHistory(snapshot: string, draft: string): HistoryDiff {
  if (snapshot === draft) return { kind: "identical" };

  const changes = diffLines(snapshot, draft, { timeout: 500, maxEditLength: 4_000 });
  if (!changes) return { kind: "too-large" };

  const rows: HistoryDiffRow[] = [];
  let remaining = MAX_TEXT;
  for (const change of changes) {
    if (rows.length === MAX_ROWS) return { kind: "changes", rows, truncated: true };
    if (!change.added && !change.removed) {
      rows.push({ kind: "unchanged", count: change.count });
      continue;
    }

    const kind = change.added ? "added" : "removed";
    const lines = change.value.replace(/\n$/, "").split("\n");
    for (const line of lines) {
      if (rows.length === MAX_ROWS || remaining === 0) return { kind: "changes", rows, truncated: true };
      if (line.length > remaining) {
        rows.push({ kind, text: line.slice(0, remaining) + "…" });
        return { kind: "changes", rows, truncated: true };
      }
      rows.push({ kind, text: line });
      remaining -= line.length;
    }
  }
  return { kind: "changes", rows, truncated: false };
}
