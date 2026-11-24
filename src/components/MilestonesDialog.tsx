import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Milestone } from "../../shared/types";
import { api, describeError } from "../api";

interface Props {
  milestones: Milestone[];
  loadError: string | null;
  onCreate: (name: string, note: string) => Promise<void>;
  onChanged: () => Promise<void>;
  onCompare: (milestone: Milestone) => void;
  onExport: (milestone: Milestone) => void;
  onClose: () => void;
}

export function MilestonesDialog({ milestones, loadError, onCreate, onChanged, onCompare, onExport, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editNote, setEditNote] = useState("");
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await action(); } catch (e) {
      setError(e instanceof Error && !(e instanceof TypeError) ? e.message : describeError(e));
    } finally { setBusy(false); }
  };
  const create = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => { await onCreate(name, note); setName(""); setNote(""); });
  };
  return (
    <dialog ref={ref} className="export milestones" onClose={onClose} aria-labelledby="milestones-title">
      <h2 id="milestones-title">Milestones</h2>
      <p className="export-note">Keep a named copy of every chapter as it is now.</p>
      <form onSubmit={create} className="milestone-form">
        <label>Name <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Note <textarea value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <button className="btn btn-lamp" disabled={busy}>Save a milestone</button>
      </form>
      {!loadError && milestones.length === 0 && <p className="export-note">No milestones yet.</p>}
      <ul className="milestone-list">
        {milestones.map((milestone) => <li key={milestone.id}>
          {editing === milestone.id ? (
            <form className="milestone-form" onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await api.updateMilestone(milestone.id, { name: editName, note: editNote });
                await onChanged();
                setEditing(null);
              });
            }}>
              <label>Name <input required maxLength={120} value={editName} onChange={(e) => setEditName(e.target.value)} /></label>
              <label>Note <textarea value={editNote} onChange={(e) => setEditNote(e.target.value)} /></label>
              <div><button className="btn btn-lamp" disabled={busy}>Save</button>{" "}
                <button type="button" className="btn" onClick={() => setEditing(null)} disabled={busy}>Cancel</button></div>
            </form>
          ) : <>
            <strong>{milestone.name}</strong>
            <p className="export-note">{new Date(milestone.created_at).toLocaleDateString()} · {milestone.word_count.toLocaleString()} words</p>
            {milestone.note && <p className="milestone-note">{milestone.note}</p>}
            <button type="button" className="btn" disabled={busy} onClick={() => onCompare(milestone)}>Compare with now</button>{" "}
            <button type="button" className="btn" disabled={busy} onClick={() => onExport(milestone)}>Export</button>{" "}
            <button type="button" className="btn" disabled={busy} onClick={() => {
              setEditing(milestone.id); setEditName(milestone.name); setEditNote(milestone.note);
            }}>Rename</button>{" "}
            <button type="button" className="btn" disabled={busy} onClick={() => {
              if (!confirm(`Delete the milestone “${milestone.name}”? Your chapters aren't affected.`)) return;
              void run(async () => { await api.deleteMilestone(milestone.id); await onChanged(); });
            }}>Delete</button>
          </>}
        </li>)}
      </ul>
      {(error || loadError) && <p className="export-error" role="alert">{error || loadError}</p>}
      <div className="export-actions"><button type="button" className="btn btn-quiet" onClick={onClose} disabled={busy}>Close</button></div>
    </dialog>
  );
}
