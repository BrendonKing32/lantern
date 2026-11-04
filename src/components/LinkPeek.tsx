import { useEffect, useState } from "react";
import { BIBLE_KINDS, type BibleEntry, type BibleKind } from "../../shared/types";
import { KIND_ONE } from "./BibleView";

interface Props {
  name: string;
  entry: BibleEntry | null;
  offline: boolean;
  onEdit: (entry: BibleEntry) => void;
  onCreate: (name: string, kind: BibleKind) => Promise<void>;
  onClose: () => void;
}

/** The bible entry behind a [[link]], shown beside the page while writing. */
export function LinkPeek({ name, entry, offline, onEdit, onCreate, onClose }: Props) {
  const [kind, setKind] = useState<BibleKind>("character");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className="history peek" aria-label={entry ? `Story bible: ${entry.name}` : `No entry for ${name}`}>
      <header className="history-head">
        <h2 className="history-title">{entry ? KIND_ONE[entry.kind] : "Story bible"}</h2>
        <span className="desk-spacer" />
        <button className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </header>
      <div className="history-body">
        {entry ? (
          <>
            <h3 className="peek-name">{entry.name}</h3>
            {entry.aliases.length > 0 && <p className="peek-aka">Also called {entry.aliases.join(", ")}</p>}
            <div className="peek-body">{entry.body.trim() || <span className="peek-empty">No notes yet.</span>}</div>
            <button className="btn btn-lamp" onClick={() => onEdit(entry)}>
              Edit in the bible
            </button>
          </>
        ) : (
          <>
            <h3 className="peek-name">{name}</h3>
            <p className="history-note">There's no story bible entry called “{name}” yet.</p>
            {offline ? (
              <p className="history-note">Connect to the internet to add it.</p>
            ) : (
              <div className="peek-create">
                <select value={kind} onChange={(e) => setKind(e.target.value as BibleKind)} aria-label="Kind">
                  {BIBLE_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {KIND_ONE[k]}
                    </option>
                  ))}
                </select>
                <button
                  className="btn btn-lamp"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await onCreate(name, kind);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Add “{name}”
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
