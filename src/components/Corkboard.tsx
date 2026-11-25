import { useEffect, useRef, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Act, ChapterMeta, SceneMeta } from "../../shared/types";
import type { ChapterRevisionStatus } from "../../shared/types";
import { ChapterStatus } from "./ChapterStatus";

const MAX_SYNOPSIS = 2000;

const STEP: Record<string, "left" | "right" | "up" | "down"> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/**
 * Keyboard moves on the grid by position in the book: left and right step one
 * card, up and down step one row. (dnd-kit's default picks the nearest card in
 * that direction, which the cards' slight tilt can fool into jumping rows.)
 */
function gridKeys(order: () => string[]): KeyboardCoordinateGetter {
  return (event, { context: { active, over, collisionRect, droppableRects } }) => {
    const step = STEP[event.code];
    if (!step) return undefined;
    event.preventDefault();
    if (!active || !collisionRect) return undefined;
    const ids = order();
    const rects = ids.map((id) => droppableRects.get(id));
    if (rects.some((r) => !r)) return undefined;
    const first = rects[0]!;
    const cols = Math.max(1, rects.filter((r) => Math.abs(r!.top - first.top) < first.height / 2).length);
    const from = ids.indexOf(String(over?.id ?? active.id));
    const delta = step === "right" ? 1 : step === "left" ? -1 : step === "down" ? cols : -cols;
    const to = Math.min(ids.length - 1, Math.max(0, from + delta));
    if (from < 0 || to === from) return undefined;
    const rect = rects[to]!;
    // Same alignment dnd-kit uses: a later slot lines up by its far edge.
    const after = to > ids.indexOf(String(active.id));
    return {
      x: rect.left - (after ? collisionRect.width - rect.width : 0),
      y: rect.top - (after ? collisionRect.height - rect.height : 0),
    };
  };
}

interface Props {
  chapters: ChapterMeta[];
  acts: Act[];
  scenes: SceneMeta[];
  wordsFor: (c: ChapterMeta) => number;
  selectedId: string | undefined;
  onOpen: (id: string) => void;
  /** The new order, the card moved and the card it was dropped on. */
  onReorder: (ids: string[], movedId: string, overId: string) => void;
  onSynopsis: (id: string, synopsis: string) => void;
  onAdd: () => void;
  onStatus: (id: string, status: ChapterRevisionStatus) => void;
  offline?: boolean;
}

/** Every chapter as an index card: drag to reorder, write a synopsis, open to write. */
export function Corkboard({ chapters, acts, scenes, wordsFor, selectedId, onOpen, onReorder, onSynopsis, onAdd, onStatus, offline }: Props) {
  const actTitle = new Map(acts.map((a) => [a.id, a.title]));
  const ids = useRef<string[]>([]);
  ids.current = chapters.map((c) => c.id);
  const [coordinateGetter] = useState(() => gridKeys(() => ids.current));
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter }),
  );

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = chapters.findIndex((c) => c.id === active.id);
    const to = chapters.findIndex((c) => c.id === over.id);
    onReorder(arrayMove(chapters, from, to).map((c) => c.id), String(active.id), String(over.id));
  };

  return (
    <section className="board" aria-label="Corkboard">
      <p className="board-hint">
        Drag cards to reorder chapters; a card dropped on another joins that card's act. Click a synopsis to write one; open a card to write the chapter.
      </p>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={chapters.map((c) => c.id)} strategy={rectSortingStrategy}>
          <ol className="cards" aria-label="Chapters as cards (drag to reorder)">
            {chapters.map((c, i) => (
              <Card
                key={c.id}
                chapter={c}
                number={i + 1}
                act={c.act_id ? actTitle.get(c.act_id) : undefined}
                scenes={scenes.filter((s) => s.chapter_id === c.id && s.in_text && s.passage_index !== null)
                  .sort((a, b) => a.passage_index! - b.passage_index!)}
                words={wordsFor(c)}
                selected={c.id === selectedId}
                onOpen={onOpen}
                onSynopsis={onSynopsis}
                onStatus={onStatus}
                offline={offline}
              />
            ))}
            <li className="card-add-slot">
              <button className="card-add" onClick={onAdd}>
                Add chapter
              </button>
            </li>
          </ol>
        </SortableContext>
      </DndContext>
    </section>
  );
}

interface CardProps {
  chapter: ChapterMeta;
  number: number;
  /** The act's title, shown on the card. */
  act?: string;
  scenes: SceneMeta[];
  words: number;
  selected: boolean;
  onOpen: (id: string) => void;
  onSynopsis: (id: string, synopsis: string) => void;
  onStatus: (id: string, status: ChapterRevisionStatus) => void;
  offline?: boolean;
}

function Card({ chapter, number, act, scenes, words, selected, onOpen, onSynopsis, onStatus, offline }: CardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: chapter.id });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(chapter.synopsis);
  const area = useRef<HTMLTextAreaElement>(null);

  // Pick up changes saved elsewhere while the card isn't being edited.
  useEffect(() => {
    if (!editing) setDraft(chapter.synopsis);
  }, [chapter.synopsis, editing]);

  useEffect(() => {
    const el = area.current;
    if (editing && el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const text = draft.trim();
    if (text !== chapter.synopsis.trim()) onSynopsis(chapter.id, text);
  };

  // Enter and Space on the card's own buttons press them rather than picking
  // the card up. Pointer drags can start anywhere: a click that doesn't move
  // 8px still counts as a click.
  const stop = {
    onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
  };

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`card${selected ? " is-selected" : ""}${isDragging ? " is-dragging" : ""}`}
      aria-label={`Chapter ${number}: ${chapter.title}`}
      {...attributes}
      {...listeners}
    >
      <header className="card-head">
        <span className="card-num">{number}</span>
        <button className="card-title" onClick={() => onOpen(chapter.id)} title="Open this chapter" {...stop}>
          {chapter.title}
        </button>
      </header>
      <ChapterStatus chapter={chapter} onChange={onStatus} offline={offline} />

      {editing ? (
        <textarea
          ref={area}
          className="card-synopsis-input"
          value={draft}
          maxLength={MAX_SYNOPSIS}
          aria-label={`Synopsis of ${chapter.title}`}
          placeholder="What happens in this chapter?"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") {
              setDraft(chapter.synopsis);
              setEditing(false);
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              commit();
            }
          }}
        />
      ) : (
        <button
          className={`card-synopsis${chapter.synopsis.trim() ? "" : " is-empty"}`}
          onClick={() => setEditing(true)}
          aria-label={chapter.synopsis.trim() ? `Edit synopsis of ${chapter.title}` : `Add a synopsis to ${chapter.title}`}
          {...stop}
        >
          <span className="card-synopsis-text">{chapter.synopsis.trim() || "Add a synopsis"}</span>
        </button>
      )}

      {scenes.length > 0 && (
        <ul className="card-scenes" aria-label={`Scenes in ${chapter.title}`}>
          {scenes.slice(0, 6).map((scene) => (
            <li key={scene.id}>
              <span>{scene.status === "done" && "✓ "}{scene.title}</span>
              <span>{scene.word_count.toLocaleString()} {scene.word_count === 1 ? "word" : "words"}</span>
            </li>
          ))}
          {scenes.length > 6 && <li>+{scenes.length - 6} more</li>}
        </ul>
      )}

      <footer className="card-foot">
        <span>
          {act && <span className="card-act">{act} · </span>}
          {words.toLocaleString()} {words === 1 ? "word" : "words"}
        </span>
        <button className="card-open" onClick={() => onOpen(chapter.id)} {...stop}>
          Open
        </button>
      </footer>
    </li>
  );
}
