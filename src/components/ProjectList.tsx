import { useEffect, useState, type FormEvent } from "react";
import { ThemePicker } from "./ThemePicker";
import { api, describeError } from "../api";
import { navigate } from "../router";
import { loadShelf } from "../sync";
import { TodayPanel } from "./TodayPanel";
import { ClaudePanel } from "./ClaudePanel";
import { LanternMark } from "./ProjectView";
import { ago } from "../when";
import type { DeletedProject, ProjectSummary } from "../../shared/types";

const lastEdited = (iso: string) => ago("Edited", iso);

export function ProjectList() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [offline, setOffline] = useState(false);
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [deleted, setDeleted] = useState<DeletedProject[]>([]);

  useEffect(() => {
    document.documentElement.style.setProperty("--glow", "0.35");
    loadShelf()
      .then(({ data, offline }) => {
        setProjects(data);
        setOffline(offline);
      })
      .catch((e) => setError(describeError(e)));
    // Deleted novels are only listed online; offline the section just stays hidden.
    api.deletedProjects().then(setDeleted).catch(() => {});
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
    if (!confirm(`Delete “${p.title}”? It moves to Deleted at the bottom of the shelf, where you can restore it.`)) return;
    try {
      await api.deleteProject(p.id);
      setProjects((list) => list && list.filter((x) => x.id !== p.id));
      const { id, title, chapter_count, word_count } = p;
      setDeleted((d) => [{ id, title, chapter_count, word_count, deleted_at: new Date().toISOString() }, ...d]);
    } catch (err) {
      setError(describeError(err));
    }
  };

  const restore = async (p: DeletedProject) => {
    try {
      const summary = await api.restoreProject(p.id);
      setDeleted((d) => d.filter((x) => x.id !== p.id));
      setProjects((list) =>
        [summary, ...(list ?? []).filter((x) => x.id !== p.id)].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
      );
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
        <span className="desk-spacer" />
        <ThemePicker />
        <a className="btn btn-quiet shelf-changelog-link" href="#/changelog">
          Changelog
        </a>
        {!offline && (
          <button className="btn btn-quiet" onClick={() => setClaudeOpen(true)}>
            Claude
          </button>
        )}
      </header>
      {claudeOpen && <ClaudePanel onClose={() => setClaudeOpen(false)} />}

      {!offline && <TodayPanel />}

      {offline && (
        <p className="offline-note">
          You're offline. Novels you've opened on this device are here to read and write in, and your
          words save when you reconnect.
        </p>
      )}

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
          {archived.length || deleted.length
            ? "Nothing on the shelf right now. Start a new novel, or restore one below."
            : "Nothing on the shelf yet. Name your first novel to begin."}
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

      {deleted.length > 0 && (
        <details className="archive">
          <summary>Deleted ({deleted.length})</summary>
          <ul className="books">
            {deleted.map((p) => (
              <li className="book-item" key={p.id}>
                <span className="book book-gone">
                  <span className="book-name">{p.title}</span>
                  <span className="book-meta">
                    {p.word_count.toLocaleString()} words, {p.chapter_count}{" "}
                    {p.chapter_count === 1 ? "chapter" : "chapters"}
                  </span>
                  <span className="book-meta book-edited">{ago("Deleted", p.deleted_at)}</span>
                </span>
                <span className="book-tools">
                  <button className="icon-btn" aria-label={`Restore ${p.title}`} title="Restore to shelf" onClick={() => restore(p)}>
                    <RestoreIcon />
                  </button>
                </span>
              </li>
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
        <span className="book-meta">Continue writing →</span>
      </a>
      <span className="book-tools">
        {onArchive && (
          <button className="icon-btn" aria-label={`Archive ${p.title}`} title="Archive" onClick={onArchive}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v3h-11zM3.5 6.5v6h9v-6M6.5 9h3" /></svg>
          </button>
        )}
        {onRestore && (
          <button className="icon-btn" aria-label={`Restore ${p.title}`} title="Restore to shelf" onClick={onRestore}>
            <RestoreIcon />
          </button>
        )}
        <button className="icon-btn" aria-label={`Delete ${p.title}`} title="Delete" onClick={onDelete}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" /></svg>
        </button>
      </span>
    </li>
  );
}

export function RestoreIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 7.5A5 5 0 1 1 4.5 11.5M3 3.5v4h4" />
    </svg>
  );
}
