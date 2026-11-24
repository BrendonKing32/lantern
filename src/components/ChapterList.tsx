import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Act, ChapterMeta } from "../../shared/types";
import {
  CHAPTER_ACTIONS_OPEN_EVENT,
  closeOtherChapterActions,
  shouldCloseChapterActions,
} from "../chapterActions";
import { actRows, arrangeFromRows } from "../acts";

interface Props {
  /** In book order. */
  chapters: ChapterMeta[];
  acts: Act[];
  wordsFor: (c: ChapterMeta) => number;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  /** The whole book in order, with the act each chapter is now in. */
  onArrange: (chapterIds: string[], chapterActs: Record<string, string | null>) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (c: ChapterMeta) => void;
  onStartAct: (chapterId: string) => void;
  onRenameAct: (id: string, title: string) => void;
  onMoveAct: (id: string, by: -1 | 1) => void;
  onDeleteAct: (act: Act) => void;
  /** An act just created here, to open for naming. */
  renamingActId: string | null;
  onRenamingActDone: () => void;
}

export function ChapterList(props: Props) {
  const { chapters, acts, wordsFor, selectedId, onSelect, onArrange, onRename, onDelete, onStartAct } = props;
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const rows = actRows(chapters, acts);
  const ids = rows.map((r) => r.id);

  // Act headings stay put; a chapter dropped below one joins that act.
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const moved = arrayMove(ids, ids.indexOf(String(active.id)), ids.indexOf(String(over.id)));
    const { chapterIds, chapterActs } = arrangeFromRows(moved);
    onArrange(chapterIds, chapterActs);
  };

  let number = 0;
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ol className="chapters" aria-label="Chapters (drag to reorder)">
          {rows.map((row) => {
            if (row.kind === "act") {
              const inAct = chapters.filter((c) => c.act_id === row.act.id);
              const index = acts.findIndex((a) => a.id === row.act.id);
              return (
                <ActRow
                  key={row.id}
                  id={row.id}
                  act={row.act}
                  chapters={inAct.length}
                  words={inAct.reduce((n, c) => n + wordsFor(c), 0)}
                  first={index === 0}
                  last={index === acts.length - 1}
                  renaming={props.renamingActId === row.act.id}
                  onRenamingDone={props.onRenamingActDone}
                  onRename={props.onRenameAct}
                  onMove={props.onMoveAct}
                  onDelete={props.onDeleteAct}
                />
              );
            }
            number += 1;
            const c = row.chapter;
            return (
              <ChapterRow
                key={c.id}
                chapter={c}
                number={number}
                words={wordsFor(c)}
                selected={c.id === selectedId}
                onSelect={onSelect}
                onRename={onRename}
                onDelete={onDelete}
                onStartAct={onStartAct}
              />
            );
          })}
        </ol>
      </SortableContext>
    </DndContext>
  );
}

/** A "⋯" menu that closes on Escape, on a click or focus elsewhere, and when another opens. */
function ActionsMenu({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const actionsRef = useRef<HTMLDetailsElement>(null);
  const toggleRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const closeOutside = (event: Event) => {
      if (shouldCloseChapterActions(actionsRef.current, event.target as Node)) {
        if (actionsRef.current) actionsRef.current.open = false;
      }
    };
    const closeOthers = (event: Event) => {
      closeOtherChapterActions((event as CustomEvent<HTMLDetailsElement>).detail, actionsRef.current);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    window.addEventListener(CHAPTER_ACTIONS_OPEN_EVENT, closeOthers);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
      window.removeEventListener(CHAPTER_ACTIONS_OPEN_EVENT, closeOthers);
    };
  }, []);

  return (
    <details
      ref={actionsRef}
      className="chapter-actions"
      onToggle={(e) => {
        if (e.currentTarget.open) {
          window.dispatchEvent(new CustomEvent(CHAPTER_ACTIONS_OPEN_EVENT, { detail: e.currentTarget }));
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && actionsRef.current?.open) {
          e.preventDefault();
          actionsRef.current.open = false;
          toggleRef.current?.focus();
        }
      }}
    >
      <summary
        ref={toggleRef}
        className="icon-btn"
        aria-label={label}
        title={label}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3" cy="8" r=".75" /><circle cx="8" cy="8" r=".75" /><circle cx="13" cy="8" r=".75" /></svg>
      </summary>
      <div className="chapter-actions-menu">{children(() => actionsRef.current?.removeAttribute("open"))}</div>
    </details>
  );
}

/** Rename in place: Enter keeps the new title, Escape the old one. */
function TitleInput({ value, label, onDone }: { value: string; label: string; onDone: (title: string | null) => void }) {
  const [draft, setDraft] = useState(value);
  const done = useRef(false);
  const finish = (title: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(title);
  };
  return (
    <input
      className="chapter-rename"
      value={draft}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(draft)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(draft);
        if (e.key === "Escape") finish(null);
      }}
    />
  );
}

interface ActRowProps {
  id: string;
  act: Act;
  chapters: number;
  words: number;
  first: boolean;
  last: boolean;
  renaming: boolean;
  onRenamingDone: () => void;
  onRename: (id: string, title: string) => void;
  onMove: (id: string, by: -1 | 1) => void;
  onDelete: (act: Act) => void;
}

function ActRow({ id, act, chapters, words, first, last, renaming: startRenaming, onRenamingDone, onRename, onMove, onDelete }: ActRowProps) {
  // A heading is a drop target for chapters but isn't dragged itself.
  const { setNodeRef, transform, transition } = useSortable({ id, disabled: { draggable: true, droppable: false } });
  const [renaming, setRenaming] = useState(startRenaming);
  const titleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (startRenaming) setRenaming(true);
  }, [startRenaming]);

  const finishRename = (title: string | null) => {
    setRenaming(false);
    onRenamingDone();
    const t = title?.trim();
    if (t && t !== act.title) onRename(act.id, t);
    requestAnimationFrame(() => titleRef.current?.focus());
  };

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className="act"
      aria-label={`${act.title}: ${chapters} ${chapters === 1 ? "chapter" : "chapters"}`}
    >
      {renaming ? (
        <TitleInput value={act.title} label="Act title" onDone={finishRename} />
      ) : (
        <button
          ref={titleRef}
          className="act-title"
          onDoubleClick={() => setRenaming(true)}
          onClick={() => setRenaming(true)}
          title="Rename this act"
        >
          <span className="act-name">{act.title}</span>
          <span className="act-meta">
            {chapters ? `${words.toLocaleString()}` : "Drag chapters here"}
          </span>
        </button>
      )}
      {!renaming && (
        <ActionsMenu label={`Actions for ${act.title}`}>
          {(close) => (
            <>
              <button type="button" onClick={() => { close(); setRenaming(true); }}>
                Rename
              </button>
              {!first && (
                <button type="button" onClick={() => { close(); onMove(act.id, -1); }}>
                  Move act up
                </button>
              )}
              {!last && (
                <button type="button" onClick={() => { close(); onMove(act.id, 1); }}>
                  Move act down
                </button>
              )}
              <button type="button" onClick={() => { close(); onDelete(act); }}>
                Remove act
              </button>
            </>
          )}
        </ActionsMenu>
      )}
    </li>
  );
}

interface RowProps {
  chapter: ChapterMeta;
  number: number;
  words: number;
  selected: boolean;
  onSelect: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (c: ChapterMeta) => void;
  onStartAct: (chapterId: string) => void;
}

// Memoized so typing in one chapter doesn't re-render every row.
const ChapterRow = memo(function ChapterRow({ chapter, number, words, selected, onSelect, onRename, onDelete, onStartAct }: RowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: chapter.id,
  });
  const [renaming, setRenaming] = useState(false);
  const chapterButtonRef = useRef<HTMLButtonElement>(null);

  const finishRename = (title: string | null) => {
    setRenaming(false);
    const t = title?.trim();
    if (t && t !== chapter.title) onRename(chapter.id, t);
    requestAnimationFrame(() => chapterButtonRef.current?.focus());
  };

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`chapter${selected ? " is-selected" : ""}${isDragging ? " is-dragging" : ""}`}
    >
      <button
        ref={setActivatorNodeRef}
        className="chapter-drag icon-btn"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${chapter.title}`}
        title="Drag to reorder, or into another act"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v1M11 3.5v1M5 7.5v1M11 7.5v1M5 11.5v1M11 11.5v1" /></svg>
      </button>
      {renaming ? (
        <TitleInput value={chapter.title} label="Chapter title" onDone={finishRename} />
      ) : (
        <button
          ref={chapterButtonRef}
          className="chapter-open"
          aria-current={selected ? "page" : undefined}
          onClick={() => onSelect(chapter.id)}
          onDoubleClick={() => setRenaming(true)}
          title="Double-click to rename"
        >
          <span className="chapter-num">{number}</span>
          <span className="chapter-title">{chapter.title}</span>
          <span className="chapter-words">{words.toLocaleString()}</span>
        </button>
      )}
      {!renaming && (
        <>
          <span className="chapter-tools">
            <button
              className="icon-btn"
              aria-label={`Rename ${chapter.title}`}
              onClick={() => setRenaming(true)}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.5 2.5l2 2L6 12l-3 1 1-3z" /></svg>
            </button>
            <button
              className="icon-btn"
              aria-label={`Start an act at ${chapter.title}`}
              title="Start an act here"
              onClick={() => onStartAct(chapter.id)}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8h11M5 4.5h6M5 11.5h6" /></svg>
            </button>
            <button
              className="icon-btn"
              aria-label={`Delete ${chapter.title}`}
              onClick={() => onDelete(chapter)}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
            </button>
          </span>
          <ActionsMenu label={`Actions for ${chapter.title}`}>
            {(close) => (
              <>
                <button type="button" onClick={() => { close(); setRenaming(true); }}>
                  Rename
                </button>
                <button type="button" onClick={() => { close(); onStartAct(chapter.id); }}>
                  Start an act here
                </button>
                <button type="button" onClick={() => { close(); onDelete(chapter); }}>
                  Delete
                </button>
              </>
            )}
          </ActionsMenu>
        </>
      )}
    </li>
  );
});
