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

      {projects && projects.length > 0 && (
        <ul className="books">
          {projects.map((p) => (
            <li key={p.id}>
              <a className="book" href={`#/p/${p.id}`}>
                <span className="book-name">{p.title}</span>
                <span className="book-meta">
                  {p.word_count.toLocaleString()} words, {p.chapter_count}{" "}
                  {p.chapter_count === 1 ? "chapter" : "chapters"}
                </span>
                <span className="book-meta book-edited">{lastEdited(p.updated_at)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {projects && projects.length === 0 && (
        <p className="shelf-empty">Nothing on the shelf yet. Name your first novel to begin.</p>
      )}

      {projects && (
        <form className="new-book" onSubmit={create}>
          <label htmlFor="new-title" className="new-book-label">
            {projects.length ? "Start another novel" : "Novel title"}
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

      {!projects && !error && <p className="shelf-empty">Opening your shelf…</p>}
    </div>
  );
}
