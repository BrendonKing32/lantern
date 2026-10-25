import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, describeError } from "../api";
import { navigate } from "../router";
import { ChapterList } from "./ChapterList";
import { ChapterEditor, type SaveState } from "./ChapterEditor";
import type { ChapterMeta, ProjectDetail } from "../../shared/types";

// Session words at which the lamp reaches full brightness.
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
  const sessionStart = useRef<Record<string, number>>({});

  const load = useCallback(() => {
    api
      .getProject(projectId)
      .then((d) => {
        setDetail(d);
        setError(null);
      })
      .catch((e) => setError(describeError(e)));
  }, [projectId]);

  useEffect(load, [load]);

  const chapters = detail?.chapters ?? [];
  const selected = chapters.find((c) => c.id === chapterId) ?? chapters[0];

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
    const glow = 0.35 + 0.65 * Math.min(1, sessionWords / FULL_GLOW_WORDS);
    document.documentElement.style.setProperty("--glow", glow.toFixed(3));
  }, [sessionWords]);

  const onWords = useCallback((id: string, words: number, initial: boolean) => {
    if (initial && sessionStart.current[id] === undefined) sessionStart.current[id] = words;
    setLive((prev) => (prev[id] === words ? prev : { ...prev, [id]: words }));
  }, []);

  const onSaved = useCallback((id: string, info: { version: number; word_count: number }) => {
    setDetail((d) =>
      d
        ? { ...d, chapters: d.chapters.map((c) => (c.id === id ? { ...c, ...info } : c)) }
        : d,
    );
  }, []);

  const onStatus = useCallback((state: SaveState, detail?: string) => setSave({ state, detail }), []);

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

  const remove = async (c: ChapterMeta) => {
    if (chapters.length === 1) {
      alert("A novel needs at least one chapter.");
      return;
    }
    if (!confirm(`Delete “${c.title}”? It moves out of the book, and its text is kept in storage.`)) return;
    try {
      await api.deleteChapter(c.id);
      const idx = chapters.findIndex((x) => x.id === c.id);
      const rest = chapters.filter((x) => x.id !== c.id);
      setDetail((d) => (d ? { ...d, chapters: rest } : d));
      if (c.id === selected?.id) navigate(projectId, rest[Math.max(0, idx - 1)].id, true);
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
        <p className="book-count">{bookWords.toLocaleString()} words in {chapters.length} {chapters.length === 1 ? "chapter" : "chapters"}</p>

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
      </aside>

      <button className="scrim" aria-label="Close chapters" onClick={() => setDrawerOpen(false)} tabIndex={drawerOpen ? 0 : -1} />

      <main className="desk">
        <header className="desk-bar">
          <button className="btn btn-quiet drawer-toggle" onClick={() => setDrawerOpen(true)}>
            Chapters
          </button>
          <span className="desk-spacer" />
          <button
            className={`btn btn-quiet dusk-toggle${dusk ? " is-on" : ""}`}
            aria-pressed={dusk}
            onClick={() => setDusk((d) => !d)}
            title="Dusk mode (⌘⇧D)"
          >
            Dusk
          </button>
        </header>

        {selected && (
          <ChapterEditor
            key={selected.id}
            chapterId={selected.id}
            title={selected.title}
            onWords={onWords}
            onSaved={onSaved}
            onStatus={onStatus}
          />
        )}

        <footer className="desk-status" aria-live="polite">
          <span className={`save-state save-${save.state}`} title={save.detail}>
            {save.state === "error" && save.detail ? `Not saved: ${save.detail}` : STATUS_TEXT[save.state]}
          </span>
          <span className="desk-spacer" />
          {selected && <span>{wordsFor(selected).toLocaleString()} words</span>}
          {sessionWords > 0 && <span className="session">+{sessionWords.toLocaleString()} this session</span>}
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
