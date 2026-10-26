import { useEffect, useState, type FormEvent } from "react";
import { api, describeError } from "../api";
import { navigate } from "../router";
import { LanternMark } from "./ProjectView";
import type { ProjectSummary } from "../../shared/types";

function lastEdited(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "Edited just now";
  if (mins < 60) return `Edited ${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `Edited ${hrs} hr ago`;
  return `Edited ${new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

export function ProjectList() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    document.documentElement.style.setProperty("--glow", "0.35");
    api
      .listProjects()
      .then(setProjects)
      .catch((e) => setError(describeError(e)));
  }, []);

  const setArchived = async (p: ProjectSummary, archived: boolean) => {
    try {
      const res = await api.setArchived(p.id, archived);
      setProjects((list) => list && list.map((x) => (x.id === p.id ? { ...x, archived_at: res.archived_at } : x)));
    } catch (err) {
      setError(describeError(err));
    }
  };

  const remove = async (p: ProjectSummary) => {
    if (!confirm(`Delete “${p.title}”? It leaves your shelf for good, though its text is kept in storage.`)) return;
    try {
      await api.deleteProject(p.id);
      setProjects((list) => list && list.filter((x) => x.id !== p.id));
    } catch (err) {
      setError(describeError(err));
    }
  };

  const active = projects?.filter((p) => !p.archived_at) ?? [];
  const archived = projects?.filter((p) => p.archived_at) ?? [];

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (creating) return;
    setCreating(true);
    try {
      const p = await api.createProject(title.trim() || "Untitled novel");
      navigate(p.id);
    } catch (err) {
      setError(describeError(err));
      setCreating(false);
    }
  };

  return (
    <div className="shelf">
      <header className="shelf-head">
        <LanternMark />
        <h1 className="shelf-name">Lantern</h1>
      </header>

      {error && (
        <p className="shelf-error" role="alert">
          {error}
        </p>
      )}

      {active.length > 0 && (
        <ul className="books">
          {active.map((p) => (
            <Book key={p.id} project={p} onArchive={() => setArchived(p, true)} onDelete={() => remove(p)} />
          ))}
        </ul>
      )}

      {projects && active.length === 0 && (
        <p className="shelf-empty">
          {archived.length ? "Every novel is archived. Start a new one, or restore one below." : "Nothing on the shelf yet. Name your first novel to begin."}
        </p>
      )}

      {projects && (
        <form className="new-book" onSubmit={create}>
          <label htmlFor="new-title" className="new-book-label">
            {active.length ? "Start another novel" : "Novel title"}
          </label>
          <div className="new-book-row">
            <input
              id="new-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Untitled novel"
              maxLength={200}
            />
            <button className="btn btn-lamp" type="submit" disabled={creating}>
              {creating ? "Creating…" : "Create novel"}
            </button>
          </div>
        </form>
      )}

      {archived.length > 0 && (
        <details className="archive">
          <summary>Archived ({archived.length})</summary>
          <ul className="books">
            {archived.map((p) => (
              <Book key={p.id} project={p} onRestore={() => setArchived(p, false)} onDelete={() => remove(p)} />
            ))}
          </ul>
        </details>
      )}

      {!projects && !error && <p className="shelf-empty">Opening your shelf…</p>}
    </div>
  );
}

interface BookProps {
  project: ProjectSummary;
  onArchive?: () => void;
  onRestore?: () => void;
  onDelete: () => void;
}

function Book({ project: p, onArchive, onRestore, onDelete }: BookProps) {
  return (
    <li className="book-item">
      <a className="book" href={`#/p/${p.id}`}>
        <span className="book-name">{p.title}</span>
        <span className="book-meta">
          {p.word_count.toLocaleString()} words, {p.chapter_count}{" "}
          {p.chapter_count === 1 ? "chapter" : "chapters"}
        </span>
        <span className="book-meta book-edited">{lastEdited(p.updated_at)}</span>
      </a>
      <span className="book-tools">
        {onArchive && (
          <button className="icon-btn" aria-label={`Archive ${p.title}`} title="Archive" onClick={onArchive}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v3h-11zM3.5 6.5v6h9v-6M6.5 9h3" /></svg>
          </button>
        )}
        {onRestore && (
          <button className="icon-btn" aria-label={`Restore ${p.title}`} title="Restore to shelf" onClick={onRestore}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 7.5A5 5 0 1 1 4.5 11.5M3 3.5v4h4" /></svg>
          </button>
        )}
        <button className="icon-btn" aria-label={`Delete ${p.title}`} title="Delete" onClick={onDelete}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" /></svg>
        </button>
      </span>
    </li>
  );
}
