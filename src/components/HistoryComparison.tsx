import { useEffect, useState } from "react";
import type { HistoryDiff } from "../historyDiff";

interface Props {
  snapshot: string;
  currentText: () => string;
}

export function HistoryComparison({ snapshot, currentText }: Props) {
  const [capture, setCapture] = useState(() => ({ draft: currentText() }));
  const [result, setResult] = useState<HistoryDiff | "error" | null>(null);

  useEffect(() => {
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
    worker.postMessage({ snapshot, draft: capture.draft });
    return () => worker.terminate();
  }, [snapshot, capture]);

  const refresh = () => {
    setResult(null);
    setCapture({ draft: currentText() });
  };

  return (
    <section className="history-text" aria-label="Changes from snapshot to draft">
      <button className="btn btn-quiet" onClick={refresh}>Refresh comparison</button>
      <p className="history-note">Compares with the draft as it was when you opened or refreshed this view.</p>
      {!result && <p className="history-note" role="status">Comparing…</p>}
      {result === "error" && (
        <p className="history-note history-error" role="alert">Couldn’t compare these versions. Try refreshing the comparison.</p>
      )}
      {result && result !== "error" && result.kind === "identical" && (
        <p className="history-note" role="status">No differences from the current draft.</p>
      )}
      {result && result !== "error" && result.kind === "too-large" && (
        <p className="history-note" role="status">Too many changes to compare here. You can still read the snapshot.</p>
      )}
      {result && result !== "error" && result.kind === "changes" && (
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
      )}
    </section>
  );
}
