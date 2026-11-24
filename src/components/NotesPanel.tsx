import { useEffect, useRef, useState } from "react";
import { createAnchorMatcher, type TextAnchor } from "../../shared/anchors";
import type { MarginNote } from "../../shared/types";
import { api, describeError } from "../api";
import { isNetworkError } from "../sync";

interface Props {
  chapterId: string;
  title: string;
  open: boolean;
  text: string;
  notes: MarginNote[];
  onNotes: (update: (notes: MarginNote[]) => MarginNote[]) => void;
  offline: boolean;
  loading: boolean;
  loadError: string | null;
  anchor: TextAnchor | null;
  selected: string | null;
  onCancelAdd: () => void;
  onSelect: (id: string | null) => void;
  onJump: (note: MarginNote) => void;
  onClose: () => void;
}

export function NotesPanel({ chapterId, title, open: isOpen, text, notes, onNotes, offline, loading, loadError, anchor, selected, onCancelAdd, onSelect, onJump, onClose }: Props) {
  const [body, setBody] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedRef = useRef<HTMLLIElement>(null);
  const currentAnchor = useRef(anchor);
  currentAnchor.current = anchor;
  const lifecycle = useRef({ chapterId, generation: 0, mounted: true });
  if (lifecycle.current.chapterId !== chapterId) {
    lifecycle.current.chapterId = chapterId;
    lifecycle.current.generation++;
  }
  useEffect(() => {
    lifecycle.current.mounted = true;
    return () => { lifecycle.current.mounted = false; lifecycle.current.generation++; };
  }, []);
  useEffect(() => { setBusy(false); setBody(""); setEditing(null); setError(null); }, [chapterId]);
  useEffect(() => { setBody(""); setEditing(null); setError(null); }, [anchor]);
  useEffect(() => { if (isOpen) selectedRef.current?.scrollIntoView({ block: "nearest" }); }, [selected, isOpen]);
  useEffect(() => {
    if (!isOpen) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); onClose(); }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [isOpen, onClose]);

  const run = async (action: (isCurrent: () => boolean) => Promise<void>) => {
    if (busy || loading) return;
    if (offline) { setError("Notes need a connection. Reconnect and try again."); return; }
    const generation = lifecycle.current.generation;
    const isCurrent = () => lifecycle.current.mounted && lifecycle.current.generation === generation;
    setBusy(true);
    setError(null);
    try { await action(isCurrent); }
    catch (e) { if (isCurrent()) setError(isNetworkError(e) ? "Notes need a connection. Reconnect and try again." : describeError(e)); }
    finally { if (isCurrent()) setBusy(false); }
  };
  const save = () => void run(async (isCurrent) => {
    if (anchor) {
      const note = await api.createNote(chapterId, { ...anchor, body });
      if (!isCurrent()) return;
      onNotes((list) => [...list.filter((item) => item.id !== note.id), note]);
      if (currentAnchor.current === anchor) {
        onCancelAdd();
        onSelect(note.id);
      }
    } else if (editing) {
      const note = await api.updateNote(editing, { body });
      if (!isCurrent()) return;
      onNotes((list) => list.map((n) => n.id === note.id ? note : n));
      setEditing(null);
    }
  });
  const update = (note: MarginNote, resolved: boolean) => void run(async (isCurrent) => {
    const result = await api.updateNote(note.id, { resolved });
    if (!isCurrent()) return;
    onNotes((list) => list.map((n) => n.id === note.id ? result : n));
  });
  const remove = (note: MarginNote) => {
    if (!confirm("Delete this note? Your chapter isn't affected.")) return;
    void run(async (isCurrent) => {
      await api.deleteNote(note.id);
      if (!isCurrent()) return;
      onNotes((list) => list.filter((n) => n.id !== note.id));
      if (selected === note.id) onSelect(null);
    });
  };
  if (!isOpen) return null;

  const findAnchor = createAnchorMatcher(text);
  const open = notes.filter((n) => !n.resolved_at).map((note) => ({ note, range: findAnchor(note) }));
  const found = open.filter((item) => item.range).sort((a, b) => a.range!.from - b.range!.from);
  const orphans = open.filter((item) => !item.range);
  const resolved = notes.filter((n) => n.resolved_at);
  const renderNote = (note: MarginNote, foundPassage: boolean) => (
    <li key={note.id} ref={selected === note.id ? selectedRef : undefined} className={`margin-note${selected === note.id ? " is-selected" : ""}`}>
      {note.author === "claude" && <span className="history-meta">Claude</span>}
      <blockquote>{note.quote}</blockquote>
      {editing === note.id ? (
        <form onSubmit={(e) => { e.preventDefault(); save(); }}>
          <label>Note<textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} required /></label>
          <div className="margin-note-actions">
            <button className="btn" disabled={busy || offline}>Save</button>
            <button type="button" className="btn btn-quiet" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
      ) : (
        <>
          <p className="margin-note-body">{note.body}</p>
          <div className="margin-note-actions">
            <button className="btn btn-quiet" disabled={!foundPassage} onClick={() => onJump(note)}>Jump to passage</button>
            <button className="btn btn-quiet" disabled={offline || busy || loading} onClick={() => { onSelect(note.id); setEditing(note.id); setBody(note.body); }}>Edit</button>
            <button className="btn btn-quiet" disabled={offline || busy || loading} onClick={() => update(note, !note.resolved_at)}>{note.resolved_at ? "Reopen" : "Resolve"}</button>
            <button className="btn btn-quiet" disabled={offline || busy || loading} onClick={() => remove(note)}>Delete</button>
          </div>
        </>
      )}
    </li>
  );
  return (
    <aside className="history margin-notes" aria-label={`Notes for ${title}`}>
      <header className="history-head">
        <h2 className="history-title">Notes</h2><span className="desk-spacer" />
        <button className="icon-btn" aria-label="Close notes" onClick={onClose}>×</button>
      </header>
      <div className="history-body">
        {offline && <p className="history-note">Notes need a connection. Reconnect to load or change them.</p>}
        {loadError && <p className="history-error" role="alert">{loadError}</p>}
        {error && <p className="history-error" role="alert">{error}</p>}
        {anchor && (
          <form onSubmit={(e) => { e.preventDefault(); save(); }} className="margin-note-form">
            <h3>Add note</h3><blockquote>{anchor.quote}</blockquote>
            <label>Note<textarea autoFocus value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} required /></label>
            <div className="margin-note-actions">
              <button className="btn btn-lamp" disabled={offline || busy || loading}>Save note</button>
              <button type="button" className="btn btn-quiet" onClick={onCancelAdd}>Cancel</button>
            </div>
          </form>
        )}
        {loading && <p className="history-note">Opening notes…</p>}
        {!loading && !notes.length && !anchor && <p className="history-note">No notes in this chapter yet. Select a passage and choose Add note.</p>}
        {found.length > 0 && <><h3>Open</h3><ul className="margin-note-list">{found.map(({ note }) => renderNote(note, true))}</ul></>}
        {orphans.length > 0 && <><h3>Passage not found</h3><ul className="margin-note-list">{orphans.map(({ note }) => renderNote(note, false))}</ul></>}
        {resolved.length > 0 && <><h3>Resolved</h3><ul className="margin-note-list">{resolved.map((note) => renderNote(note, !!findAnchor(note)))}</ul></>}
      </div>
    </aside>
  );
}
