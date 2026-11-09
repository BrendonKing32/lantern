import { useState } from "react";
import type { ChapterMeta } from "../../shared/types";
import { chapterText } from "../sync";
import { findBookMatches, type SearchMatch } from "../search";

interface Props {
  chapters: ChapterMeta[];
  currentChapter?: { id: string; content: string } | null;
  onOpen: (chapterId: string, quote: string) => void;
}

export function SearchPanel({ chapters, currentChapter, onOpen }: Props) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const search = async () => {
    const term = query.trim();
    if (!term) {
      setMatches([]);
      setStatus("Enter a word or phrase to search.");
      return;
    }
    setBusy(true);
    setStatus("Searching the book…");
    try {
      const loaded = await Promise.all(chapters.map(async (chapter) => [chapter.id, await chapterText(chapter.id)] as const));
      const missing = loaded.find(([, content]) => content === null);
      if (missing) throw new Error(`Couldn't load “${chapters.find((c) => c.id === missing[0])?.title ?? "a chapter"}” for searching.`);
      const contents = new Map(loaded.map(([id, content]) => [id, content ?? ""]));
      if (currentChapter) contents.set(currentChapter.id, currentChapter.content);
      const found = findBookMatches(chapters, contents, term, caseSensitive, 501);
      const truncated = found.length > 500;
      const shown = found.slice(0, 500);
      setMatches(shown);
      setStatus(shown.length
        ? `${truncated ? "500+ matches (showing the first 500)" : `${shown.length} ${shown.length === 1 ? "match" : "matches"}`}.`
        : "No matches found.");
    } catch (error) {
      setMatches([]);
      setStatus(error instanceof Error ? error.message : "The book couldn't be searched.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="book-search" aria-label="Search the whole book">
      <h2>Search the whole book</h2>
      <form className="book-search-form" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <label className="book-search-query">
          <span>Find a word or phrase</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
        </label>
        <label className="search-case">
          <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />
          Match case
        </label>
        <button className="btn btn-lamp" disabled={busy}>{busy ? "Searching…" : "Search"}</button>
      </form>
      <p className="search-status" aria-live="polite">{status || "Search includes unsaved drafts saved on this device."}</p>
      {matches.length > 0 && (
        <ol className="search-results">
          {matches.map((match, i) => (
            <li key={`${match.chapterId}:${match.index}`}>
              <button className="search-result" onClick={() => onOpen(match.chapterId, match.text)}>
                <strong>{match.chapterTitle}</strong>
                <span>{match.excerpt}</span>
                <small>Match {i + 1}</small>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
