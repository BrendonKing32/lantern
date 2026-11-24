import { useCallback, useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { Compartment, EditorSelection, EditorState } from "@codemirror/state";
import { api, ApiError, describeError } from "../api";
import { drafts } from "../local";
import { isNetworkError, loadChapter, moveRetryDelay, openEditors, rememberSaved } from "../sync";
import { HistoryPanel } from "./HistoryPanel";
import { ClaudeDraftPanel } from "./ClaudeDraftPanel";
import { basicSetup, proseExtensions } from "../editorSetup";
import { entriesChanged, wikilinks } from "../wikilinkEditor";
import { grammar, recheckGrammar } from "../grammar";
import { countWords } from "../../shared/wordcount";
import { replayDraft } from "../../shared/draftReplay";
import { splitScenes } from "../../shared/scenes";
import { sceneBreakKeymap, sceneLabels } from "../sceneLabels";
import { minimalChange } from "../minimalChange";
import { findAnchor, makeAnchor, type TextAnchor } from "../../shared/anchors";
import { noteDecorations, notesChanged } from "../noteDecorations";
import { NoteLoadGate } from "../noteLoad";
import { NotesPanel } from "./NotesPanel";
import type { BibleEntry, ChapterWithContent, Dialect, MarginNote, SaveResult, SceneMeta } from "../../shared/types";
import type { ClaudeDraft } from "../../shared/types";

export type SaveState =
  | "loading"
  | "saved"
  | "editing"
  | "saving"
  | "offline"
  | "conflict"
  | "signedout"
  | "error";

interface Props {
  chapterId: string;
  title: string;
  knownVersion: number;
  /**
   * Word count changes. `initial` marks the count as of opening the chapter;
   * `notWritten` is how many of the words changed without the writer typing them.
   */
  onWords: (chapterId: string, words: number, initial: boolean, notWritten?: number) => void;
  onSaved: (chapterId: string, info: SaveResult, replaced?: boolean) => void;
  onStatus: (state: SaveState, detail?: string) => void;
  historyOpen: boolean;
  notesOpen: boolean;
  onOpenNotes: () => void;
  onCloseNotes: () => void;
  offline: boolean;
  /** Story guide entries, for [[links]]. */
  entries: BibleEntry[];
  onOpenLink: (name: string) => void;
  scenes: SceneMeta[] | null;
  sceneBaseline: string | null;
  sceneLabelsOn: boolean;
  onOpenScene: (scene: SceneMeta) => void;
  /** Check grammar and spelling with Harper (otherwise the browser's spellcheck is used). */
  grammarOn: boolean;
  /** The English the novel is written in. */
  dialect: Dialect;
  readOnly: boolean;
  onCloseHistory: () => void;
  /** Filled in by the editor so other panels can read the text and point into it. */
  controls?: { current: EditorControls | null };
}

export interface EditorControls {
  /** The text on screen, unsaved writing included. */
  text: () => string;
  /** Select and scroll to a quoted passage. False if it isn't in the chapter. */
  reveal: (quote: string) => boolean;
  revealScene: (index: number) => boolean;
  addNote?: () => void;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where a quote sits in the text: exactly, ignoring spacing and case, or by its opening words. */
function locate(doc: string, quote: string): [number, number] | null {
  const q = quote.trim();
  if (!q) return null;
  const exact = doc.indexOf(q);
  if (exact >= 0) return [exact, exact + q.length];
  const words = q.split(/\s+/).map(escapeRe);
  const loose = new RegExp(words.join("\\s+"), "i").exec(doc);
  if (loose) return [loose.index, loose.index + loose[0].length];
  if (words.length <= 3) return null;
  const head = new RegExp(words.slice(0, 6).join("\\s+"), "i").exec(doc);
  return head ? [head.index, head.index + head[0].length] : null;
}

/** How often an open chapter checks for changes saved elsewhere (another device) and for Claude's draft. */
const REFRESH_INTERVAL = 30_000;

const SAVE_DELAY = 1200;
const RETRY_DELAY = 5000;
const WORD_COUNT_DELAY = 150;

export function ChapterEditor({
  chapterId,
  title,
  knownVersion,
  onWords,
  onSaved,
  onStatus,
  historyOpen,
  notesOpen,
  onOpenNotes,
  onCloseNotes,
  offline,
  onCloseHistory,
  entries,
  onOpenLink,
  scenes,
  sceneBaseline,
  sceneLabelsOn,
  onOpenScene,
  grammarOn,
  dialect,
  readOnly,
  controls,
}: Props) {
  const [initialDoc, setInitialDoc] = useState<string | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [conflict, setConflict] = useState<ChapterWithContent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [claudeDraft, setClaudeDraft] = useState<ClaudeDraft | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftBusy, setDraftBusy] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [, refreshDraftReview] = useState(0);
  const [notes, setNotes] = useState<MarginNote[]>([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [noteSelectionError, setNoteSelectionError] = useState<string | null>(null);
  const [noteAnchor, setNoteAnchor] = useState<TextAnchor | null>(null);
  const [selectedNote, setSelectedNote] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const noteLoad = useRef(new NoteLoadGate());

  const text = useRef("");
  const version = useRef(0);
  const dirty = useRef(false);
  const inFlight = useRef(false);
  const saveAgain = useRef(false);
  const draftStorageFailed = useRef(false);
  const blocked = useRef(false); // true while a conflict waits for a decision
  const timer = useRef<number | undefined>(undefined);
  const wordCountTimer = useRef<number | undefined>(undefined);
  const alive = useRef(true);
  const applyingRemote = useRef(false); // set while text saved elsewhere is put on screen
  const refreshing = useRef(false);

  // [[links]]: the extension reads the latest entries and click handler from
  // refs, so it's built once and the editor never has to be recreated.
  const linkHost = useRef({ entries, onOpenLink });
  linkHost.current = { entries, onOpenLink };
  const view = useRef<EditorView | null>(null);
  const noteHost = useRef({
    notes,
    add: () => {},
    open: (_id: string) => {},
    changed: (_text: string) => {},
  });
  noteHost.current = {
    notes,
    add: () => {
      onOpenNotes();
      setDraftOpen(false);
      setSelectedNote(null);
      setNoteAnchor(null);
      setNoteSelectionError(null);
      const editor = view.current;
      const selection = editor?.state.selection.main;
      if (!editor || !selection || selection.empty) {
        setNoteSelectionError("Select a passage in the chapter, then choose Add note.");
      } else if (selection.to - selection.from > 2000) {
        setNoteSelectionError("Select a passage of 2,000 characters or fewer.");
      } else if (offline) {
        setNoteSelectionError("Notes need a connection. Reconnect and try again.");
      } else {
        setNoteAnchor(makeAnchor(editor.state.doc.toString(), selection.from, selection.to));
      }
    },
    open: (id) => {
      onOpenNotes();
      setDraftOpen(false);
      setNoteSelectionError(null);
      setNoteAnchor(null);
      setSelectedNote(id);
    },
    changed: setNoteText,
  };
  const sceneHost = useRef({ scenes, sceneBaseline, title, onOpenScene });
  sceneHost.current = { scenes, sceneBaseline, title, onOpenScene };
  const sceneSlot = useRef(new Compartment());
  const labelExtensions = () =>
    sceneLabelsOn && sceneHost.current.scenes && sceneHost.current.sceneBaseline !== null
      ? sceneLabels({
          snapshot: () => ({
            baselineText: sceneHost.current.sceneBaseline!,
            chapterTitle: sceneHost.current.title,
            cards: (sceneHost.current.scenes ?? []).filter((scene) => scene.chapter_id === chapterId),
          }),
          open: (scene) => sceneHost.current.onOpenScene(scene),
        })
      : [];
  const readingSlot = useRef(new Compartment());
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const readingMode = (on: boolean) => [
    EditorState.readOnly.of(on),
    EditorView.editable.of(!on),
    EditorView.contentAttributes.of({ "aria-readonly": String(on) }),
  ];
  // Grammar checking sits in a compartment so it can be switched without
  // recreating the editor. The latest setting is read when an editor is made.
  const grammarSlot = useRef(new Compartment());
  const dialectRef = useRef(dialect);
  dialectRef.current = dialect;
  const grammarExt = useRef(grammar({ entries: () => linkHost.current.entries, dialect: () => dialectRef.current }));
  const grammarOnRef = useRef(grammarOn);
  grammarOnRef.current = grammarOn;
  const proofing = (on: boolean) =>
    on
      ? [grammarExt.current, EditorView.contentAttributes.of({ spellcheck: "false" })]
      : EditorView.contentAttributes.of({ spellcheck: "true" });
  const [extensions] = useState(() => [
    ...proseExtensions,
    wikilinks({ entries: () => linkHost.current.entries, open: (n) => linkHost.current.onOpenLink(n) }),
    sceneBreakKeymap,
    noteDecorations({
      notes: () => noteHost.current.notes,
      add: () => noteHost.current.add(),
      open: (id) => noteHost.current.open(id),
      changed: (content) => noteHost.current.changed(content),
    }),
    sceneSlot.current.of([]),
    grammarSlot.current.of(proofing(grammarOnRef.current)),
    readingSlot.current.of(readingMode(readOnlyRef.current)),
  ]);
  useEffect(() => {
    view.current?.dispatch({ effects: notesChanged.of(notes) });
  }, [notes]);
  useEffect(() => {
    if (offline) { setNotesLoading(false); return; }
    let active = true;
    const current = noteLoad.current.start();
    setNotesLoading(true);
    setNotesError(null);
    void Promise.all([api.notes(chapterId, false), api.notes(chapterId, true)]).then(
      ([open, resolved]) => { if (active && current()) setNotes([...open, ...resolved]); },
      (error) => { if (active && current()) setNotesError(isNetworkError(error) ? "Notes need a connection. Reconnect and try again." : describeError(error)); },
    ).finally(() => { if (active && current()) setNotesLoading(false); });
    return () => { active = false; };
  }, [chapterId, offline, notesOpen]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch({ effects: readingSlot.current.reconfigure(readingMode(readOnly)) });
    if (readOnly) {
      if (editor.hasFocus) editor.contentDOM.blur();
    } else {
      editor.focus();
    }
  }, [readOnly]);
  useEffect(() => {
    if (!view.current) return;
    view.current.dispatch({ effects: entriesChanged.of(null) });
    recheckGrammar(view.current); // story guide names aren't misspellings
  }, [entries]);
  useEffect(() => {
    view.current?.dispatch({ effects: sceneSlot.current.reconfigure(labelExtensions()) });
  }, [scenes, sceneBaseline, sceneLabelsOn, title]);
  useEffect(() => {
    view.current?.dispatch({ effects: grammarSlot.current.reconfigure(proofing(grammarOn)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grammarOn]);
  const firstDialect = useRef(dialect);
  useEffect(() => {
    if (dialect === firstDialect.current) return;
    firstDialect.current = dialect;
    if (view.current) recheckGrammar(view.current); // check again in the new dialect
  }, [dialect]);

  useEffect(() => {
    if (!controls) return;
    controls.current = {
      text: () => text.current,
      reveal: (quote) => {
        const v = view.current;
        const at = v && locate(v.state.doc.toString(), quote);
        if (!v || !at) return false;
        v.dispatch({
          selection: EditorSelection.range(at[0], at[1]),
          effects: EditorView.scrollIntoView(at[0], { y: "center" }),
        });
        if (!readOnlyRef.current) v.focus();
        return true;
      },
      revealScene: (index) => {
        const v = view.current;
        if (!v) return false;
        const passage = splitScenes(v.state.doc.toString())[index];
        if (!passage) return false;
        v.dispatch({
          selection: EditorSelection.cursor(passage.start),
          effects: EditorView.scrollIntoView(passage.start, { y: "center" }),
        });
        if (!readOnlyRef.current) v.focus();
        return true;
      },
      addNote: () => noteHost.current.add(),
    };
    return () => {
      controls.current = null;
    };
  }, [controls]);
  // Set when the next save replaces text the writer may want back.
  const keepCopy = useRef<"restore" | "conflict" | undefined>(undefined);

  // Keep the latest callbacks without re-running effects.
  const cb = useRef({ onWords, onSaved, onStatus });
  cb.current = { onWords, onSaved, onStatus };
  const flushWordCount = () => {
    window.clearTimeout(wordCountTimer.current);
    wordCountTimer.current = undefined;
    cb.current.onWords(chapterId, countWords(text.current), false);
  };
  const scheduleWordCount = () => {
    window.clearTimeout(wordCountTimer.current);
    wordCountTimer.current = window.setTimeout(() => {
      wordCountTimer.current = undefined;
      cb.current.onWords(chapterId, countWords(text.current), false);
    }, WORD_COUNT_DELAY);
  };
  const status = (s: SaveState, detail?: string) => {
    if (alive.current) {
      cb.current.onStatus(s, detail);
      refreshDraftReview((n) => n + 1);
    }
  };

  const saveRef = useRef<() => Promise<void>>(async () => {});
  const schedule = useCallback((ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void saveRef.current(), ms);
  }, []);

  const persistDraft = (content: string, baseVersion: number) => {
    void drafts.write(chapterId, content, baseVersion).then(
      () => {
        draftStorageFailed.current = false;
      },
      () => {
        draftStorageFailed.current = true;
        status(
          "error",
          "This draft isn't saved on this device. Keep this page open while Lantern retries the server save.",
        );
        void saveRef.current();
      },
    );
  };

  saveRef.current = async () => {
    if (!dirty.current || blocked.current) return;
    if (inFlight.current) {
      saveAgain.current = true;
      return;
    }
    inFlight.current = true;
    status("saving");
    const content = text.current;
    const replaced = !!keepCopy.current;
    try {
      const res = await api.saveChapter(chapterId, content, version.current, { snapshot: keepCopy.current });
      keepCopy.current = undefined;
      version.current = res.version;
      draftStorageFailed.current = false;
      cb.current.onSaved(chapterId, res, replaced);
      void rememberSaved(chapterId, content, res);
      if (text.current === content) {
        dirty.current = false;
        void drafts.clearIf(chapterId, content);
        status("saved");
      } else {
        persistDraft(text.current, version.current);
        saveAgain.current = true;
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        blocked.current = true;
        status("conflict");
        try {
          const server = await api.getChapter(chapterId);
          if (alive.current) setConflict(server);
        } catch {
          blocked.current = false;
          status("offline");
          schedule(RETRY_DELAY);
        }
      } else if (e instanceof ApiError && e.status === 423) {
        saveAgain.current = false;
        status(draftStorageFailed.current ? "error" : "saving",
          draftStorageFailed.current ? "This draft isn't saved on this device. Keep this page open while Lantern retries." : undefined);
        schedule(moveRetryDelay(e));
      } else if (e instanceof ApiError && e.status === 401) {
        if (draftStorageFailed.current) {
          status("error", `This draft isn't saved on this device. ${describeError(e)}`);
        } else {
          status("signedout");
        }
      } else if (e instanceof ApiError && e.status < 500) {
        status(
          "error",
          draftStorageFailed.current
            ? `This draft isn't saved on this device. ${describeError(e)}`
            : describeError(e),
        );
      } else {
        status(
          draftStorageFailed.current ? "error" : "offline",
          draftStorageFailed.current
            ? `This draft isn't saved on this device. ${describeError(e)}`
            : undefined,
        );
        schedule(RETRY_DELAY);
      }
    } finally {
      inFlight.current = false;
      if (saveAgain.current && !blocked.current) {
        saveAgain.current = false;
        schedule(400);
      }
    }
  };

  // Load the chapter, recovering any unsaved local draft. Offline, the copy on
  // this device stands in for the server's.
  useEffect(() => {
    alive.current = true;
    openEditors.add(chapterId);
    let cancelled = false;
    status("loading");

    void (async () => {
      let draft: Awaited<ReturnType<typeof drafts.read>>;
      try {
        draft = await drafts.read(chapterId);
      } catch {
        if (!cancelled) {
          setLoadError("Lantern couldn't read local drafts on this device. Enable site storage and reload to protect unsaved writing.");
          status("error", "Local draft storage is unavailable.");
        }
        return;
      }
      let ch: ChapterWithContent;
      let offline: boolean;
      try {
        ({ data: ch, offline } = await loadChapter(chapterId));
      } catch (e) {
        if (cancelled) return;
        if (draft && isNetworkError(e)) {
          // Offline with nothing cached but a draft: write on from the draft.
          version.current = draft.baseVersion;
          text.current = draft.content;
          dirty.current = true;
          refreshDraftReview((n) => n + 1);
          setInitialDoc(draft.content);
          cb.current.onWords(chapterId, countWords(draft.content), true);
          status("offline");
          schedule(RETRY_DELAY);
        } else {
          setLoadError(describeError(e));
          status("error", describeError(e));
        }
        return;
      }
      if (cancelled) return;

      if (!offline && ch.version > knownVersion) {
        cb.current.onSaved(chapterId, {
          version: ch.version, word_count: ch.word_count, updated_at: ch.updated_at,
        }, true);
      }
      version.current = ch.version;
      let content = ch.content;
      if (draft && draft.content !== ch.content) {
        content = draft.content;
        dirty.current = true;
        // Saved elsewhere since this draft was written. Offline we can't be
        // sure, so keep writing; the server will flag it on the next save.
        if (draft.baseVersion !== ch.version && !offline) {
          blocked.current = true;
          setConflict(ch);
        } else {
          version.current = draft.baseVersion;
        }
      } else if (draft) {
        void drafts.clearIf(chapterId, draft.content);
      }
      text.current = content;
      setInitialDoc(content);
      cb.current.onWords(chapterId, countWords(ch.content), true);
      if (content !== ch.content) cb.current.onWords(chapterId, countWords(content), false);
      if (blocked.current) status("conflict");
      else if (offline) {
        status("offline");
        if (dirty.current) schedule(RETRY_DELAY);
      } else if (dirty.current) {
        status("editing");
        schedule(300);
      } else status("saved");
    })();

    const warn = (ev: BeforeUnloadEvent) => {
      if (dirty.current) ev.preventDefault();
    };
    window.addEventListener("beforeunload", warn);

    return () => {
      cancelled = true;
      alive.current = false;
      openEditors.delete(chapterId);
      window.clearTimeout(timer.current);
      if (wordCountTimer.current !== undefined) flushWordCount();
      window.removeEventListener("beforeunload", warn);
      // Best-effort flush when switching chapters; the local draft covers failure.
      if (dirty.current && !blocked.current && !inFlight.current) {
        const content = text.current;
        const replaced = !!keepCopy.current;
        api
          .saveChapter(chapterId, content, version.current, { keepalive: true, snapshot: keepCopy.current })
          .then((res) => {
            void drafts.clearIf(chapterId, content);
            void rememberSaved(chapterId, content, res);
            cb.current.onSaved(chapterId, res, replaced);
          })
          .catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId, schedule]);

  // Claude's draft of this chapter, if the connector has made one. It sits
  // beside the chapter and never changes the text on screen by itself.
  const refreshDraft = async () => {
    try {
      const d = await api.claudeDraft(chapterId);
      if (!alive.current) return;
      setClaudeDraft((old) => (old?.version === d?.version && old?.updated_at === d?.updated_at ? old : d));
      if (!d) setDraftOpen(false);
    } catch {
      // Offline or signed out: the next check tries again.
    }
  };

  // Pick up changes saved elsewhere, such as on another device, while nothing
  // on this screen is unsaved. With unsaved writing the next save meets the
  // newer version and asks which to keep, as before.
  const loaded = initialDoc !== null;
  useEffect(() => {
    if (!loaded) return;
    void refreshDraft();
    const quiet = () => !dirty.current && !inFlight.current && !blocked.current;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      void refreshDraft();
      if (refreshing.current || !quiet()) return;
      refreshing.current = true;
      try {
        const server = await api.getChapter(chapterId);
        if (!alive.current || !quiet() || server.version <= version.current) return;
        version.current = server.version;
        if (server.content !== text.current) {
          const v = view.current;
          if (v && v.state.doc.toString() === text.current) {
            // Replace only what changed, so the cursor and scroll stay put;
            // undo takes the change back out like any other edit.
            applyingRemote.current = true;
            try {
              v.dispatch({ changes: minimalChange(text.current, server.content) });
            } finally {
              applyingRemote.current = false;
            }
          } else {
            setInitialDoc(server.content);
            setEditorKey((k) => k + 1);
          }
          text.current = server.content;
          flushWordCount();
        }
        const info = { version: server.version, word_count: server.word_count, updated_at: server.updated_at };
        cb.current.onSaved(chapterId, info, true);
        void rememberSaved(chapterId, server.content, info);
      } catch {
        // Offline or signed out: the next check tries again.
      } finally {
        refreshing.current = false;
      }
    };
    const onVisible = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const poll = window.setInterval(onVisible, REFRESH_INTERVAL);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId, loaded]);

  const handleChange = useCallback(
    (value: string) => {
      if (applyingRemote.current) return; // already saved; not the writer's typing
      text.current = value;
      dirty.current = true;
      persistDraft(value, version.current);
      scheduleWordCount();
      if (!blocked.current) {
        cb.current.onStatus("editing");
        schedule(SAVE_DELAY);
      }
    },
    [chapterId, schedule],
  );

  const keepMine = () => {
    if (!conflict) return;
    version.current = conflict.version;
    blocked.current = false;
    dirty.current = true;
    keepCopy.current = "conflict"; // the other device's text goes into history
    setConflict(null);
    void saveRef.current();
  };

  const useTheirs = () => {
    if (!conflict) return;
    version.current = conflict.version;
    text.current = conflict.content;
    dirty.current = false;
    blocked.current = false;
    void drafts.clear(chapterId);
    setInitialDoc(conflict.content);
    setEditorKey((k) => k + 1);
    flushWordCount();
    cb.current.onSaved(chapterId, {
      version: conflict.version,
      word_count: conflict.word_count,
      updated_at: conflict.updated_at,
    }, true);
    setConflict(null);
    status("saved");
  };

  // Put an earlier version back. The text it replaces is kept in history, so a
  // restore can itself be undone.
  const restore = (content: string) => {
    if (blocked.current) return;
    text.current = content;
    dirty.current = true;
    keepCopy.current = "restore";
    persistDraft(content, version.current);
    setInitialDoc(content);
    setEditorKey((k) => k + 1);
    flushWordCount();
    onCloseHistory();
    window.clearTimeout(timer.current);
    void saveRef.current();
  };

  useEffect(() => {
    if (historyOpen) setDraftOpen(false);
  }, [historyOpen]);

  const openDraft = () => {
    onCloseHistory();
    onCloseNotes();
    setDraftError(null);
    setDraftOpen(true);
    if (dirty.current) void saveRef.current();
  };

  const draftFailed = (e: unknown, action: string) => {
    if (isNetworkError(e)) setDraftError(`${action} Claude's draft needs a connection. Your chapter hasn't changed.`);
    else setDraftError(describeError(e));
    if (e instanceof ApiError && (e.status === 404 || e.data?.code === "draft_changed")) void refreshDraft();
  };

  // Put Claude's draft in the chapter. Unsaved writing is saved first, so the
  // server can keep it in History before the draft replaces it.
  const acceptDraft = async (mode: "as-drafted" | "replayed", expectedText: string) => {
    const d = claudeDraft;
    if (!d || blocked.current || draftBusy) return;
    setDraftBusy(true);
    setDraftError(null);
    try {
      window.clearTimeout(timer.current);
      if (dirty.current) await saveRef.current();
      if (dirty.current || inFlight.current || blocked.current) {
        setDraftError("Your latest writing isn't saved yet. Accept the draft once it says Saved.");
        return;
      }
      const before = text.current;
      const currentMode = d.base_version === version.current ? "as-drafted" : "replayed";
      if (mode !== currentMode || (mode === "replayed" && replayDraft(before, d.ops).text !== expectedText)) {
        setDraftError("The chapter changed while you were reviewing. Look it over again.");
        return;
      }
      blocked.current = true; // no saves while the chapter is being replaced
      let res: ChapterWithContent;
      try {
        res = await api.acceptClaudeDraft(chapterId, version.current, d.version, mode, expectedText);
      } catch (e) {
        blocked.current = false;
        if (dirty.current) schedule(SAVE_DELAY);
        draftFailed(e, "Accepting");
        return;
      }
      const info = { version: res.version, word_count: res.word_count, updated_at: res.updated_at };
      version.current = res.version;
      cb.current.onSaved(chapterId, info);
      void rememberSaved(chapterId, res.content, info);
      setClaudeDraft(null);
      setDraftOpen(false);
      if (!alive.current) return;
      if (text.current !== before) {
        // Typed while the draft went in: ask which to keep, as for another device.
        status("conflict");
        setConflict(res);
        return;
      }
      blocked.current = false;
      text.current = res.content;
      dirty.current = false;
      void drafts.clear(chapterId);
      setInitialDoc(res.content);
      setEditorKey((k) => k + 1);
      // Claude's words aren't this session's writing.
      window.clearTimeout(wordCountTimer.current);
      wordCountTimer.current = undefined;
      const words = countWords(res.content);
      cb.current.onWords(chapterId, words, false, words - countWords(before));
      status("saved");
    } finally {
      if (alive.current) setDraftBusy(false);
    }
  };

  const discardDraft = async () => {
    if (draftBusy) return;
    setDraftBusy(true);
    setDraftError(null);
    try {
      await api.discardClaudeDraft(chapterId);
      if (!alive.current) return;
      setClaudeDraft(null);
      setDraftOpen(false);
    } catch (e) {
      draftFailed(e, "Discarding");
    } finally {
      if (alive.current) setDraftBusy(false);
    }
  };

  if (loadError) {
    return (
      <div className="editor-message" role="alert">
        <p>This chapter didn't open.</p>
        <p className="editor-message-detail">{loadError}</p>
        <button className="btn" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }

  return (
    <>
    {historyOpen && initialDoc !== null && (
      <HistoryPanel
        chapterId={chapterId}
        title={title}
        currentText={() => text.current}
        canRestore={!conflict}
        onRestore={restore}
        onClose={onCloseHistory}
      />
    )}
    {initialDoc !== null && (
      <NotesPanel chapterId={chapterId} title={title} open={notesOpen} text={noteText} notes={notes} onNotes={(update) => {
        noteLoad.current.invalidate();
        setNotesLoading(false);
        setNotes(update);
      }}
        offline={offline} loading={notesLoading} loadError={noteSelectionError ?? notesError} anchor={noteAnchor} selected={selectedNote}
        onCancelAdd={() => setNoteAnchor(null)} onSelect={setSelectedNote}
        onJump={(note) => {
          const editor = view.current;
          const range = editor && findAnchor(editor.state.doc.toString(), note);
          if (!editor || !range) return;
          editor.dispatch({ selection: EditorSelection.range(range.from, range.to), effects: EditorView.scrollIntoView(range.from, { y: "center" }) });
          if (!readOnlyRef.current) editor.focus();
        }} onClose={onCloseNotes} />
    )}
    {draftOpen && claudeDraft && initialDoc !== null && (
      <ClaudeDraftPanel
        title={title}
        draft={claudeDraft}
        chapterText={text.current}
        chapterChanged={claudeDraft.base_version !== version.current || dirty.current}
        blockedBy={conflict ? "Choose a version in the notice first." : dirty.current || inFlight.current
          ? "Your latest writing must be saved before accepting." : null}
        busy={draftBusy}
        error={draftError}
        onAccept={(mode, expectedText) => void acceptDraft(mode, expectedText)}
        onDiscard={() => void discardDraft()}
        onClose={() => setDraftOpen(false)}
      />
    )}
    <article className={`page${readOnly ? " page-reading" : ""}`}>
      {conflict && (
        <div className="conflict" role="alert">
          <p>
            <strong>This chapter was saved somewhere else</strong> (on another device, or by Claude) while
            you were writing here.
            The other version has {countWords(conflict.content).toLocaleString()} words.
          </p>
          <div className="conflict-actions">
            <button className="btn btn-lamp" onClick={keepMine}>
              Keep what's on this screen
            </button>
            <button className="btn" onClick={useTheirs}>
              Switch to the other version
            </button>
          </div>
        </div>
      )}
      {claudeDraft && !draftOpen && (
        <div className="claude-draft-notice" role="status">
          <p>
            <strong>Claude's draft</strong> of this chapter is waiting
            ({claudeDraft.word_count.toLocaleString()} words). It isn't part of your chapter until you accept it.
          </p>
          <button className="btn" onClick={openDraft}>
            Review draft
          </button>
        </div>
      )}
      <h1 className="page-title">{title}</h1>
      {initialDoc === null ? (
        <p className="page-loading">Opening chapter…</p>
      ) : (
        <CodeMirror
          key={editorKey}
          value={initialDoc}
          onChange={handleChange}
          extensions={extensions}
          onCreateEditor={(v) => {
            view.current = v;
            setNoteText(v.state.doc.toString());
            v.dispatch({ effects: [
              notesChanged.of(noteHost.current.notes),
              grammarSlot.current.reconfigure(proofing(grammarOnRef.current)),
              readingSlot.current.reconfigure(readingMode(readOnlyRef.current)),
              sceneSlot.current.reconfigure(labelExtensions()),
            ] });
          }}
          basicSetup={basicSetup}
          theme="none"
          placeholder="Begin here."
          autoFocus={!readOnly}
        />
      )}
    </article>
    </>
  );
}
