import { useCallback, useEffect, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { api, ApiError, describeError } from "../api";
import { drafts } from "../drafts";
import { basicSetup, proseExtensions } from "../editorSetup";
import { countWords } from "../../shared/wordcount";
import type { ChapterWithContent } from "../../shared/types";

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
  onSaved: (chapterId: string, info: { version: number; word_count: number }) => void;
  onStatus: (state: SaveState, detail?: string) => void;
}

const SAVE_DELAY = 1200;
const RETRY_DELAY = 5000;

export function ChapterEditor({ chapterId, title, onWords, onSaved, onStatus }: Props) {
  const [initialDoc, setInitialDoc] = useState<string | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [conflict, setConflict] = useState<ChapterWithContent | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const text = useRef("");
  const version = useRef(0);
  const dirty = useRef(false);
  const inFlight = useRef(false);
  const saveAgain = useRef(false);
  const blocked = useRef(false); // true while a conflict waits for a decision
  const timer = useRef<number | undefined>(undefined);
  const alive = useRef(true);

  // Keep the latest callbacks without re-running effects.
  const cb = useRef({ onWords, onSaved, onStatus });
  cb.current = { onWords, onSaved, onStatus };
  const status = (s: SaveState, detail?: string) => {
    if (alive.current) cb.current.onStatus(s, detail);
  };

  const saveRef = useRef<() => Promise<void>>(async () => {});
  const schedule = useCallback((ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void saveRef.current(), ms);
  }, []);

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
      const res = await api.saveChapter(chapterId, content, version.current);
      version.current = res.version;
      cb.current.onSaved(chapterId, res);
      if (text.current === content) {
        dirty.current = false;
        drafts.clear(chapterId);
        status("saved");
      } else {
        drafts.write(chapterId, text.current, version.current);
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
        status("signedout");
      } else if (e instanceof ApiError && e.status < 500) {
        status("error", describeError(e));
      } else {
        status("offline");
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

  // Load the chapter, recovering any unsaved local draft.
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    status("loading");

    api
      .getChapter(chapterId)
      .then((ch) => {
        if (cancelled) return;
        version.current = ch.version;
        let content = ch.content;
        const draft = drafts.read(chapterId);
        if (draft && draft.content !== ch.content) {
          content = draft.content;
          dirty.current = true;
          if (draft.baseVersion !== ch.version) {
            // Saved elsewhere since this draft was written.
            blocked.current = true;
            setConflict(ch);
          }
        } else if (draft) {
          drafts.clear(chapterId);
        }
        text.current = content;
        setInitialDoc(content);
        cb.current.onWords(chapterId, countWords(ch.content), true);
        if (content !== ch.content) cb.current.onWords(chapterId, countWords(content), false);
        if (blocked.current) status("conflict");
        else if (dirty.current) {
          status("editing");
          schedule(300);
        } else status("saved");
      })
      .catch((e) => {
        if (cancelled) return;
        const draft = drafts.read(chapterId);
        if (draft && !(e instanceof ApiError && e.status === 404)) {
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
      });

    const warn = (ev: BeforeUnloadEvent) => {
      if (dirty.current) ev.preventDefault();
    };
    window.addEventListener("beforeunload", warn);

    return () => {
      cancelled = true;
      alive.current = false;
      window.clearTimeout(timer.current);
      window.removeEventListener("beforeunload", warn);
      // Best-effort flush when switching chapters; the local draft covers failure.
      if (dirty.current && !blocked.current && !inFlight.current) {
        const content = text.current;
        api
          .saveChapter(chapterId, content, version.current, { keepalive: true })
          .then((res) => {
            drafts.clear(chapterId);
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
      drafts.write(chapterId, value, version.current);
      cb.current.onWords(chapterId, countWords(value), false);
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
    setConflict(null);
    void saveRef.current();
  };

  const useTheirs = () => {
    if (!conflict) return;
    version.current = conflict.version;
    text.current = conflict.content;
    dirty.current = false;
    blocked.current = false;
    drafts.clear(chapterId);
    setInitialDoc(conflict.content);
    setEditorKey((k) => k + 1);
    cb.current.onWords(chapterId, countWords(conflict.content), false);
    setConflict(null);
    status("saved");
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
          extensions={proseExtensions}
          basicSetup={basicSetup}
          theme="none"
          placeholder="Begin here."
          autoFocus
        />
      )}
    </article>
  );
}
