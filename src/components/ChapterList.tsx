import { memo, useEffect, useRef, useState } from "react";
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
import type { ChapterMeta } from "../../shared/types";
import {
  CHAPTER_ACTIONS_OPEN_EVENT,
  closeOtherChapterActions,
  shouldCloseChapterActions,
} from "../chapterActions";

interface Props {
  chapters: ChapterMeta[];
  wordsFor: (c: ChapterMeta) => number;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  onReorder: (ids: string[]) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (c: ChapterMeta) => void;
}

export function ChapterList({ chapters, wordsFor, selectedId, onSelect, onReorder, onRename, onDelete }: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = chapters.findIndex((c) => c.id === active.id);
    const to = chapters.findIndex((c) => c.id === over.id);
    onReorder(arrayMove(chapters, from, to).map((c) => c.id));
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={chapters.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <ol className="chapters" aria-label="Chapters (drag to reorder)">
          {chapters.map((c, i) => (
            <ChapterRow
              key={c.id}
              chapter={c}
              number={i + 1}
              words={wordsFor(c)}
              selected={c.id === selectedId}
              onSelect={onSelect}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
        </ol>
      </SortableContext>
    </DndContext>
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
}

const ChapterRow = memo(function ChapterRow({ chapter, number, words, selected, onSelect, onRename, onDelete }: RowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: chapter.id,
  });
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(chapter.title);
  const chapterButtonRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<HTMLDetailsElement>(null);
  const actionsToggleRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (shouldCloseChapterActions(actionsRef.current, event.target as Node)) {
        if (actionsRef.current) actionsRef.current.open = false;
      }
    };
    const closeOnFocusOutside = (event: FocusEvent) => {
      if (shouldCloseChapterActions(actionsRef.current, event.target as Node)) {
        if (actionsRef.current) actionsRef.current.open = false;
      }
    };
    const closeOthers = (event: Event) => {
      closeOtherChapterActions(
        (event as CustomEvent<HTMLDetailsElement>).detail,
        actionsRef.current,
      );
    };

    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOnFocusOutside);
    window.addEventListener(CHAPTER_ACTIONS_OPEN_EVENT, closeOthers);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOnFocusOutside);
      window.removeEventListener(CHAPTER_ACTIONS_OPEN_EVENT, closeOthers);
    };
  }, []);

  const commit = () => {
    setRenaming(false);
    const t = draft.trim();
    if (t && t !== chapter.title) onRename(chapter.id, t);
    else setDraft(chapter.title);
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
        title="Drag to reorder"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v1M11 3.5v1M5 7.5v1M11 7.5v1M5 11.5v1M11 11.5v1" /></svg>
      </button>
      {renaming ? (
        <input
          className="chapter-rename"
          value={draft}
          autoFocus
          aria-label="Chapter title"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              commit();
              requestAnimationFrame(() => chapterButtonRef.current?.focus());
            }
            if (e.key === "Escape") {
              setDraft(chapter.title);
              setRenaming(false);
              requestAnimationFrame(() => chapterButtonRef.current?.focus());
            }
          }}
        />
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
              aria-label={`Delete ${chapter.title}`}
              onClick={() => onDelete(chapter)}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
            </button>
          </span>
          <details
            ref={actionsRef}
            className="chapter-actions"
            onToggle={(e) => {
              if (e.currentTarget.open) {
                window.dispatchEvent(
                  new CustomEvent(CHAPTER_ACTIONS_OPEN_EVENT, {
                    detail: e.currentTarget,
                  }),
                );
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape" && actionsRef.current?.open) {
                e.preventDefault();
                actionsRef.current.open = false;
                actionsToggleRef.current?.focus();
              }
            }}
          >
            <summary
              ref={actionsToggleRef}
              className="icon-btn"
              aria-label={`Actions for ${chapter.title}`}
              title="Chapter actions"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3" cy="8" r=".75" /><circle cx="8" cy="8" r=".75" /><circle cx="13" cy="8" r=".75" /></svg>
            </summary>
            <div className="chapter-actions-menu">
              <button
                type="button"
                onClick={() => {
                  actionsRef.current?.removeAttribute("open");
                  setRenaming(true);
                }}
              >
                Rename
              </button>
              <button
                type="button"
                onClick={() => {
                  actionsRef.current?.removeAttribute("open");
                  onDelete(chapter);
                }}
              >
                Delete
              </button>
            </div>
          </details>
        </>
      )}
    </li>
  );
});
