import { useCallback, useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { Compartment, EditorSelection } from "@codemirror/state";
import { api, ApiError, describeError } from "../api";
import { drafts } from "../local";
import { isNetworkError, loadChapter, openEditors, rememberSaved } from "../sync";
import { HistoryPanel } from "./HistoryPanel";
import { basicSetup, proseExtensions } from "../editorSetup";
import { entriesChanged, wikilinks } from "../wikilinkEditor";
import { grammar, recheckGrammar } from "../grammar";
import { countWords } from "../../shared/wordcount";
import type { BibleEntry, ChapterWithContent, Dialect, SaveResult } from "../../shared/types";

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
  /** Word count changes. `initial` marks the count as of opening the chapter. */
  onWords: (chapterId: string, words: number, initial: boolean) => void;
  onSaved: (chapterId: string, info: SaveResult) => void;
  onStatus: (state: SaveState, detail?: string) => void;
  historyOpen: boolean;
  /** Story guide entries, for [[links]]. */
  entries: BibleEntry[];
  onOpenLink: (name: string) => void;
  /** Check grammar and spelling with Harper (otherwise the browser's spellcheck is used). */
  grammarOn: boolean;
  /** The English the novel is written in. */
  dialect: Dialect;
  onCloseHistory: () => void;
  /** Filled in by the editor so other panels can read the text and point into it. */
  controls?: { current: EditorControls | null };
}

export interface EditorControls {
  /** The text on screen, unsaved writing included. */
  text: () => string;
  /** Select and scroll to a quoted passage. False if it isn't in the chapter. */
  reveal: (quote: string) => boolean;
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

const SAVE_DELAY = 1200;
const RETRY_DELAY = 5000;
const WORD_COUNT_DELAY = 150;

export function ChapterEditor({
  chapterId,
  title,
  onWords,
  onSaved,
  onStatus,
  historyOpen,
  onCloseHistory,
  entries,
  onOpenLink,
  grammarOn,
  dialect,
  controls,
}: Props) {
  const [initialDoc, setInitialDoc] = useState<string | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [conflict, setConflict] = useState<ChapterWithContent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  // [[links]]: the extension reads the latest entries and click handler from
  // refs, so it's built once and the editor never has to be recreated.
  const linkHost = useRef({ entries, onOpenLink });
  linkHost.current = { entries, onOpenLink };
  const view = useRef<EditorView | null>(null);
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
    grammarSlot.current.of(proofing(grammarOnRef.current)),
  ]);
  useEffect(() => {
    if (!view.current) return;
    view.current.dispatch({ effects: entriesChanged.of(null) });
    recheckGrammar(view.current); // story guide names aren't misspellings
  }, [entries]);
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
        v.focus();
        return true;
      },
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
    if (alive.current) cb.current.onStatus(s, detail);
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
    try {
      const res = await api.saveChapter(chapterId, content, version.current, { snapshot: keepCopy.current });
      keepCopy.current = undefined;
      version.current = res.version;
      draftStorageFailed.current = false;
      cb.current.onSaved(chapterId, res);
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
        api
          .saveChapter(chapterId, content, version.current, { keepalive: true, snapshot: keepCopy.current })
          .then((res) => {
            void drafts.clearIf(chapterId, content);
            void rememberSaved(chapterId, content, res);
            cb.current.onSaved(chapterId, res);
          })
          .catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId, schedule]);

  const handleChange = useCallback(
    (value: string) => {
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
    <article className="page">
      {conflict && (
        <div className="conflict" role="alert">
          <p>
            <strong>This chapter was saved on another device</strong> while you were writing here.
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
            v.dispatch({ effects: grammarSlot.current.reconfigure(proofing(grammarOnRef.current)) });
          }}
          basicSetup={basicSetup}
          theme="none"
          placeholder="Begin here."
          autoFocus
        />
      )}
    </article>
    </>
  );
}
