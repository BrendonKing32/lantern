import { useEffect, useRef, useState } from "react";
import { api, describeError } from "../api";
import { localDay } from "../when";
import type { ClaudeChange } from "../../shared/types";

interface Props {
  projectId: string;
  /** Chapters and story guide entries that still exist, so links to removed ones are disabled. */
  chapterIds: Set<string>;
  entryIds: Set<string>;
  onOpenChapter: (chapterId: string, withHistory: boolean) => void;
  onOpenEntry: (entryId: string) => void;
  onOpenScenes: () => void;
  /** Called with the newest change once the list has been shown. */
  onSeen: (newest: string | null) => void;
  onClose: () => void;
}

const TEXT_EDITS = new Set(["edit_chapter", "append_to_chapter"]);

function dayHeading(iso: string): string {
  const day = localDay(new Date(iso));
  if (day === localDay()) return "Today";
  if (day === localDay(Date.now() - 86_400_000)) return "Yesterday";
  return new Date(iso).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

export function ClaudeChangesDialog({
  projectId,
  chapterIds,
  entryIds,
  onOpenChapter,
  onOpenEntry,
  onOpenScenes,
  onSeen,
  onClose,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [changes, setChanges] = useState<ClaudeChange[] | null>(null);
  const [error, setError] = useState("");
  const seen = useRef(onSeen);
  seen.current = onSeen;

  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  useEffect(() => {
    let live = true;
    api
      .claudeChanges(projectId)
      .then((list) => {
        if (!live) return;
        setChanges(list);
        seen.current(list[0]?.created_at ?? null);
      })
      .catch((e) => {
        if (live) setError(describeError(e));
      });
    return () => {
      live = false;
    };
  }, [projectId]);

  const groups: { heading: string; items: ClaudeChange[] }[] = [];
  for (const change of changes ?? []) {
    const heading = dayHeading(change.created_at);
    if (groups.at(-1)?.heading === heading) groups.at(-1)!.items.push(change);
    else groups.push({ heading, items: [change] });
  }

  const actions = (c: ClaudeChange) => {
    if (c.target_kind === "entry") {
      const there = entryIds.has(c.target_id);
      return (
        <button className="btn btn-quiet" disabled={!there} title={there ? undefined : "This entry is no longer in the story guide"} onClick={() => onOpenEntry(c.target_id)}>
          Open entry
        </button>
      );
    }
    if (c.target_kind === "scene") {
      return (
        <button className="btn btn-quiet" onClick={onOpenScenes}>
          Open scenes
        </button>
      );
    }
    const there = chapterIds.has(c.target_id);
    const gone = there ? undefined : "This chapter is no longer in the book";
    return (
      <>
        <button className="btn btn-quiet" disabled={!there} title={gone} onClick={() => onOpenChapter(c.target_id, false)}>
          Open chapter
        </button>
        {TEXT_EDITS.has(c.action) && (
          <button className="btn btn-quiet" disabled={!there} title={gone ?? "The text from before an accepted draft is kept here"} onClick={() => onOpenChapter(c.target_id, true)}>
            History
          </button>
        )}
      </>
    );
  };

  return (
    <dialog ref={ref} className="share-dialog claude-changes" onClose={onClose} aria-labelledby="claude-changes-title">
      <div className="share-dialog-body">
        <header className="share-head">
          <div>
            <h2 id="claude-changes-title">AI changes</h2>
            <p>
              What AI clients changed in this novel through the connector. Changes to a chapter's text wait in
              an AI draft of that chapter until you accept them; open the chapter to review it. When you accept
              a draft, the previous text is kept in the chapter's History, where you can restore it.
            </p>
          </div>
          <button className="icon-btn" aria-label="Close AI changes" onClick={onClose}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </header>

        {error && <p className="share-error" role="alert">{error}</p>}
        {!error && changes === null && <p className="share-note">Loading…</p>}
        {changes?.length === 0 && (
          <p className="share-note">
            No AI client has changed this novel yet. To let one, connect Lantern in your MCP client and choose
            Read and edit.
          </p>
        )}
        {groups.map((group) => (
          <section key={group.heading} className="claude-changes-day" aria-label={group.heading}>
            <h3>{group.heading}</h3>
            <ol>
              {group.items.map((c) => (
                <li key={c.id} className="claude-change">
                  <div className="claude-change-text">
                    <strong>{c.summary}</strong>
                    <span>
                      {time(c.created_at)}
                      {c.detail ? ` · ${c.detail}` : ""}
                    </span>
                  </div>
                  <div className="claude-change-actions">{actions(c)}</div>
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </dialog>
  );
}
