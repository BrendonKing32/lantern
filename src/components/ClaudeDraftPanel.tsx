import { useEffect, useState } from "react";
import type { ClaudeDraft } from "../../shared/types";
import { replayDraft } from "../../shared/draftReplay";
import { ComparisonRows, useComparison } from "./HistoryComparison";

interface Props {
  title: string;
  draft: ClaudeDraft;
  /** The chapter's text on screen now, unsaved writing included. */
  chapterText: string;
  /** True when the chapter has been saved since Claude began this draft. */
  chapterChanged: boolean;
  /** Why the draft can't be accepted right now, if it can't. */
  blockedBy: string | null;
  busy: boolean;
  error: string | null;
  onAccept: (mode: "as-drafted" | "replayed", expectedText: string) => void;
  onDiscard: () => void;
  onClose: () => void;
}

function Comparison({ draft, chapterText }: { draft: string; chapterText: string }) {
  const result = useComparison(chapterText, draft);
  return (
    <section className="history-text" aria-label="Changes from your chapter to Claude's draft">
      <p className="history-note">Removed lines are in your chapter now; added lines are Claude's.</p>
      <ComparisonRows
        result={result}
        identical="Claude's draft is the same as your chapter."
        tooLarge="Too many changes to compare here. You can still read the draft."
      />
    </section>
  );
}

export function ClaudeDraftPanel({
  title, draft, chapterText, chapterChanged, blockedBy, busy, error, onAccept, onDiscard, onClose,
}: Props) {
  const [reading, setReading] = useState(false);
  const replay = replayDraft(chapterText, draft.ops);
  const comparison = chapterChanged ? replay.text : draft.content;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const accept = () => {
    if (!confirm("Accept Claude's changes? What's in the chapter now is kept in History, so you can switch back.")) return;
    onAccept(chapterChanged ? "replayed" : "as-drafted", comparison);
  };
  const discard = () => {
    if (!confirm("Discard Claude's draft? Your chapter stays as it is, and the draft can't be brought back.")) return;
    onDiscard();
  };

  return (
    <aside className="history" aria-label={`Claude's draft of ${title}`}>
      <header className="history-head">
        <h2 className="history-title">Claude's draft</h2>
        <span className="desk-spacer" />
        <button className="icon-btn" aria-label="Close Claude's draft" title="Close (Esc)" onClick={onClose}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </header>
      <div className="history-preview">
        <p className="history-meta">
          {draft.word_count.toLocaleString()} words · changed {new Date(draft.updated_at).toLocaleString(undefined, {
            month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
          })}
        </p>
        <p className="history-note">
          Claude's edits to this chapter wait here. None of it is in your chapter until you accept it.
        </p>
        {chapterChanged && (
          <p className="history-note history-error">
            You've changed this chapter since Claude started this draft.
          </p>
        )}
        {chapterChanged && replay.failed.map(({ index, op, reason }) => (
          <p className="history-note" key={index}>
            {reason === "missing" ? "No longer in the chapter" : "Appears more than once"}:{" "}
            <q>{op.kind === "replace" ? op.old_text : op.text}</q>
          </p>
        ))}
        {chapterChanged && replay.applied === 0 && <p className="history-note">None of Claude's edits fit the chapter any more.</p>}
        <div className="history-view" role="group" aria-label="Show">
          <button className={`btn${reading ? "" : " is-on"}`} aria-pressed={!reading} onClick={() => setReading(false)}>
            Compare with your chapter
          </button>
          <button className={`btn${reading ? " is-on" : ""}`} aria-pressed={reading} onClick={() => setReading(true)}>
            Read draft
          </button>
        </div>
        {reading
          ? <div className="history-text">{draft.content}</div>
          : <Comparison key={draft.version} draft={comparison} chapterText={chapterText} />}
      </div>
      <footer className="history-restore">
        {error && <p className="history-note history-error" role="alert">{error}</p>}
        <p className="history-note">
          {blockedBy ?? "What's in the chapter now is kept in History."}
        </p>
        <div className="conflict-actions">
          {(!chapterChanged || replay.applied > 0) && (
            <button className="btn btn-lamp" onClick={accept} disabled={busy || blockedBy !== null}>
              {busy ? "Working…" : chapterChanged ? `Accept ${replay.applied} of ${draft.ops.length} edits` : "Accept draft"}
            </button>
          )}
          <button className="btn" onClick={discard} disabled={busy}>
            Discard draft
          </button>
        </div>
      </footer>
    </aside>
  );
}
