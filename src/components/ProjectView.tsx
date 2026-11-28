import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ThemePicker } from "./ThemePicker";
import { api, describeError } from "../api";
import { navigate } from "../router";
import { forgetChapter, loadProject } from "../sync";
import { ago } from "../when";
import { RestoreIcon } from "./ProjectList";
import { TargetMeter } from "./TargetMeter";
import { ExportDialog } from "./ExportDialog";
import { MilestonesDialog } from "./MilestonesDialog";
import { MilestoneComparison } from "./MilestoneComparison";
import { createMilestone } from "../milestones";
import { ShareDialog } from "./ShareDialog";
import { ClaudeChangesDialog } from "./ClaudeChangesDialog";
import { Corkboard } from "./Corkboard";
import { SceneBoard } from "./SceneBoard";
import { SearchPanel } from "./SearchPanel";
import { BibleView } from "./BibleView";
import { LinkPeek } from "./LinkPeek";
import { loadBible } from "../sync";
import { cache } from "../local";
import { selectChapter } from "../resume";
import { entryIndex, linkKey } from "../../shared/wikilinks";
import { ChapterList } from "./ChapterList";
import { ChapterEditor, type EditorControls, type SaveState } from "./ChapterEditor";
import { CheckPanel, type CheckTab } from "./CheckPanel";
import { grammarEnabled, setGrammarEnabled } from "../grammar";
import { sceneLabelsEnabled, setSceneLabelsEnabled } from "../sceneLabels";
import { dimmingEnabled, focusRemembered, isFocusShortcut, keepAwake, rememberFocus, setDimmingEnabled, setTypewriterEnabled, typewriterEnabled } from "../focusMode";
import { DIALECTS } from "../../shared/types";
import type { Act, BibleEntry, BibleKind, ChapterMeta, DeletedChapter, Dialect, Milestone, Outline, ProjectDetail, SaveResult, SceneMeta, ScenePlaceholder } from "../../shared/types";
import { arrangeChapters } from "../../shared/acts";
import { splitScenes } from "../../shared/scenes";
import { arrangeChapterScenes, flushForSceneMove, moveSceneBetweenChapters, SceneMoveError } from "../sceneArrangement";

type View = "write" | "board" | "scenes" | "search" | "bible";
const VIEWS: View[] = ["write", "board", "scenes", "search", "bible"];
const VIEW_LABELS = [
  ["write", "Write"],
  ["board", "Corkboard"],
  ["scenes", "Scenes"],
  ["bible", "Story Guide"],
] as const;

// With no daily goal, session words at which the lamp reaches full brightness.
const FULL_GLOW_WORDS = 1000;

type LabelSnapshot = { chapterId: string; baseline: string; scenes: SceneMeta[] };

export function useLabelSnapshot(
  projectId: string,
  view: View,
  chapterId: string | undefined,
  title: string | undefined,
  controls: { current: EditorControls | null },
  setScenes: (scenes: SceneMeta[]) => void,
) {
  const [snapshot, setSnapshot] = useState<LabelSnapshot | null>(null);
  const [refresh, setRefresh] = useState(0);
  const lastRefresh = useRef(0);
  const lastRequest = useRef<{ projectId: string; chapterId: string; refresh: number } | null>(null);
  const visitedScenes = useRef(false);

  useEffect(() => {
    if (view === "scenes") visitedScenes.current = true;
    if (view !== "write" || !chapterId) return;
    const returningFromScenes = visitedScenes.current;
    visitedScenes.current = false;
    const previous = lastRequest.current;
    if (!returningFromScenes && previous?.projectId === projectId && previous.chapterId === chapterId && previous.refresh === refresh) return;
    const request = { projectId, chapterId, refresh };
    lastRequest.current = request;
    lastRefresh.current = Date.now();
    let active = true;
    let finished = false;
    let retryTimer: number | undefined;
    const loadLabels = async () => {
      for (let attempt = 0; attempt < 3 && active; attempt++) {
        const before = await api.getChapter(chapterId);
        if (!active) return;
        const listing = await api.scenes(projectId);
        if (!active) return;
        const after = await api.getChapter(chapterId);
        if (!active) return;
        if (before.version !== after.version || before.content !== after.content) continue;
        setScenes(listing.scenes);
        setSnapshot({ chapterId, baseline: after.content, scenes: listing.scenes });
        return true;
      }
      return false;
    };
    void loadLabels().catch(() => false).then((success) => {
      finished = true;
      if (active && !success) retryTimer = window.setTimeout(() => setRefresh((n) => n + 1), 30_000);
    });
    return () => {
      active = false;
      window.clearTimeout(retryTimer);
      if (!finished && lastRequest.current === request) lastRequest.current = null;
    };
  }, [projectId, view, chapterId, refresh, setScenes]);

  useEffect(() => {
    if (view !== "write" || !chapterId || snapshot?.chapterId !== chapterId) return;
    const baselineCount = splitScenes(snapshot.baseline, title).length;
    let lastText: string | undefined;
    let passageCount = baselineCount;
    const timer = window.setInterval(() => {
      const text = controls.current?.text();
      if (text === undefined || Date.now() - lastRefresh.current < 30_000) return;
      if (text !== lastText) {
        lastText = text;
        passageCount = splitScenes(text, title).length;
      }
      if (passageCount !== baselineCount) {
        setRefresh((n) => n + 1);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [view, chapterId, title, snapshot, controls]);

  const chapterSaved = useCallback((id: string, replaced?: boolean) => {
    if (replaced && id === chapterId) setRefresh((n) => n + 1);
  }, [chapterId]);
  return { snapshot, chapterSaved };
}

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
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [phone, setPhone] = useState(() => window.matchMedia("(max-width: 600px)").matches);
  // Tablet-portrait widths: the theme picker moves into More so the bar stays one row.
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 800px)").matches);
  const [editingChapter, setEditingChapter] = useState<string | null>(null);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 800px)");
    const onChange = () => setNarrow(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 600px)");
    const onChange = () => {
      setPhone(media.matches);
      setEditingChapter(null);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  const sidebarRef = useRef<HTMLElement>(null);
  const drawerToggleRef = useRef<HTMLButtonElement>(null);
  const drawerCloseRef = useRef<HTMLButtonElement>(null);
  const renameProjectRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDetailsElement>(null);
  const [renamingTitle, setRenamingTitle] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [milestonesOpen, setMilestonesOpen] = useState(false);
  const [milestoneExport, setMilestoneExport] = useState<Milestone | null>(null);
  const [comparison, setComparison] = useState<{ milestone: Milestone; activeText: { id: string; text: string } | null } | null>(null);
  const addedMilestoneChapters = useRef(new Map<string, ChapterMeta>());
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const [milestonesError, setMilestonesError] = useState<string | null>(null);
  const refreshMilestones = useCallback(async () => {
    try {
      setMilestones(await api.milestones(projectId));
      setMilestonesError(null);
    } catch (e) {
      setMilestonesError(describeError(e));
      throw e;
    }
  }, [projectId]);
  useEffect(() => { void refreshMilestones().catch(() => {}); }, [refreshMilestones]);
  const [shareOpen, setShareOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [unseenChanges, setUnseenChanges] = useState(0);
  const closeDrawer = useCallback(() => {
    // Commit first so the desk is no longer inert when focus returns to it.
    flushSync(() => setDrawerOpen(false));
    if (window.matchMedia("(max-width: 1024px)").matches) drawerToggleRef.current?.focus();
  }, []);

  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 1024px)");
    const onChange = () => {
      if (!mobile.matches) setDrawerOpen(false);
    };
    mobile.addEventListener("change", onChange);
    return () => mobile.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!drawerOpen || !window.matchMedia("(max-width: 1024px)").matches) return;
    drawerCloseRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        const focusable = Array.from(sidebarRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])',
        ) ?? []).filter((element) => element.getClientRects().length > 0);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [drawerOpen]);
  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      const menu = moreMenuRef.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      const menu = moreMenuRef.current;
      if (event.key === "Escape" && menu?.open) {
        menu.open = false;
        menu.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);
  // Write (the editor), the corkboard or the story guide. Remembered per novel for this tab.
  const viewKey = `lantern:view:${projectId}`;
  const [view, setViewState] = useState<View>(() => {
    if (!chapterId) return "write";
    try {
      const v = sessionStorage.getItem(viewKey) as View | null;
      return v && VIEWS.includes(v) ? v : "write";
    } catch {
      return "write";
    }
  });
  const closeMoreMenu = () => {
    if (moreMenuRef.current) moreMenuRef.current.open = false;
  };
  const setView = (v: View) => {
    closeMoreMenu();
    if (v === "scenes" && v !== view) setScenes(null);
    // The footer's save state belongs to the chapter editor, which unmounts
    // outside Write. Start fresh so a return never shows a stale state.
    if (v !== view) setSave({ state: "loading" });
    setViewState(v);
    setEditingChapter(null);
    setHistoryOpen(false);
    setNotesOpen(false);
    setCheckOpen(false);
    setPeek(null);
    setScenePeek(null);
    try {
      sessionStorage.setItem(viewKey, v);
    } catch {
      /* only a convenience */
    }
  };
  const board = view === "board";

  // Story guide entries, for the Story Guide view and [[links]] in chapters.
  const [entries, setEntriesState] = useState<BibleEntry[]>([]);
  const [entryId, setEntryId] = useState<string | null>(null);
  const [peek, setPeek] = useState<string | null>(null);
  const [scenePeek, setScenePeek] = useState<string | null>(null);
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
    setNotesOpen(false);
    setCheckOpen(false);
    setScenePeek(null);
    setPeek(name);
  }, []);
  // The continuity check panel reads the editor's text and points into it.
  const [checkOpen, setCheckOpen] = useState(false);
  const [grammarOn, setGrammarOn] = useState(grammarEnabled);
  useEffect(() => setGrammarEnabled(grammarOn), [grammarOn]);
  const [sceneLabelsOn, setSceneLabelsOn] = useState(sceneLabelsEnabled);
  useEffect(() => setSceneLabelsEnabled(sceneLabelsOn), [sceneLabelsOn]);

  const [checkTab, setCheckTab] = useState<CheckTab>("chapter");
  const editorControls = useRef<EditorControls | null>(null);
  const closeCheck = useCallback(() => setCheckOpen(false), []);
  const closePeek = useCallback(() => setPeek(null), []);
  useEffect(() => {
    if (scenePeek === null) return;
    const close = (e: KeyboardEvent) => { if (e.key === "Escape") setScenePeek(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [scenePeek]);
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
  const [disconnected, setDisconnected] = useState(() => !navigator.onLine);
  useEffect(() => {
    const update = () => setDisconnected(!navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  const [lastChapterId, setLastChapterId] = useState<string | null>(null);
  const [trash, setTrash] = useState<DeletedChapter[]>([]);
  const [scenes, setScenes] = useState<SceneMeta[] | null>(null);
  const [placeholders, setPlaceholders] = useState<ScenePlaceholder[]>([]);
  const [scenesError, setScenesError] = useState<string | null>(null);
  const [sceneMove, setSceneMove] = useState<
    | { kind: "arrange"; chapter: ChapterMeta; sceneIds: string[]; expectedIds: string[]; title: string }
    | { kind: "across"; from: ChapterMeta; to: ChapterMeta; sceneId: string; passageIndex: number; sourceVersion: number; title: string }
    | null
  >(null);
  const [movingScene, setMovingScene] = useState(false);
  const sceneMoveBusy = useRef(false);
  const [searchText, setSearchText] = useState<{ id: string; content: string; version: number } | null>(null);
  // Words written today across all novels, and the daily goal (null: none).
  const [today, setToday] = useState<{ words: number; goal: number | null } | null>(null);
  const sessionStart = useRef<Record<string, number>>({});

  const load = useCallback((initial = false) => {
    Promise.all([loadProject(projectId), initial ? cache.lastChapter(projectId) : Promise.resolve(null)])
      .then(([{ data, offline }, lastChapter]) => {
        if (initial) setLastChapterId(lastChapter);
        setDetail(data);
        setOffline(offline);
        setError(null);
      })
      .catch((e) => setError(describeError(e)));
  }, [projectId]);

  useEffect(() => load(true), [load]);
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
  // Novels saved on this device before acts existed have none.
  const acts = detail?.acts ?? [];
  const [renamingActId, setRenamingActId] = useState<string | null>(null);

  // AI changes: how many this device hasn't shown yet, checked when the
  // novel opens and whenever the window comes back into focus.
  const seenKey = `lantern:claude-seen:${projectId}`;
  const lastSeen = () => {
    try {
      return localStorage.getItem(seenKey) ?? "";
    } catch {
      return "";
    }
  };
  const markSeen = useCallback(
    (newest: string | null) => {
      setUnseenChanges(0);
      if (!newest) return;
      try {
        localStorage.setItem(seenKey, newest);
      } catch {
        /* only a convenience */
      }
    },
    [seenKey],
  );
  useEffect(() => {
    if (offline) return;
    let live = true;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      api
        .claudeChanges(projectId)
        .then((list) => {
          if (!live) return;
          const seen = lastSeen();
          setUnseenChanges(list.filter((c) => c.created_at > seen).length);
        })
        .catch(() => {});
    };
    check();
    window.addEventListener("focus", check);
    return () => {
      live = false;
      window.removeEventListener("focus", check);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, offline]);
  const selected = selectChapter(chapters, chapterId, lastChapterId);
  const { snapshot: labelSnapshot, chapterSaved } = useLabelSnapshot(
    projectId, view, selected?.id, selected?.title, editorControls, setScenes,
  );
  useEffect(() => {
    if (!selected) return;
    setLastChapterId(selected.id);
    void cache.setLastChapter(projectId, selected.id);
  }, [projectId, selected?.id]);
  const readOnly = phone && editingChapter !== selected?.id;
  useEffect(() => setEditingChapter(null), [selected?.id]);
  useEffect(() => {
    if (view !== "scenes") return;
    let active = true;
    setScenes(null);
    setScenesError(null);
    api.scenes(projectId).then(({ scenes, placeholders }) => {
      if (active) { setScenes(scenes); setPlaceholders(placeholders); }
    }).catch((e) => { if (active) setScenesError(describeError(e)); });
    return () => { active = false; };
  }, [projectId, view]);
  useEffect(() => {
    if (view !== "board") return;
    let active = true;
    api.scenes(projectId).then(({ scenes, placeholders }) => {
      if (active) { setScenes(scenes); setPlaceholders(placeholders); }
    }).catch(() => {});
    return () => { active = false; };
  }, [projectId, view]);
  // Novels saved on this device before dialects existed have none: US English.
  const dialect: Dialect = detail?.project.dialect ?? "american";

  // History belongs to one chapter; the check panel follows you between chapters.
  useEffect(() => setHistoryOpen(false), [selected?.id]);
  useEffect(() => setNotesOpen(false), [selected?.id]);
  useEffect(() => setScenePeek(null), [selected?.id]);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === "Escape" && drawerOpen) closeDrawer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen, closeDrawer]);

  const wordsFor = useCallback((c: ChapterMeta) => live[c.id] ?? c.word_count, [live]);
  const wordsForRef = useRef(wordsFor);
  wordsForRef.current = wordsFor;
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

  const onWords = useCallback((id: string, words: number, initial: boolean, notWritten = 0) => {
    if (initial && sessionStart.current[id] === undefined) sessionStart.current[id] = words;
    if (notWritten && sessionStart.current[id] !== undefined) sessionStart.current[id] += notWritten;
    setLive((prev) => (prev[id] === words ? prev : { ...prev, [id]: words }));
  }, []);

  const onSaved = useCallback((id: string, info: SaveResult, replaced?: boolean) => {
    chapterSaved(id, replaced);
    const { today_words, ...meta } = info;
    if (today_words !== undefined) setToday((t) => (t ? { ...t, words: today_words } : t));
    setDetail((d) =>
      d
        ? { ...d, chapters: d.chapters.map((c) => (c.id === id && c.version <= meta.version ? { ...c, ...meta } : c)) }
        : d,
    );
  }, [chapterSaved]);

  const onStatus = useCallback((state: SaveState, detail?: string) => setSave({ state, detail }), []);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);

  const select = useCallback((id: string) => {
    setEditingChapter(null);
    if (drawerOpen) closeDrawer();
    navigate(projectId, id);
  }, [closeDrawer, drawerOpen, projectId]);

  const openSearch = () => {
    const text = editorControls.current?.text();
    setSearchText(text !== undefined && selected ? { id: selected.id, content: text, version: selected.version } : null);
    setView("search");
  };

  // Focus mode: the page alone, for long sessions. Everything but the chapter
  // is put away, and a quiet bar at the foot comes back when the mouse moves.
  const [focus, setFocus] = useState(() => view === "write" && focusRemembered());
  const [typewriterOn, setTypewriterOn] = useState(typewriterEnabled);
  useEffect(() => setTypewriterEnabled(typewriterOn), [typewriterOn]);
  const [dimmingOn, setDimmingOn] = useState(dimmingEnabled);
  useEffect(() => setDimmingEnabled(dimmingOn), [dimmingOn]);
  useEffect(() => rememberFocus(focus), [focus]);
  // Whether the browser went full screen for focus mode (so leaving it leaves focus mode too).
  const focusFullscreen = useRef(false);
  const enterFocus = () => {
    if (!selected) return;
    if (view !== "write") setView("write");
    closeMoreMenu();
    if (drawerOpen) setDrawerOpen(false);
    setHistoryOpen(false);
    setNotesOpen(false);
    setCheckOpen(false);
    setPeek(null);
    setScenePeek(null);
    setEditingChapter(selected.id); // on a phone, open the chapter for writing
    setFocus(true);
    const root = document.documentElement;
    if (!document.fullscreenElement && root.requestFullscreen) {
      root.requestFullscreen({ navigationUI: "hide" }).then(
        () => { focusFullscreen.current = true; },
        () => {}, // Not allowed here (iOS Safari, an embedded frame): focus mode works in the window.
      );
    }
  };
  const leaveFocus = useCallback(() => {
    setFocus(false);
    if (focusFullscreen.current && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    focusFullscreen.current = false;
  }, []);
  useEffect(() => {
    if (!focus) return;
    // Escape in full screen is taken by the browser, so follow it out of full screen.
    const onFullscreen = () => {
      if (!document.fullscreenElement && focusFullscreen.current) {
        focusFullscreen.current = false;
        setFocus(false);
      }
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    const release = keepAwake();
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreen);
      release();
    };
  }, [focus]);
  // Only the chapter editor has a focus mode.
  useEffect(() => {
    if (focus && (view !== "write" || (detail && !selected))) leaveFocus();
  }, [focus, view, detail, selected, leaveFocus]);
  const enterFocusRef = useRef(enterFocus);
  enterFocusRef.current = enterFocus;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isFocusShortcut(e)) {
        e.preventDefault();
        if (focus) leaveFocus();
        else enterFocusRef.current();
        return;
      }
      // Leave on Escape, unless something on the page (a menu, a link peek) used it first.
      if (focus && e.key === "Escape" && !e.defaultPrevented && peek === null && scenePeek === null) leaveFocus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus, leaveFocus, peek, scenePeek]);
  // The foot bar shows while the mouse moves and fades once writing resumes.
  const [stirred, setStirred] = useState(false);
  useEffect(() => {
    if (!focus) return;
    let timer = 0;
    let shown = false;
    const show = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" && e.type === "pointermove") return;
      window.clearTimeout(timer);
      if (!shown) { shown = true; setStirred(true); }
      timer = window.setTimeout(() => { shown = false; setStirred(false); }, 2500);
    };
    const hide = (e: KeyboardEvent) => {
      if (!shown || e.metaKey || e.ctrlKey || e.altKey || e.key === "Tab" || e.key === "Shift") return;
      window.clearTimeout(timer);
      shown = false;
      setStirred(false);
    };
    window.addEventListener("pointermove", show);
    window.addEventListener("pointerdown", show);
    window.addEventListener("keydown", hide);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", show);
      window.removeEventListener("pointerdown", show);
      window.removeEventListener("keydown", hide);
      setStirred(false);
    };
  }, [focus]);

  const addChapter = async () => {
    try {
      const ch = await api.createChapter(projectId, `Chapter ${chapters.length + 1}`);
      setDetail((d) => (d ? { ...d, chapters: [...d.chapters, ch] } : d));
      select(ch.id);
    } catch (e) {
      alert(describeError(e));
    }
  };

  /**
   * Put the book in this order, with chapters in these acts and the acts in
   * this order. Each act's chapters are kept together, as the server does.
   */
  const arrange = async (
    chapterIds: string[],
    chapterActs: Record<string, string | null>,
    actIds: string[] = acts.map((a) => a.id),
  ) => {
    if (!detail) return;
    const nextActs = actIds.map((id, i) => ({ ...acts.find((a) => a.id === id)!, position: i }));
    const next = arrangeChapters(
      chapterIds.map((id, i) => {
        const c = chapters.find((x) => x.id === id)!;
        return { ...c, act_id: id in chapterActs ? chapterActs[id] : (c.act_id ?? null), position: i };
      }),
      nextActs,
    );
    setDetail((d) => (d ? { ...d, chapters: next, acts: nextActs } : d));
    try {
      await api.reorder(
        projectId,
        next.map((c) => c.id),
        acts.length ? { actIds, chapterActs: Object.fromEntries(next.map((c) => [c.id, c.act_id])) } : undefined,
      );
    } catch (e) {
      alert(describeError(e));
      load();
    }
  };

  // On the corkboard a moved card joins the act of the card it was dropped on.
  const reorderFromBoard = (ids: string[], movedId: string, overId: string) => {
    const over = chapters.find((c) => c.id === overId);
    void arrange(ids, { [movedId]: over?.act_id ?? null });
  };

  // The server's word on acts and chapter order, keeping what this page knows
  // about each chapter's text.
  const applyOutline = (o: Outline) =>
    setDetail((d) => {
      if (!d) return d;
      const local = new Map(d.chapters.map((c) => [c.id, c]));
      return {
        ...d,
        acts: o.acts,
        chapters: o.chapters.map((c) => {
          const mine = local.get(c.id);
          return mine ? { ...mine, position: c.position, act_id: c.act_id } : c;
        }),
      };
    });

  const startAct = async (chapterId: string | null) => {
    try {
      const o = await api.createAct(projectId, undefined, chapterId);
      const known = new Set(acts.map((a) => a.id));
      applyOutline(o);
      setRenamingActId(o.acts.find((a) => !known.has(a.id))?.id ?? null);
    } catch (e) {
      alert(describeError(e));
    }
  };

  // Stable for the memoized chapter rows, while always calling the latest startAct.
  const startActRef = useRef(startAct);
  startActRef.current = startAct;
  const onStartAct = useCallback((id: string) => void startActRef.current(id), []);

  // The first act takes the whole book; later ones start empty at the end.
  const addAct = () => void startAct(acts.length === 0 && chapters.length ? chapters[0].id : null);

  const renameAct = async (id: string, title: string) => {
    setDetail((d) => (d ? { ...d, acts: (d.acts ?? []).map((a) => (a.id === id ? { ...a, title } : a)) } : d));
    try {
      await api.renameAct(id, title);
    } catch (e) {
      alert(describeError(e));
      load();
    }
  };

  const moveAct = (id: string, by: -1 | 1) => {
    const ids = acts.map((a) => a.id);
    const from = ids.indexOf(id);
    const to = from + by;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    void arrange(chapters.map((c) => c.id), {}, ids);
  };

  const removeAct = async (act: Act) => {
    if (!confirm(`Remove the act “${act.title}”? Its chapters stay where they are in the book.`)) return;
    try {
      applyOutline(await api.deleteAct(act.id));
    } catch (e) {
      alert(describeError(e));
      load();
    }
  };

  const rename = useCallback(async (id: string, title: string) => {
    setDetail((d) =>
      d ? { ...d, chapters: d.chapters.map((c) => (c.id === id ? { ...c, title } : c)) } : d,
    );
    try {
      await api.updateChapter(id, { title });
    } catch (e) {
      alert(describeError(e));
      load();
    }
  }, [load]);

  const setChapterStatus = async (id: string, revision_status: import("../../shared/types").ChapterRevisionStatus) => {
    try {
      const updated = await api.updateChapter(id, { revision_status });
      setDetail((d) => d ? { ...d, chapters: d.chapters.map((c) => c.id === id ? { ...c, revision_status: updated.revision_status } : c) } : d);
      await cache.setChapterStatus(projectId, id, updated.revision_status);
    } catch (e) {
      alert(describeError(e));
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

  // The dialect belongs to the novel, so every device checks it the same way.
  const changeDialect = async (next: Dialect) => {
    if (!detail || next === dialect) return;
    setDetail((d) => (d ? { ...d, project: { ...d.project, dialect: next } } : d));
    try {
      await api.setDialect(projectId, next);
    } catch (e) {
      alert(describeError(e));
      load();
    }
  };

  const openFromBoard = (id: string) => {
    setView("write");
    select(id);
  };

  const reloadScenes = async () => {
    const listing = await api.scenes(projectId);
    setScenes(listing.scenes);
    setPlaceholders(listing.placeholders);
  };

  const openScene = (scene: SceneMeta) => {
    if (!scene.chapter_id || scene.passage_index === null) return;
    const chapter = scene.chapter_id;
    const index = scene.passage_index;
    setView("write");
    select(chapter);
    const start = Date.now();
    const attempt = () => {
      if (editorControls.current?.revealScene(index)) return;
      if (Date.now() - start < 4000) window.setTimeout(attempt, 120);
    };
    window.setTimeout(attempt, 150);
  };

  const addScene = async (chapterId: string | null): Promise<SceneMeta | null> => {
    try {
      const scene = await api.createScene(projectId, chapterId);
      setScenes((list) => [...(list ?? []), scene]);
      return scene;
    } catch (e) {
      alert(describeError(e));
      return null;
    }
  };

  const updateScene = async (
    scene: SceneMeta,
    patch: Partial<Pick<SceneMeta, "title" | "summary" | "pov" | "location" | "status" | "chapter_id">> & {
      link?: { passage_index: number }; unlink?: true; confirm?: true;
    },
  ) => {
    try {
      await api.updateScene(scene.id, patch);
      await reloadScenes();
    } catch (e) {
      alert(describeError(e));
      throw e;
    }
  };

  const deleteScene = async (scene: SceneMeta) => {
    if (!confirm(`Delete the scene plan “${scene.title}”?`)) return;
    try {
      await api.deleteScene(scene.id);
      await reloadScenes();
    } catch (e) {
      alert(describeError(e));
    }
  };

  const reorderScenes = async (chapterId: string | null, sceneIds: string[], movedId: string) => {
    if (sceneMoveBusy.current) return;
    const group = (scenes ?? []).filter((scene) => scene.chapter_id === chapterId).sort((a, b) => a.position - b.position);
    const chapter = chapters.find((c) => c.id === chapterId);
    const moved = group.find((scene) => scene.id === movedId);
    if (offline || disconnected || !moved) return;
    sceneMoveBusy.current = true;
    setMovingScene(true);
    try {
      if (chapter && group.some((scene) => scene.in_text)) {
        const result = await arrangeChapterScenes(chapter, sceneIds, { projectId, sceneIds: group.map((scene) => scene.id) });
        onSaved(chapter.id, result);
        setLive((current) => ({ ...current, [chapter.id]: result.word_count }));
        const cached = await cache.project(projectId);
        if (cached) await cache.setProject({ ...cached, chapters: cached.chapters.map((c) => c.id === chapter.id ? { ...c, ...result } : c) });
        setSceneMove({ kind: "arrange", chapter, sceneIds: group.map((scene) => scene.id), expectedIds: sceneIds, title: moved.title });
      } else {
        await api.reorderScenes(projectId, chapterId, sceneIds);
        setSceneMove(null);
      }
      await reloadScenes();
    } catch (e) {
      alert(e instanceof SceneMoveError ? e.message : describeError(e));
      await reloadScenes().catch((error) => setScenesError(describeError(error)));
    } finally {
      sceneMoveBusy.current = false;
      setMovingScene(false);
    }
  };

  const updateMovedChapters = async (from: ChapterMeta, to: ChapterMeta, result: Awaited<ReturnType<typeof moveSceneBetweenChapters>>) => {
    const updates = new Map([[from.id, result.from], [to.id, result.to]]);
    const apply = (chapter: ChapterMeta) => {
      const update = updates.get(chapter.id);
      return update && chapter.version <= update.version ? { ...chapter, ...update } : chapter;
    };
    setDetail((current) => current ? { ...current, chapters: current.chapters.map(apply) } : current);
    setLive((current) => ({ ...current, [from.id]: result.from.word_count, [to.id]: result.to.word_count }));
    const cached = await cache.project(projectId);
    if (cached) await cache.setProject({ ...cached, chapters: cached.chapters.map(apply) });
  };

  const moveAcrossChapters = async (scene: SceneMeta, chapterId: string, beforePassageIndex: number | null) => {
    const from = chapters.find((chapter) => chapter.id === scene.chapter_id);
    const to = chapters.find((chapter) => chapter.id === chapterId);
    if (sceneMoveBusy.current || offline || disconnected || !from || !to) return;
    sceneMoveBusy.current = true;
    setMovingScene(true);
    setSceneMove(null);
    try {
      const result = await moveSceneBetweenChapters(scene.id, from, to, beforePassageIndex);
      setSceneMove({ kind: "across", from, to, sceneId: scene.id, passageIndex: result.from_passage_index, sourceVersion: result.from.version, title: scene.title });
      await updateMovedChapters(from, to, result);
      await reloadScenes();
    } catch (e) {
      alert(e instanceof SceneMoveError ? e.message : describeError(e));
      load();
      await reloadScenes().catch((error) => setScenesError(describeError(error)));
    } finally {
      sceneMoveBusy.current = false;
      setMovingScene(false);
    }
  };

  const undoSceneMove = async () => {
    if (!sceneMove || sceneMoveBusy.current || offline || disconnected) return;
    sceneMoveBusy.current = true;
    setMovingScene(true);
    try {
      if (sceneMove.kind === "across") {
        const result = await moveSceneBetweenChapters(sceneMove.sceneId, sceneMove.to, sceneMove.from, sceneMove.passageIndex, {
          projectId, destinationVersion: sceneMove.sourceVersion,
        });
        await updateMovedChapters(sceneMove.to, sceneMove.from, result);
      } else {
        const result = await arrangeChapterScenes(sceneMove.chapter, sceneMove.sceneIds, { projectId, sceneIds: sceneMove.expectedIds });
        onSaved(sceneMove.chapter.id, result);
        setLive((current) => ({ ...current, [sceneMove.chapter.id]: result.word_count }));
        const cached = await cache.project(projectId);
        if (cached) await cache.setProject({ ...cached, chapters: cached.chapters.map((c) => c.id === sceneMove.chapter.id ? { ...c, ...result } : c) });
      }
      setSceneMove(null);
      await reloadScenes();
    } catch (e) {
      alert(e instanceof SceneMoveError ? e.message : describeError(e));
      load();
      await reloadScenes().catch((error) => setScenesError(describeError(error)));
    } finally {
      sceneMoveBusy.current = false;
      setMovingScene(false);
    }
  };
  const remove = useCallback(async (c: ChapterMeta) => {
    if (chapters.length === 1) {
      alert("A novel needs at least one chapter.");
      return;
    }
    if (!confirm(`Delete “${c.title}”? It moves to Recently deleted under the chapter list, where you can restore it.`)) return;
    try {
      await api.deleteChapter(c.id);
      setTrash((t) => [{ id: c.id, title: c.title, word_count: wordsForRef.current(c), deleted_at: new Date().toISOString() }, ...t]);
      const idx = chapters.findIndex((x) => x.id === c.id);
      const rest = chapters.filter((x) => x.id !== c.id);
      setDetail((d) => (d ? { ...d, chapters: rest } : d));
      if (detail) void cache.setProject({ ...detail, chapters: rest });
      if (c.id === selected?.id) navigate(projectId, rest[Math.max(0, idx - 1)].id, true);
    } catch (e) {
      alert(describeError(e));
    }
  }, [chapters, detail, load, projectId, selected?.id]);

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

  const viewButtons = VIEW_LABELS.map(([v, label]) => (
    <button
      key={v}
      className={`btn btn-quiet${view === v ? " is-on" : ""}`}
      aria-pressed={view === v}
      onClick={() => setView(v)}
    >
      {label}
    </button>
  ));
  const searchButton = (
    <button
      className={`btn btn-quiet${view === "search" ? " is-on" : ""}`}
      aria-pressed={view === "search"}
      onClick={openSearch}
    >
      Search
    </button>
  );

  const focusButton = view === "write" && selected && (
    <button className="btn btn-quiet" title="Hide everything but the page (Ctrl+Alt+F)" onClick={enterFocus}>
      Focus
    </button>
  );
  // A save problem keeps the foot bar in view: focus mode must never hide that writing isn't safe.
  const saveTrouble = save.state === "error" || save.state === "conflict" || save.state === "offline" || save.state === "signedout";

  return (
    <div className={`workspace${drawerOpen ? " drawer-open" : ""}${focus ? " focus-mode" : ""}${focus && typewriterOn ? " typewriter" : ""}${focus && !stirred ? " focus-calm" : ""}`}>
      <aside id="novel-sidebar" ref={sidebarRef} className="sidebar" aria-label="Novel" role={drawerOpen ? "dialog" : undefined} aria-modal={drawerOpen || undefined}>
        <div className="sidebar-head">
          <button className="home-link" onClick={() => navigate()}>
            <LanternMark /> Lantern
          </button>
          <button ref={drawerCloseRef} className="btn btn-quiet drawer-close" onClick={closeDrawer}>
            Close
          </button>
        </div>

        {renamingTitle ? (
          <input
            className="book-title-input"
            defaultValue={detail.project.title}
            autoFocus
            aria-label="Novel title"
            onBlur={(e) => renameProject(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                renameProject(e.currentTarget.value);
                requestAnimationFrame(() => renameProjectRef.current?.focus());
              }
              if (e.key === "Escape") {
                e.stopPropagation();
                setRenamingTitle(false);
                requestAnimationFrame(() => renameProjectRef.current?.focus());
              }
            }}
          />
        ) : (
          <div className="book-title-row">
            <h2 className="book-title" onDoubleClick={() => setRenamingTitle(true)} title="Double-click to rename">
              {detail.project.title}
            </h2>
            <button ref={renameProjectRef} className="icon-btn book-title-edit" aria-label="Rename novel" onClick={() => setRenamingTitle(true)}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.5 2.5l2 2L6 12l-3 1 1-3z" /></svg>
            </button>
          </div>
        )}
        {offline && <p className="offline-note">Offline. Writing is kept on this device and saves when you reconnect.</p>}
        <p className="book-count">{bookWords.toLocaleString()} words in {chapters.length} {chapters.length === 1 ? "chapter" : "chapters"}</p>
        <TargetMeter
          project={detail.project}
          words={bookWords}
          onChange={(t) => setDetail((d) => (d ? { ...d, project: { ...d.project, ...t } } : d))}
        />
        {milestones[0] && <p className="book-count">
          Since {milestones[0].name}: {bookWords - milestones[0].word_count >= 0 ? "+" : ""}
          {(bookWords - milestones[0].word_count).toLocaleString()} words
        </p>}

        <ChapterList
          chapters={chapters}
          acts={acts}
          wordsFor={wordsFor}
          selectedId={selected?.id}
          onSelect={select}
          onArrange={(ids, chapterActs) => void arrange(ids, chapterActs)}
          onRename={rename}
          onDelete={remove}
          onStartAct={onStartAct}
          onStatus={(id, value) => void setChapterStatus(id, value)}
          offline={offline || disconnected}
          onRenameAct={(id, title) => void renameAct(id, title)}
          onMoveAct={moveAct}
          onDeleteAct={(act) => void removeAct(act)}
          renamingActId={renamingActId}
          onRenamingActDone={() => setRenamingActId(null)}
        />

        <div className="add-row">
          <button className="add-chapter" onClick={addChapter}>
            Add chapter
          </button>
          <button
            className="add-chapter"
            onClick={addAct}
            disabled={offline}
            title={acts.length ? "Add an empty act at the end" : "Group the chapters into acts"}
          >
            Add act
          </button>
        </div>

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

      <button className="scrim" aria-label="Close chapters" onClick={closeDrawer} tabIndex={-1} />

      <main className="desk" inert={drawerOpen}>
        <header className="desk-bar">
          <button ref={drawerToggleRef} className="btn btn-quiet drawer-toggle" aria-controls="novel-sidebar" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}>
            Chapters
          </button>
          {!phone && <div className="view-switch" role="group" aria-label="View">{viewButtons}</div>}
          {phone && view === "write" && selected && (
            <button
              className={`btn${readOnly ? " btn-quiet" : " btn-lamp"}`}
              disabled={save.state === "loading"}
              aria-pressed={!readOnly}
              onClick={() => setEditingChapter(readOnly ? selected.id : null)}
            >
              {readOnly ? "Edit" : "Done"}
            </button>
          )}
          <span className="desk-spacer" />
          <div className="desk-actions">
            {!phone && searchButton}
            {!phone && focusButton}
            <details className="desk-more" ref={moreMenuRef}>
              <summary className={`btn btn-quiet${historyOpen || checkOpen || grammarOn ? " is-on" : ""}${unseenChanges > 0 ? " has-news" : ""}`}>
                More
                {unseenChanges > 0 && <span className="visually-hidden"> ({unseenChanges} new AI changes)</span>}
              </summary>
              <div className="desk-more-menu">
                {phone && (
                  <>
                    <div role="group" aria-label="View">{viewButtons}</div>
                    {searchButton}
                    {focusButton}
                    <ThemePicker />
                    <span className="desk-more-divider" />
                  </>
                )}
                {narrow && !phone && (
                  <>
                    <ThemePicker />
                    <span className="desk-more-divider" />
                  </>
                )}
                <button
                  className="btn btn-quiet"
                  onClick={() => {
                    closeMoreMenu();
                    setMilestonesOpen(true);
                    void refreshMilestones().catch(() => {});
                  }}
                >
                  Milestones
                </button>
                <button
                  className="btn btn-quiet"
                  onClick={() => {
                    closeMoreMenu();
                    setExportOpen(true);
                  }}
                >
                  Export
                </button>
                {!offline && (
                  <button
                    className="btn btn-quiet"
                    onClick={() => {
                      closeMoreMenu();
                      setShareOpen(true);
                    }}
                  >
                    Share
                  </button>
                )}
                {!offline && (
                  <button
                    className="btn btn-quiet"
                    onClick={() => {
                      closeMoreMenu();
                      setChangesOpen(true);
                    }}
                  >
                    AI changes
                    {unseenChanges > 0 && (
                      <span className="news-count" aria-label={`${unseenChanges} new`}>{unseenChanges}</span>
                    )}
                  </button>
                )}
                {view === "write" && (
                  <>
                    <span className="desk-more-divider" />
                    <button
                      className={`btn btn-quiet history-toggle${historyOpen ? " is-on" : ""}`}
                      aria-pressed={historyOpen}
                      onClick={() => {
                        closeMoreMenu();
                        setPeek(null);
                        setScenePeek(null);
                        setCheckOpen(false);
                        setNotesOpen(false);
                        setHistoryOpen((h) => !h);
                      }}
                    >
                      History
                    </button>
                    <button
                      className={`btn btn-quiet${notesOpen ? " is-on" : ""}`}
                      aria-pressed={notesOpen}
                      disabled={!selected}
                      onClick={() => {
                        closeMoreMenu();
                        setPeek(null);
                        setScenePeek(null);
                        setCheckOpen(false);
                        setHistoryOpen(false);
                        setNotesOpen((open) => !open);
                      }}
                    >
                      Notes
                    </button>
                    <button className="btn btn-quiet" disabled={!selected} onClick={() => {
                      closeMoreMenu();
                      editorControls.current?.addNote?.();
                    }}>
                      Add note
                    </button>
                    <button
                      className={`btn btn-quiet${checkOpen ? " is-on" : ""}`}
                      aria-pressed={checkOpen}
                      title="Check this chapter against the story guide"
                      onClick={() => {
                        closeMoreMenu();
                        setPeek(null);
                        setScenePeek(null);
                        setHistoryOpen(false);
                        setNotesOpen(false);
                        setCheckOpen((c) => !c);
                      }}
                    >
                      Check
                    </button>
                    <span className="desk-more-divider" />
                    <button
                      className={`btn btn-quiet${sceneLabelsOn ? " is-on" : ""}`}
                      aria-pressed={sceneLabelsOn}
                      onClick={() => {
                        closeMoreMenu();
                        setSceneLabelsOn((on) => !on);
                      }}
                    >
                      Scene labels
                    </button>
                    <select
                      className={`theme-picker grammar-picker desk-more-select${grammarOn ? " is-on" : ""}`}
                      aria-label="Grammar checking"
                      title="Underline grammar and spelling problems (checked on this device by Harper)"
                      value={grammarOn ? dialect : "off"}
                      onChange={(e) => {
                        closeMoreMenu();
                        const v = e.target.value;
                        if (v === "off") return setGrammarOn(false);
                        void changeDialect(v as Dialect);
                        setGrammarOn(true);
                      }}
                    >
                      <option value="off">Grammar off</option>
                      {DIALECTS.map((d) => (
                        <option key={d.id} value={d.id}>
                          Grammar: {d.name}
                        </option>
                      ))}
                    </select>
                  </>
                )}
              </div>
            </details>
            {!narrow && <ThemePicker />}
          </div>
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
            acts={acts}
            scenes={scenes ?? []}
            wordsFor={wordsFor}
            selectedId={selected?.id}
            onOpen={openFromBoard}
            onReorder={reorderFromBoard}
            onSynopsis={setSynopsis}
            onStatus={(id, value) => void setChapterStatus(id, value)}
            offline={offline || disconnected}
            onAdd={addChapter}
          />
        ) : view === "scenes" ? (
          scenesError ? (
            <div className="screen-message" role="alert">
              <p>Scene plans didn't load.</p>
              <p className="screen-message-detail">{scenesError}</p>
            </div>
          ) : scenes ? (
            <>
            {sceneMove && <p className="check-notice" role="status">Moved {sceneMove.title}{sceneMove.kind === "across" ? ` to ${sceneMove.to.title}` : ""}.{" "}
              <button className="btn btn-quiet" disabled={movingScene || offline || disconnected} onClick={() => void undoSceneMove()}>Undo</button>
            </p>}
            <SceneBoard
              chapters={chapters}
              acts={acts}
              scenes={scenes}
              placeholders={placeholders}
              projectId={projectId}
              offline={offline || disconnected}
              moving={movingScene}
              onAdd={addScene}
              onUpdate={updateScene}
              onDelete={(scene) => void deleteScene(scene)}
              onMove={(chapterId, sceneIds, movedId) => void reorderScenes(chapterId, sceneIds, movedId)}
              onMoveAcross={(scene, chapterId, beforePassageIndex) => void moveAcrossChapters(scene, chapterId, beforePassageIndex)}
              onOpen={openScene}
            />
            </>
          ) : <div className="screen-message">Loading scene plans…</div>
        ) : view === "search" ? (
          <SearchPanel
            chapters={chapters}
            currentChapter={searchText}
            onReplaced={(id, info, content) => {
              onSaved(id, info, true);
              setLive((current) => ({ ...current, [id]: info.word_count }));
              setSearchText((current) => current?.id === id ? { ...current, content, version: info.version } : current);
            }}
            onOpen={(id, quote) => {
              setView("write");
              void openQuote(id, quote);
            }}
          />
        ) : selected && (
          <ChapterEditor
            key={selected.id}
            chapterId={selected.id}
            title={selected.title}
            knownVersion={selected.version}
            onWords={onWords}
            onSaved={onSaved}
            onStatus={onStatus}
            historyOpen={historyOpen}
            onCloseHistory={closeHistory}
            notesOpen={notesOpen}
            offline={offline || disconnected}
            onOpenNotes={() => {
              setHistoryOpen(false);
              setCheckOpen(false);
              setPeek(null);
              setScenePeek(null);
              setNotesOpen(true);
            }}
            onCloseNotes={() => setNotesOpen(false)}
            entries={entries}
            onOpenLink={openLink}
            scenes={labelSnapshot?.chapterId === selected.id ? labelSnapshot.scenes : null}
            sceneBaseline={labelSnapshot?.chapterId === selected.id ? labelSnapshot.baseline : null}
            sceneLabelsOn={sceneLabelsOn && !focus}
            onOpenScene={(scene) => {
              setHistoryOpen(false);
              setNotesOpen(false);
              setCheckOpen(false);
              setPeek(null);
              setScenePeek(scene.id);
            }}
            grammarOn={grammarOn}
            dialect={dialect}
            readOnly={readOnly && !focus}
            typewriter={focus && typewriterOn}
            dimming={focus && dimmingOn}
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

        {view === "write" && scenePeek !== null && (() => {
          const scene = scenes?.find((item) => item.id === scenePeek);
          if (!scene) return null;
          return (
            <aside className="history peek" aria-label={`Scene: ${scene.title}`}>
              <header className="history-head">
                <h2 className="history-title">Scene</h2>
                <span className="desk-spacer" />
                <button className="icon-btn" aria-label="Close" title="Close" onClick={() => setScenePeek(null)}>
                  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
                </button>
              </header>
              <div className="history-body">
                <h3 className="peek-name">{scene.title}</h3>
                {(scene.pov || scene.location) && <p className="peek-aka">{[scene.pov, scene.location].filter(Boolean).join(" · ")}</p>}
                <div className="peek-body">{scene.summary.trim() || <span className="peek-empty">No notes yet.</span>}</div>
                <button className="btn btn-lamp" onClick={() => setView("scenes")}>Open Scenes</button>
              </div>
            </aside>
          );
        })()}

        {exportOpen && <ExportDialog detail={detail} onClose={() => setExportOpen(false)} />}
        {milestonesOpen && <MilestonesDialog
          milestones={milestones}
          loadError={milestonesError}
          onCreate={async (name, note) => {
            const active = view === "write" && selected ? {
              id: selected.id,
              save: async () => {
                if (!editorControls.current?.saveForMilestone || save.state === "loading") {
                  throw new Error("Wait for this chapter to finish opening, then try again.");
                }
                await editorControls.current.saveForMilestone();
              },
            } : null;
            await createMilestone(projectId, name, note, active);
            await refreshMilestones();
          }}
          onChanged={refreshMilestones}
          onCompare={(milestone) => {
            const text = view === "write" && selected && save.state !== "loading" && save.state !== "error"
              ? editorControls.current?.text() : undefined;
            setComparison({ milestone, activeText: text !== undefined && selected ? { id: selected.id, text } : null });
            setMilestonesOpen(false);
          }}
          onExport={(milestone) => { setMilestonesOpen(false); setMilestoneExport(milestone); }}
          onClose={() => setMilestonesOpen(false)}
        />}
        {milestoneExport && <ExportDialog detail={detail} milestone={milestoneExport} onClose={() => setMilestoneExport(null)} />}
        {comparison && <MilestoneComparison
          milestone={comparison.milestone}
          detail={detail}
          activeText={comparison.activeText}
          onClose={() => setComparison(null)}
          onRestore={async (chapter, oldId, title, text, expected) => {
            if (typeof navigator !== "undefined" && !navigator.onLine) throw new Error("Restoring a chapter needs a connection. Reconnect and try again.");
            if (chapter && comparison.activeText?.id === chapter.id) {
              const controls = editorControls.current;
              if (!controls?.saveForMilestone || !controls.restore) throw new Error("Open this chapter and save it first.");
              await controls.saveForMilestone();
              if (controls.text() !== expected) throw new Error("This chapter changed while you were comparing. Close and compare again.");
              await controls.restore(text);
              await controls.saveForMilestone();
              return;
            }
            const key = `${comparison.milestone.id}:${oldId}`;
            let target = chapter ?? addedMilestoneChapters.current.get(key);
            if (!target) {
              target = await api.createChapter(projectId, title);
              addedMilestoneChapters.current.set(key, target);
            }
            try {
              const current = await flushForSceneMove(target);
              if (chapter && current.content !== expected) throw new Error("This chapter changed while you were comparing. Close and compare again.");
              if (!chapter && current.content === text) {
                addedMilestoneChapters.current.delete(key);
                return;
              }
              if (!chapter && current.content !== "") throw new Error(`The new chapter “${title}” has changed. Open it before trying again.`);
              await forgetChapter(target.id);
              await api.saveChapter(target.id, text, current.version, { snapshot: "restore" });
              addedMilestoneChapters.current.delete(key);
            } catch (error) {
              if (!chapter) throw new Error(`The new chapter “${title}” was created but couldn't be filled. Try again or open it in your novel. ${error instanceof Error ? error.message : ""}`);
              throw error;
            } finally {
              await forgetChapter(target.id);
              load();
            }
          }}
        />}
        {changesOpen && (
          <ClaudeChangesDialog
            projectId={projectId}
            chapterIds={new Set(chapters.map((c) => c.id))}
            entryIds={new Set(entries.map((e) => e.id))}
            onOpenChapter={(id, withHistory) => {
              setChangesOpen(false);
              openFromBoard(id);
              if (withHistory) setHistoryOpen(true);
            }}
            onOpenEntry={(id) => {
              setChangesOpen(false);
              setEntryId(id);
              setView("bible");
            }}
            onOpenScenes={() => {
              setChangesOpen(false);
              setView("scenes");
            }}
            onSeen={markSeen}
            onClose={() => setChangesOpen(false)}
          />
        )}
        {shareOpen && (
          <ShareDialog
            projectId={projectId}
            projectTitle={detail.project.title}
            onClose={() => setShareOpen(false)}
          />
        )}

        {focus && selected && (
          <footer className={`focus-bar${stirred || saveTrouble ? " is-shown" : ""}`} aria-label="Focus mode">
            <span className={`save-state save-${save.state}`} title={save.detail} aria-live="polite">
              {save.state === "error" && save.detail ? `Not saved: ${save.detail}` : STATUS_TEXT[save.state]}
            </span>
            <span className="focus-count">
              {wordsFor(selected).toLocaleString()} words
              {sessionWords > 0 && <span className="session"> · +{sessionWords.toLocaleString()} this session</span>}
              {today?.goal && <> · {Math.max(0, today.words).toLocaleString()} / {today.goal.toLocaleString()} today</>}
            </span>
            <span className="desk-spacer" />
            <button
              className={`btn btn-quiet${dimmingOn ? " is-on" : ""}`}
              aria-pressed={dimmingOn}
              title="Dim every paragraph but the one you're writing"
              onClick={() => setDimmingOn((on) => !on)}
            >
              Dim
            </button>
            <button
              className={`btn btn-quiet${typewriterOn ? " is-on" : ""}`}
              aria-pressed={typewriterOn}
              title="Keep the line you're writing in the middle of the screen"
              onClick={() => setTypewriterOn((on) => !on)}
            >
              Typewriter
            </button>
            <button className="btn btn-quiet" title="Leave focus mode (Esc)" onClick={leaveFocus}>
              Leave focus
            </button>
          </footer>
        )}

        <footer className="desk-status" aria-live="polite">
          {/* Only the chapter editor reports here; other views show their own save state. */}
          {view === "write" && selected && (
            <span className={`save-state save-${save.state}`} title={save.detail}>
              {save.state === "error" && save.detail ? `Not saved: ${save.detail}` : STATUS_TEXT[save.state]}
            </span>
          )}
          <span className="desk-spacer" />
          {view !== "write" ? (
            <span>{bookWords.toLocaleString()} words in the book</span>
          ) : (
            selected && <span>{wordsFor(selected).toLocaleString()} words</span>
          )}
          {!phone && sessionWords > 0 && <span className="session">+{sessionWords.toLocaleString()} this session</span>}
          {!phone && today?.goal && (
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
