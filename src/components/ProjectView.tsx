import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, describeError } from "../api";
import { navigate } from "../router";
import { loadProject } from "../sync";
import { ago } from "../when";
import { RestoreIcon } from "./ProjectList";
import { TargetMeter } from "./TargetMeter";
import { ExportDialog } from "./ExportDialog";
import { Corkboard } from "./Corkboard";
import { BibleView } from "./BibleView";
import { LinkPeek } from "./LinkPeek";
import { loadBible } from "../sync";
import { cache } from "../local";
import { entryIndex, linkKey } from "../../shared/wikilinks";
import { ChapterList } from "./ChapterList";
import { ChapterEditor, type EditorControls, type SaveState } from "./ChapterEditor";
import { CheckPanel, type CheckTab } from "./CheckPanel";
import type { BibleEntry, BibleKind, ChapterMeta, DeletedChapter, ProjectDetail, SaveResult } from "../../shared/types";

type View = "write" | "board" | "bible";
const VIEWS: View[] = ["write", "board", "bible"];

// With no daily goal, session words at which the lamp reaches full brightness.
const FULL_GLOW_WORDS = 1000;

const STATUS_TEXT: Record<SaveState, string> = {
  loading: "Opening",
  saved: "Saved",
  editing: "Writing",
  saving: "Saving",
  offline: "Offline, kept on this device",
  conflict: "Choose a version",
  signedout: "Signed out, reload to sign in",
  error: "Not saved",
};

interface Props {
  projectId: string;
  chapterId?: string;
}

export function ProjectView({ projectId, chapterId }: Props) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, number>>({});
  const [save, setSave] = useState<{ state: SaveState; detail?: string }>({ state: "loading" });
  const [dusk, setDusk] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // Write (the editor), the corkboard or the story bible. Remembered per novel for this tab.
  const viewKey = `lantern:view:${projectId}`;
  const [view, setViewState] = useState<View>(() => {
    try {
      const v = sessionStorage.getItem(viewKey) as View | null;
      return v && VIEWS.includes(v) ? v : "write";
    } catch {
      return "write";
    }
  });
  const setView = (v: View) => {
    setViewState(v);
    setHistoryOpen(false);
    setCheckOpen(false);
    setPeek(null);
    try {
      sessionStorage.setItem(viewKey, v);
    } catch {
      /* only a convenience */
    }
  };
  const board = view === "board";

  // Story bible entries, for the Bible view and [[links]] in chapters.
  const [entries, setEntriesState] = useState<BibleEntry[]>([]);
  const [entryId, setEntryId] = useState<string | null>(null);
  const [peek, setPeek] = useState<string | null>(null);
  const setEntries = useCallback(
    (update: (list: BibleEntry[]) => BibleEntry[]) =>
      setEntriesState((list) => {
        const next = update(list).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
        void cache.setBible(projectId, next);
        return next;
      }),
    [projectId],
  );
  useEffect(() => {
    loadBible(projectId)
      .then(({ data }) => setEntriesState(data))
      .catch(() => {});
  }, [projectId]);
  const index = useMemo(() => entryIndex(entries), [entries]);
  const openLink = useCallback((name: string) => {
    setHistoryOpen(false);
    setCheckOpen(false);
    setPeek(name);
  }, []);
  // The continuity check panel reads the editor's text and points into it.
  const [checkOpen, setCheckOpen] = useState(false);
  const [checkTab, setCheckTab] = useState<CheckTab>("chapter");
  const editorControls = useRef<EditorControls | null>(null);
  const closeCheck = useCallback(() => setCheckOpen(false), []);
  const closePeek = useCallback(() => setPeek(null), []);
  const createFromLink = async (name: string, kind: BibleKind) => {
    try {
      const e = await api.createEntry(projectId, { name, kind });
      setEntries((list) => [...list, e]);
      setEntryId(e.id);
      setView("bible");
    } catch (err) {
      alert(describeError(err));
    }
  };
  const [offline, setOffline] = useState(false);
  const [trash, setTrash] = useState<DeletedChapter[]>([]);
  // Words written today across all novels, and the daily goal (null: none).
  const [today, setToday] = useState<{ words: number; goal: number | null } | null>(null);
  const sessionStart = useRef<Record<string, number>>({});

  const load = useCallback(() => {
    loadProject(projectId)
      .then(({ data, offline }) => {
        setDetail(data);
        setOffline(offline);
        setError(null);
      })
      .catch((e) => setError(describeError(e)));
  }, [projectId]);

  useEffect(load, [load]);
  // Fetch the export code in the background, so the service worker keeps it
  // and exporting works offline too.
  useEffect(() => {
    const t = window.setTimeout(() => void import("../export").catch(() => {}), 4000);
    return () => window.clearTimeout(t);
  }, []);
  useEffect(() => {
    // Only listed online; offline the section stays hidden.
    api.deletedChapters(projectId).then(setTrash).catch(() => {});
    api
      .stats()
      .then((s) => setToday({ words: s.today, goal: s.daily_goal }))
      .catch(() => {});
  }, [projectId]);

  const chapters = detail?.chapters ?? [];
  const selected = chapters.find((c) => c.id === chapterId) ?? chapters[0];

  // History belongs to one chapter; the check panel follows you between chapters.
  useEffect(() => setHistoryOpen(false), [selected?.id]);

  // Open a chapter and select a passage in it, waiting for the editor to load.
  const openQuote = (chapterId: string, quote: string): Promise<boolean> => {
    if (selected?.id !== chapterId) navigate(projectId, chapterId);
    return new Promise((resolve) => {
      const started = Date.now();
      const attempt = () => {
        const ready = editorControls.current;
        if (ready && ready.reveal(quote)) return resolve(true);
        if (Date.now() - started > 4000) return resolve(false);
        window.setTimeout(attempt, 120);
      };
      window.setTimeout(attempt, selected?.id === chapterId ? 0 : 150);
    });
  };

  // Keep the URL pointing at a real chapter.
  useEffect(() => {
    if (detail && selected && selected.id !== chapterId) navigate(projectId, selected.id, true);
  }, [detail, selected, chapterId, projectId]);

  // Dusk mode: Cmd/Ctrl+Shift+D toggles, Esc leaves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        setDusk((d) => !d);
      } else if (e.key === "Escape") {
        setDusk(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("dusk", dusk);
    return () => document.body.classList.remove("dusk");
  }, [dusk]);

  const wordsFor = useCallback((c: ChapterMeta) => live[c.id] ?? c.word_count, [live]);
  const bookWords = chapters.reduce((sum, c) => sum + wordsFor(c), 0);
  const sessionWords = useMemo(
    () =>
      Object.entries(sessionStart.current).reduce(
        (sum, [id, start]) => sum + Math.max(0, (live[id] ?? start) - start),
        0,
      ),
    [live],
  );

  useEffect(() => {
    // The lamp is fully lit once today's goal is met, or after 1,000 words in a session.
    const progress = today?.goal ? Math.max(0, today.words) / today.goal : sessionWords / FULL_GLOW_WORDS;
    const glow = 0.35 + 0.65 * Math.min(1, progress);
    document.documentElement.style.setProperty("--glow", glow.toFixed(3));
  }, [sessionWords, today]);

  const onWords = useCallback((id: string, words: number, initial: boolean) => {
    if (initial && sessionStart.current[id] === undefined) sessionStart.current[id] = words;
    setLive((prev) => (prev[id] === words ? prev : { ...prev, [id]: words }));
  }, []);

  const onSaved = useCallback((id: string, info: SaveResult) => {
    const { today_words, ...meta } = info;
    if (today_words !== undefined) setToday((t) => (t ? { ...t, words: today_words } : t));
    setDetail((d) =>
      d
        ? { ...d, chapters: d.chapters.map((c) => (c.id === id ? { ...c, ...meta } : c)) }
        : d,
    );
  }, []);

  const onStatus = useCallback((state: SaveState, detail?: string) => setSave({ state, detail }), []);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);

  const select = (id: string) => {
    setDrawerOpen(false);
    navigate(projectId, id);
  };

  const addChapter = async () => {
    try {
      const ch = await api.createChapter(projectId, `Chapter ${chapters.length + 1}`);
      setDetail((d) => (d ? { ...d, chapters: [...d.chapters, ch] } : d));
      select(ch.id);
    } catch (e) {
      alert(describeError(e));
    }
  };

  const reorder = async (ids: string[]) => {
    setDetail((d) =>
      d
        ? {
            ...d,
            chapters: ids.map((id, i) => ({ ...d.chapters.find((c) => c.id === id)!, position: i })),
          }
        : d,
    );
    try {
      await api.reorder(projectId, ids);
    } catch (e) {
      alert(describeError(e));
      load();
    }
  };

  const rename = async (id: string, title: string) => {
    setDetail((d) =>
      d ? { ...d, chapters: d.chapters.map((c) => (c.id === id ? { ...c, title } : c)) } : d,
    );
    try {
      await api.updateChapter(id, { title });
    } catch (e) {
      alert(describeError(e));
      load();
    }
  };

  const setSynopsis = async (id: string, synopsis: string) => {
    setDetail((d) =>
      d ? { ...d, chapters: d.chapters.map((c) => (c.id === id ? { ...c, synopsis } : c)) } : d,
    );
    try {
      await api.updateChapter(id, { synopsis });
    } catch (e) {
      alert(describeError(e));
      load();
    }
  };

  const openFromBoard = (id: string) => {
    setView("write");
    select(id);
  };

  const remove = async (c: ChapterMeta) => {
    if (chapters.length === 1) {
      alert("A novel needs at least one chapter.");
      return;
    }
    if (!confirm(`Delete “${c.title}”? It moves to Recently deleted under the chapter list, where you can restore it.`)) return;
    try {
      await api.deleteChapter(c.id);
      setTrash((t) => [{ id: c.id, title: c.title, word_count: wordsFor(c), deleted_at: new Date().toISOString() }, ...t]);
      const idx = chapters.findIndex((x) => x.id === c.id);
      const rest = chapters.filter((x) => x.id !== c.id);
      setDetail((d) => (d ? { ...d, chapters: rest } : d));
      if (c.id === selected?.id) navigate(projectId, rest[Math.max(0, idx - 1)].id, true);
    } catch (e) {
      alert(describeError(e));
    }
  };

  const restoreChapter = async (c: DeletedChapter) => {
    try {
      const ch = await api.restoreChapter(c.id);
      setTrash((t) => t.filter((x) => x.id !== c.id));
      setDetail((d) => (d ? { ...d, chapters: [...d.chapters.filter((x) => x.id !== ch.id), ch] } : d));
      select(ch.id);
    } catch (e) {
      alert(describeError(e));
    }
  };

  const renameProject = async (title: string) => {
    setRenamingTitle(false);
    const t = title.trim();
    if (!detail || !t || t === detail.project.title) return;
    setDetail({ ...detail, project: { ...detail.project, title: t } });
    try {
      await api.renameProject(projectId, t);
    } catch (e) {
      alert(describeError(e));
      load();
    }
  };

  if (error) {
    return (
      <div className="screen-message" role="alert">
        <p>This novel didn't open.</p>
        <p className="screen-message-detail">{error}</p>
        <button className="btn" onClick={() => navigate()}>
          Back to your novels
        </button>
      </div>
    );
  }

  if (!detail) return <div className="screen-message">Opening…</div>;

  return (
    <div className={`workspace${drawerOpen ? " drawer-open" : ""}`}>
      <aside className="sidebar" aria-label="Novel">
        <button className="home-link" onClick={() => navigate()}>
          <LanternMark /> Lantern
        </button>

        {renamingTitle ? (
          <input
            className="book-title-input"
            defaultValue={detail.project.title}
            autoFocus
            aria-label="Novel title"
            onBlur={(e) => renameProject(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") renameProject(e.currentTarget.value);
              if (e.key === "Escape") setRenamingTitle(false);
            }}
          />
        ) : (
          <h2 className="book-title" onDoubleClick={() => setRenamingTitle(true)} title="Double-click to rename">
            {detail.project.title}
          </h2>
        )}
        {offline && <p className="offline-note">Offline. Writing is kept on this device and saves when you reconnect.</p>}
        <p className="book-count">{bookWords.toLocaleString()} words in {chapters.length} {chapters.length === 1 ? "chapter" : "chapters"}</p>
        <TargetMeter
          project={detail.project}
          words={bookWords}
          onChange={(t) => setDetail((d) => (d ? { ...d, project: { ...d.project, ...t } } : d))}
        />

        <ChapterList
          chapters={chapters}
          wordsFor={wordsFor}
          selectedId={selected?.id}
          onSelect={select}
          onReorder={reorder}
          onRename={rename}
          onDelete={remove}
        />

        <button className="add-chapter" onClick={addChapter}>
          Add chapter
        </button>

        {trash.length > 0 && (
          <details className="trash">
            <summary>Recently deleted ({trash.length})</summary>
            <ul className="trash-list">
              {trash.map((c) => (
                <li key={c.id} className="trash-item">
                  <span className="trash-text">
                    <span className="trash-title">{c.title}</span>
                    <span className="trash-meta">
                      {c.word_count.toLocaleString()} words · {ago("deleted", c.deleted_at)}
                    </span>
                  </span>
                  <button
                    className="icon-btn"
                    aria-label={`Restore ${c.title}`}
                    title="Restore to the end of the book"
                    onClick={() => restoreChapter(c)}
                  >
                    <RestoreIcon />
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </aside>

      <button className="scrim" aria-label="Close chapters" onClick={() => setDrawerOpen(false)} tabIndex={drawerOpen ? 0 : -1} />

      <main className="desk">
        <header className="desk-bar">
          <button className="btn btn-quiet drawer-toggle" onClick={() => setDrawerOpen(true)}>
            Chapters
          </button>
          <div className="view-switch" role="group" aria-label="View">
            {(
              [
                ["write", "Write"],
                ["board", "Corkboard"],
                ["bible", "Bible"],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                className={`btn btn-quiet${view === v ? " is-on" : ""}`}
                aria-pressed={view === v}
                onClick={() => setView(v)}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="desk-spacer" />
          <button className="btn btn-quiet" onClick={() => setExportOpen(true)}>
            Export
          </button>
          {view === "write" && (
            <button
              className={`btn btn-quiet history-toggle${historyOpen ? " is-on" : ""}`}
              aria-pressed={historyOpen}
              onClick={() => {
                setPeek(null);
                setCheckOpen(false);
                setHistoryOpen((h) => !h);
              }}
            >
              History
            </button>
          )}
          {view === "write" && (
            <button
              className={`btn btn-quiet${checkOpen ? " is-on" : ""}`}
              aria-pressed={checkOpen}
              title="Check this chapter against the story bible"
              onClick={() => {
                setPeek(null);
                setHistoryOpen(false);
                setCheckOpen((c) => !c);
              }}
            >
              Check
            </button>
          )}
          <button
            className={`btn btn-quiet dusk-toggle${dusk ? " is-on" : ""}`}
            aria-pressed={dusk}
            onClick={() => setDusk((d) => !d)}
            title="Dusk mode (⌘⇧D)"
          >
            Dusk
          </button>
        </header>

        {view === "bible" ? (
          <BibleView
            projectId={projectId}
            entries={entries}
            onEntries={setEntries}
            selectedId={entryId}
            onSelect={setEntryId}
            chapters={chapters}
            onOpenChapter={openFromBoard}
            offline={offline}
          />
        ) : board ? (
          <Corkboard
            chapters={chapters}
            wordsFor={wordsFor}
            selectedId={selected?.id}
            onOpen={openFromBoard}
            onReorder={reorder}
            onSynopsis={setSynopsis}
            onAdd={addChapter}
          />
        ) : selected && (
          <ChapterEditor
            key={selected.id}
            chapterId={selected.id}
            title={selected.title}
            onWords={onWords}
            onSaved={onSaved}
            onStatus={onStatus}
            historyOpen={historyOpen}
            onCloseHistory={closeHistory}
            entries={entries}
            onOpenLink={openLink}
            controls={editorControls}
          />
        )}

        {view === "write" && checkOpen && selected && (
          <CheckPanel
            projectId={projectId}
            chapter={selected}
            chapters={chapters}
            wordsFor={wordsFor}
            entries={entries}
            controls={editorControls}
            offline={offline}
            tab={checkTab}
            onTab={setCheckTab}
            onOpenQuote={openQuote}
            onEntryCreated={(entry) => setEntries((list) => [...list, entry])}
            onClose={closeCheck}
          />
        )}

        {view === "write" && peek !== null && (
          <LinkPeek
            name={peek}
            entry={index.get(linkKey(peek)) ?? null}
            offline={offline}
            onEdit={(e) => {
              setEntryId(e.id);
              setView("bible");
            }}
            onCreate={createFromLink}
            onClose={closePeek}
          />
        )}

        {exportOpen && <ExportDialog detail={detail} onClose={() => setExportOpen(false)} />}

        <footer className="desk-status" aria-live="polite">
          <span className={`save-state save-${save.state}`} title={save.detail}>
            {save.state === "error" && save.detail ? `Not saved: ${save.detail}` : STATUS_TEXT[save.state]}
          </span>
          <span className="desk-spacer" />
          {view !== "write" ? (
            <span>{bookWords.toLocaleString()} words in the book</span>
          ) : (
            selected && <span>{wordsFor(selected).toLocaleString()} words</span>
          )}
          {sessionWords > 0 && <span className="session">+{sessionWords.toLocaleString()} this session</span>}
          {today?.goal && (
            <span className={Math.max(0, today.words) >= today.goal ? "session" : undefined}>
              {Math.max(0, today.words).toLocaleString()} / {today.goal.toLocaleString()} today
            </span>
          )}
        </footer>
      </main>
    </div>
  );
}

export function LanternMark() {
  return (
    <svg className="lantern-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 3h6M12 3v2" />
      <path d="M7.5 7h9l-1 11h-7z" />
      <path d="M7 18.5h10" />
      <circle cx="12" cy="12.5" r="2.2" className="lantern-flame" />
    </svg>
  );
}
