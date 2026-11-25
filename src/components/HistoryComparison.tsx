import { useEffect, useState } from "react";
import type { HistoryDiff } from "../historyDiff";

interface Props {
  snapshot: string;
  currentText: () => string;
}

/** Lines added and removed going from `before` to `after`, worked out off the main thread. */
export function useComparison(before: string, after: string): HistoryDiff | "error" | null {
  const [result, setResult] = useState<HistoryDiff | "error" | null>(null);
  useEffect(() => {
    setResult(null);
    let worker: Worker;
    try {
      worker = new Worker(new URL("../historyDiff.worker.ts", import.meta.url), { type: "module" });
    } catch {
      setResult("error");
      return;
    }
    worker.onmessage = ({ data }: MessageEvent<HistoryDiff>) => {
      setResult(data);
      worker.terminate();
    };
    worker.onerror = worker.onmessageerror = () => {
      setResult("error");
      worker.terminate();
    };
    worker.postMessage({ snapshot: before, draft: after });
    return () => worker.terminate();
  }, [before, after]);
  return result;
}

/** The added and removed lines of a comparison, or why there aren't any to show. */
export function ComparisonRows({ result, identical, tooLarge }: {
  result: HistoryDiff | "error" | null;
  identical: string;
  tooLarge: string;
}) {
  if (!result) return <p className="history-note" role="status">Comparing…</p>;
  if (result === "error") {
    return <p className="history-note history-error" role="alert">Couldn’t compare these versions. Try refreshing the comparison.</p>;
  }
  if (result.kind !== "changes") {
    return <p className="history-note" role="status">{result.kind === "identical" ? identical : tooLarge}</p>;
  }
  return (
    <>
      <ul className="history-diff">
        {result.rows.map((row, i) => row.kind === "unchanged" ? (
          <li key={i} className="history-diff-gap">
            {row.count.toLocaleString()} unchanged {row.count === 1 ? "line" : "lines"} hidden
          </li>
        ) : (
          <li key={i} className={`history-diff-${row.kind}`}>
            <span aria-label={row.kind === "added" ? "Added:" : "Removed:"}>
              {row.kind === "added" ? "+" : "−"}
            </span>
            <span>{row.text}</span>
          </li>
        ))}
      </ul>
      {result.truncated && <p className="history-note">Only the beginning of this comparison is shown.</p>}
    </>
  );
}

export function HistoryComparison({ snapshot, currentText }: Props) {
  const [draft, setDraft] = useState(currentText);
  const result = useComparison(snapshot, draft);
  const refresh = () => setDraft(currentText());

  return (
    <section className="history-text" aria-label="Changes from snapshot to draft">
      <button className="btn btn-quiet" onClick={refresh}>Refresh comparison</button>
      <p className="history-note">Compares with the draft as it was when you opened or refreshed this view.</p>
      <ComparisonRows
        result={result}
        identical="No differences from the current draft."
        tooLarge="Too many changes to compare here. You can still read the snapshot."
      />
    </section>
  );
}
