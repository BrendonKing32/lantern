import { useEffect, useState } from "react";
import type { ChangelogEntry } from "../../shared/types";
import { api, describeError } from "../api";
import { LanternMark } from "./ProjectView";
import { ThemePicker } from "./ThemePicker";

export function Changelog() {
  const [entries, setEntries] = useState<ChangelogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.changelog()
      .then((result) => {
        if (!cancelled) setEntries(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(describeError(err));
      });
    return () => { cancelled = true; };
  }, [attempt]);

  return (
    <div className="changelog-page">
      <header className="changelog-top">
        <a className="home-link" href="#/"><LanternMark /> Back to shelf</a>
        <ThemePicker />
      </header>
      <main>
        <h1>Changelog</h1>
        <p className="changelog-intro">
          Changes merged into main, newest first. Open a pull request for the full details.
        </p>
        {error ? (
          <div role="alert">
            <p className="shelf-error">{error}</p>
            <button className="btn" type="button" onClick={() => { setError(null); setAttempt((n) => n + 1); }}>
              Try again
            </button>
          </div>
        ) : entries ? (
          <ChangelogList entries={entries} />
        ) : (
          <p className="shelf-empty" role="status">Loading the changelog…</p>
        )}
      </main>
    </div>
  );
}

export function ChangelogList({ entries }: { entries: ChangelogEntry[] }) {
  if (!entries.length) return <p className="shelf-empty">No pull requests have been merged yet.</p>;
  return (
    <ol className="changelog-list">
      {entries.map((entry) => (
        <li key={entry.number} className="changelog-entry">
          <div className="changelog-meta">
            <time dateTime={entry.merged_at}>
              {new Date(entry.merged_at).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}
            </time>
            <span>PR #{entry.number}</span>
          </div>
          <a className="changelog-title" href={entry.url}>{entry.title}</a>
        </li>
      ))}
    </ol>
  );
}
