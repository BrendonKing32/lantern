import { useEffect, useState } from "react";
import { api, describeError } from "../api";
import { isNetworkError } from "../sync";
import { countWords } from "../../shared/wordcount";
import type { Snapshot, SnapshotReason, SnapshotWithContent } from "../../shared/types";
import { HistoryComparison } from "./HistoryComparison";

interface Props {
  chapterId: string;
  title: string;
  /** The text in the editor now, read when needed so typing doesn't re-render this. */
  currentText: () => string;
  canRestore: boolean;
  onRestore: (content: string) => void;
  onClose: () => void;
}

const REASON: Record<SnapshotReason, string> = {
  auto: "",
  restore: "Before a restore",
  conflict: "From another device",
  replace: "Before a find and replace",
  claude: "Before an edit by Claude",
};

function when(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  const sameYear = d.getFullYear() === today.getFullYear();
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
  return `${date}, ${time}`;
}

function delta(then: number, now: number): string {
  const diff = then - now;
  if (diff === 0) return "same length as now";
  return `${Math.abs(diff).toLocaleString()} ${diff > 0 ? "more" : "fewer"} than now`;
}

export function HistoryPanel({ chapterId, title, currentText, canRestore, onRestore, onClose }: Props) {
  const [list, setList] = useState<Snapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<SnapshotWithContent | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const nowWords = countWords(currentText());
  const closePreview = () => {
    setComparing(false);
    setPreview(null);
  };

  useEffect(() => {
    let live = true;
    api
      .listHistory(chapterId)
      .then((l) => live && setList(l))
      .catch((e) =>
        live && setError(isNetworkError(e) ? "History needs a connection. Your writing is still safe on this device." : describeError(e)),
      );
    return () => {
      live = false;
    };
  }, [chapterId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (comparing) setComparing(false);
        else if (preview) closePreview();
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [comparing, preview, onClose]);

  const open = async (s: Snapshot) => {
    setOpening(s.id);
    try {
      setPreview(await api.getSnapshot(chapterId, s.id));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setOpening(null);
    }
  };

  const restore = () => {
    if (!preview) return;
    if (!confirm("Put this version back? What's in the chapter now is kept in history, so you can switch back.")) return;
    onRestore(preview.content);
  };

  return (
    <aside className="history" aria-label={`History of ${title}`}>
      <header className="history-head">
        {preview ? (
          <button className="btn btn-quiet" onClick={closePreview}>
            ← All versions
          </button>
        ) : (
          <h2 className="history-title">History</h2>
        )}
        <span className="desk-spacer" />
        <button className="icon-btn" aria-label="Close history" title="Close (Esc)" onClick={onClose}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </header>

      {preview ? (
        <>
          <div className="history-preview">
            <p className="history-meta">
              {when(preview.created_at)} · {preview.word_count.toLocaleString()} words, {delta(preview.word_count, nowWords)}
            </p>
            <div className="history-view" role="group" aria-label="Show">
              <button className={`btn${comparing ? "" : " is-on"}`} aria-pressed={!comparing} onClick={() => setComparing(false)}>
                Read snapshot
              </button>
              <button className={`btn${comparing ? " is-on" : ""}`} aria-pressed={comparing} onClick={() => setComparing(true)}>
                Compare with current draft
              </button>
            </div>
            {comparing ? <HistoryComparison snapshot={preview.content} currentText={currentText} />
              : <div className="history-text">{preview.content}</div>}
          </div>
          <footer className="history-restore">
            <p className="history-note">
              {canRestore ? "Restoring replaces the chapter. What's there now is kept in history." : "Choose a version in the notice first."}
            </p>
            <button className="btn" onClick={restore} disabled={!canRestore}>
              Restore this version
            </button>
          </footer>
        </>
      ) : (
        <div className="history-body">
          <p className="history-note">
            Lantern keeps a copy at most every 10 minutes while you write, and always before a restore, a whole-book replacement or an edit by Claude.
          </p>
          {error && (
            <p className="history-note history-error" role="alert">
              {error}
            </p>
          )}
          {!list && !error && <p className="history-note">Opening history…</p>}
          {list && list.length === 0 && (
            <p className="history-note">No earlier versions yet. Keep writing and they'll appear here.</p>
          )}
          {list && list.length > 0 && (
            <ul className="history-list">
              {list.map((s) => (
                <li key={s.id}>
                  <button className="history-item" onClick={() => open(s)} disabled={opening !== null}>
                    <span className="history-when">{when(s.created_at)}</span>
                    <span className="history-words">
                      {opening === s.id ? "Opening…" : `${s.word_count.toLocaleString()} words`}
                      {REASON[s.reason] && <> · {REASON[s.reason]}</>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </aside>
  );
}
