import { useState } from "react";
import type { ChapterMeta, SaveResult } from "../../shared/types";
import { api, ApiError, describeError } from "../api";
import { drafts } from "../local";
import { chapterText, rememberSaved } from "../sync";
import { findBookMatches, replaceBookText, type SearchMatch } from "../search";

interface ReplaceItem {
  chapterId: string;
  chapterTitle: string;
  baseVersion: number;
  serverContent: string;
  oldContent: string;
  newContent: string;
  count: number;
  examples: string[];
  writtenAt?: number;
}

interface Props {
  chapters: ChapterMeta[];
  currentChapter?: { id: string; content: string; version: number } | null;
  onOpen: (chapterId: string, quote: string) => void;
  onReplaced: (chapterId: string, result: SaveResult, content: string) => void;
}

function errorText(error: unknown): string {
  if (error instanceof ApiError || error instanceof TypeError) return describeError(error);
  return error instanceof Error ? error.message : describeError(error);
}

export function SearchPanel({ chapters, currentChapter, onOpen, onReplaced }: Props) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [replaceStatus, setReplaceStatus] = useState("");
  const [plan, setPlan] = useState<ReplaceItem[] | null>(null);

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

  const previewReplace = async () => {
    const term = query.trim();
    if (!term) {
      setPlan(null);
      setReplaceStatus("Enter a word or phrase to find.");
      return;
    }
    setBusy(true);
    setPlan(null);
    setReplaceStatus("Checking saved chapters and local drafts…");
    try {
      const current = new Map(
        await Promise.all(chapters.map(async (chapter) => [chapter.id, await api.getChapter(chapter.id)] as const)),
      );
      const items: ReplaceItem[] = [];
      let total = 0;
      for (const chapter of chapters) {
        const server = current.get(chapter.id);
        if (!server) throw new Error(`Couldn't load “${chapter.title}”.`);
        const draft = await drafts.read(chapter.id);
        const oldContent = chapter.id === currentChapter?.id
          ? currentChapter.content
          : draft?.content ?? server.content;
        const result = replaceBookText(oldContent, term, replacement, caseSensitive);
        if (!result.count) continue;
        if (draft && draft.baseVersion !== server.version) {
          throw new Error(`“${chapter.title}” has a draft that conflicts with the saved version. Resolve it before replacing text.`);
        }
        if (chapter.id === currentChapter?.id && currentChapter.version !== server.version) {
          throw new Error(`“${chapter.title}” changed elsewhere. Reload it before replacing text.`);
        }
        if (new TextEncoder().encode(result.content).length > 5 * 1024 * 1024) {
          throw new Error(`Replacing text would make “${chapter.title}” larger than Lantern's 5 MB chapter limit.`);
        }
        items.push({
          chapterId: chapter.id,
          chapterTitle: chapter.title,
          baseVersion: server.version,
          serverContent: server.content,
          oldContent,
          newContent: result.content,
          count: result.count,
          examples: findBookMatches(
            [chapter],
            new Map([[chapter.id, oldContent]]),
            term,
            caseSensitive,
            3,
          ).map((match) => replaceBookText(match.excerpt, term, replacement, caseSensitive).content),
          writtenAt: draft?.savedAt,
        });
        total += result.count;
      }
      setPlan(items);
      setReplaceStatus(total
        ? `Preview: ${total.toLocaleString()} ${total === 1 ? "replacement" : "replacements"} in ${items.length} ${items.length === 1 ? "chapter" : "chapters"}.`
        : "No matches to replace.");
    } catch (error) {
      setReplaceStatus(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const applyReplace = async () => {
    if (!plan?.length) return;
    setBusy(true);
    let replaced = 0;
    try {
      for (const item of plan) {
        const [server, draft] = await Promise.all([
          api.getChapter(item.chapterId),
          drafts.read(item.chapterId),
        ]);
        if (server.version !== item.baseVersion) {
          throw new Error(`“${item.chapterTitle}” changed elsewhere. ${replaced ? `${replaced} earlier chapters were already updated. ` : ""}Preview again before retrying.`);
        }
        const latest = item.chapterId === currentChapter?.id
          ? currentChapter.content
          : draft?.content ?? server.content;
        if (latest !== item.oldContent) {
          throw new Error(`“${item.chapterTitle}” has newer unsaved writing. ${replaced ? `${replaced} earlier chapters were already updated. ` : ""}Preview again before retrying.`);
        }
      }

      for (const item of plan) {
        const result = await api.saveChapter(item.chapterId, item.newContent, item.baseVersion, {
          snapshot: "replace",
          snapshotContent: item.oldContent && item.oldContent !== item.serverContent ? item.oldContent : undefined,
          writtenAt: item.writtenAt,
        });
        await drafts.clearIf(item.chapterId, item.oldContent);
        await rememberSaved(item.chapterId, item.newContent, result);
        onReplaced(item.chapterId, result, item.newContent);
        replaced++;
      }
      const count = plan.reduce((sum, item) => sum + item.count, 0);
      setReplaceStatus(`Replaced ${count.toLocaleString()} ${count === 1 ? "match" : "matches"} in ${replaced} ${replaced === 1 ? "chapter" : "chapters"}. Earlier versions are in History.`);
      setPlan(null);
    } catch (error) {
      const message = errorText(error);
      setReplaceStatus(replaced ? `${replaced} ${replaced === 1 ? "chapter was" : "chapters were"} already replaced. ${message}` : message);
      setPlan(null);
    } finally {
      setBusy(false);
    }
  };

  const totalReplacements = plan?.reduce((sum, item) => sum + item.count, 0) ?? 0;

  return (
    <section className="book-search" aria-label="Search and replace across the whole book">
      <h2>Search and replace</h2>
      <form className="book-search-form" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <label className="book-search-query">
          <span>Find a word or phrase</span>
          <input value={query} onChange={(e) => { setQuery(e.target.value); setPlan(null); }} autoFocus disabled={busy} />
        </label>
        <label className="search-case">
          <input type="checkbox" checked={caseSensitive} onChange={(e) => { setCaseSensitive(e.target.checked); setPlan(null); }} disabled={busy} />
          Match case
        </label>
        <button className="btn btn-lamp" disabled={busy}>{busy ? "Working…" : "Search"}</button>
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

      <div className="book-replace">
        <h3>Replace across the book</h3>
        <form className="replace-form" onSubmit={(e) => { e.preventDefault(); void previewReplace(); }}>
          <label className="book-search-query">
            <span>Replace with</span>
            <input value={replacement} onChange={(e) => { setReplacement(e.target.value); setPlan(null); }} disabled={busy} />
          </label>
          <button className="btn" disabled={busy}>{busy ? "Checking…" : "Preview replacement"}</button>
        </form>
        <p className="search-status" aria-live="polite">{replaceStatus || "Literal replacements include this device’s unsaved drafts. Each changed chapter is saved to History first."}</p>
        {plan && plan.length > 0 && (
          <div className="replace-preview">
            <p>
              Replace {totalReplacements.toLocaleString()} {totalReplacements === 1 ? "match" : "matches"} across {plan.length} {plan.length === 1 ? "chapter" : "chapters"}?
            </p>
            <ul>
              {plan.map((item) => (
                <li key={item.chapterId}>
                  <strong>{item.chapterTitle}: {item.count.toLocaleString()}</strong>
                  <ul className="replace-examples">
                    {item.examples.map((example, i) => <li key={i}>{example}</li>)}
                  </ul>
                </li>
              ))}
            </ul>
            <div className="replace-actions">
              <button className="btn btn-quiet" onClick={() => setPlan(null)} disabled={busy}>Cancel</button>
              <button className="btn btn-lamp" onClick={() => void applyReplace()} disabled={busy}>
                {busy ? "Replacing…" : "Replace all"}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
