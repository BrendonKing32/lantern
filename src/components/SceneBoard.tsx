import { useState } from "react";
import { DndContext, PointerSensor, pointerWithin, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, rectSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ReactNode } from "react";
import type { Act, ChapterMeta, SceneMeta, ScenePlaceholder } from "../../shared/types";
import { actRows } from "../acts";

type ScenePatch = Partial<Pick<SceneMeta, "title" | "summary" | "pov" | "location" | "status" | "chapter_id">> & {
  link?: { passage_index: number }; unlink?: true; confirm?: true;
};

interface Props {
  chapters: ChapterMeta[];
  acts: Act[];
  scenes: SceneMeta[];
  placeholders: ScenePlaceholder[];
  projectId: string;
  offline: boolean;
  /** Add a scene to a chapter, or with null, a scene that isn't in any chapter yet. */
  onAdd: (chapterId: string | null) => Promise<SceneMeta | null>;
  onUpdate: (scene: SceneMeta, patch: ScenePatch) => Promise<void>;
  onDelete: (scene: SceneMeta) => void;
  onMove: (chapterId: string | null, sceneIds: string[], movedId: string) => void;
  onMoveAcross: (scene: SceneMeta, chapterId: string, beforePassageIndex: number | null) => void;
  onOpen: (scene: SceneMeta) => void;
  moving?: boolean;
}

type BoardItem = { scene: SceneMeta; index: number } | { placeholder: ScenePlaceholder };

export function sceneGroupItems(group: SceneMeta[], placeholders: ScenePlaceholder[]): BoardItem[] {
  const inText = group.filter((scene) => scene.in_text && scene.passage_index !== null)
    .sort((a, b) => a.passage_index! - b.passage_index!);
  let nextInText = 0;
  const display = group.map((scene) => scene.in_text && scene.passage_index !== null ? inText[nextInText++] : scene);
  const remaining = [...placeholders].sort((a, b) => a.passage_index - b.passage_index);
  const items: BoardItem[] = [];
  display.forEach((scene) => {
    while (scene.passage_index !== null && remaining.length && remaining[0].passage_index < scene.passage_index) {
      items.push({ placeholder: remaining.shift()! });
    }
    items.push({ scene, index: group.findIndex((card) => card.id === scene.id) });
  });
  remaining.forEach((placeholder) => items.push({ placeholder }));
  return items;
}

export function passageBeforeTarget(items: BoardItem[], targetId: string): number | null {
  const index = items.findIndex((item) => "scene" in item
    ? item.scene.id === targetId : placeholderId(item.placeholder) === targetId);
  if (index < 0) return null;
  for (const item of items.slice(index)) {
    if ("placeholder" in item) return item.placeholder.passage_index;
    if (item.scene.in_text && item.scene.passage_index !== null) return item.scene.passage_index;
  }
  return null;
}

const groupId = (id: string | null) => `scene-group:${id ?? ""}`;
const placeholderId = (p: ScenePlaceholder) => `scene-placeholder:${p.chapter_id}:${p.passage_index}`;
export function sceneDrop(
  scenes: SceneMeta[], placeholders: ScenePlaceholder[], chapterIds: string[], activeId: string, targetId: string,
): { kind: "unassigned" } | { kind: "reorder"; chapterId: string; sceneIds: string[]; sceneId: string }
  | { kind: "across"; scene: SceneMeta; chapterId: string; beforePassageIndex: number | null } | null {
  const scene = scenes.find((item) => item.id === activeId);
  if (!scene?.in_text || !scene.chapter_id || activeId === targetId) return null;
  const targetScene = scenes.find((item) => item.id === targetId);
  const targetPlaceholder = placeholders.find((item) => placeholderId(item) === targetId);
  const group = [null, ...chapterIds].find((id) => groupId(id) === targetId);
  const chapterId = targetScene ? targetScene.chapter_id : targetPlaceholder ? targetPlaceholder.chapter_id : group;
  if (chapterId === undefined) return null;
  if (chapterId === null) return { kind: "unassigned" };
  const cards = scenes.filter((item) => item.chapter_id === chapterId).sort((a, b) => a.position - b.position);
  if (chapterId === scene.chapter_id) {
    const order = sceneDragOrder(cards, scene.id, targetId);
    return order ? { kind: "reorder", chapterId, sceneIds: order, sceneId: scene.id } : null;
  }
  const items = sceneGroupItems(cards, placeholders.filter((item) => item.chapter_id === chapterId));
  return { kind: "across", scene, chapterId, beforePassageIndex: passageBeforeTarget(items, targetId) };
}

const boardCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.filter((hit) => !String(hit.id).startsWith("scene-group:")).concat(
    hits.filter((hit) => String(hit.id).startsWith("scene-group:")),
  );
};

function DropGroup({ id, label, children }: { id: string | null; label: string; children: ReactNode }) {
  const { setNodeRef } = useDroppable({ id: groupId(id) });
  return <section ref={setNodeRef} className={id === null ? "scene-group scene-group-unassigned" : "scene-group"} aria-label={label}>{children}</section>;
}

function PlaceholderTarget({ placeholder, children }: { placeholder: ScenePlaceholder; children: ReactNode }) {
  const { setNodeRef } = useDroppable({ id: placeholderId(placeholder) });
  return <li ref={setNodeRef} className="scene-card scene-placeholder">{children}</li>;
}

export function sceneDragOrder(group: SceneMeta[], activeId: string, overId: string | null): string[] | null {
  const from = group.findIndex((scene) => scene.id === activeId);
  const to = group.findIndex((scene) => scene.id === overId);
  if (from < 0 || to < 0 || from === to || !group[from].in_text) return null;
  return arrayMove(group, from, to).map((scene) => scene.id);
}

function SortableScene({ scene, disabled, children }: { scene: SceneMeta; disabled: boolean; children: (handle: ReactNode) => ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: scene.id, disabled: { draggable: disabled || !scene.in_text, droppable: false },
  });
  return <li ref={setNodeRef} className="scene-card" style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : undefined }}>
    {children(scene.in_text && <button className="btn btn-quiet scene-drag" type="button" disabled={disabled}
      aria-label={`Drag ${scene.title}`} {...attributes} {...listeners}>Drag</button>)}
  </li>;
}

export function SceneBoard({ chapters, acts, scenes, placeholders, projectId, offline, onAdd, onUpdate, onDelete, onMove, onMoveAcross, onOpen, moving = false }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScenePatch>({});
  const [busy, setBusy] = useState(false);
  const [moveHint, setMoveHint] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(`lantern.scene-check.${projectId}`) === "1");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const begin = (scene: SceneMeta) => {
    setDraft({
      title: scene.title,
      summary: scene.summary,
      pov: scene.pov,
      location: scene.location,
      status: scene.status,
      chapter_id: scene.chapter_id,
    });
    setEditing(scene.id);
  };

  const save = async (scene: SceneMeta) => {
    setBusy(true);
    try {
      await onUpdate(scene, draft);
      setEditing(null);
    } catch {
      // The parent surfaces the API error; keep the draft open for correction or retry.
    } finally {
      setBusy(false);
    }
  };

  const place = async (scene: SceneMeta, chapterId: string | null) => {
    if (chapterId === scene.chapter_id) return;
    try {
      await onUpdate(scene, { chapter_id: chapterId });
    } catch {
      // The parent surfaces the API error.
    }
  };

  const chapterPicker = (value: string | null, onChange: (chapterId: string | null) => void, disabled: boolean) => (
    <select value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">Not in a chapter</option>
      {chapters.map((chapter, n) => (
        <option key={chapter.id} value={chapter.id}>{n + 1}. {chapter.title}</option>
      ))}
    </select>
  );

  const groups: { id: string | null; heading: string; label: string; empty: string; addLabel: string }[] = [
    {
      id: null,
      heading: "Unassigned",
      label: "Scenes not in a chapter",
      empty: "No unassigned scenes. New scenes start here until you place them in a chapter.",
      addLabel: "New scene",
    },
    ...chapters.map((chapter, chapterIndex) => ({
      id: chapter.id,
      heading: `${chapterIndex + 1}. ${chapter.title}`,
      label: `Scenes in ${chapter.title}`,
      empty: "No scenes in this chapter yet.",
      addLabel: "Add scene",
    })),
  ];

  const needsCheck = chapters.filter((chapter) =>
    scenes.some((scene) => scene.chapter_id === chapter.id && scene.unconfirmed));
  const rows = actRows(chapters, acts);
  const groupOrder = [groups[0], ...rows.filter((row) => row.kind === "chapter").map((row) => groups.find((group) => group.id === row.chapter.id)!)];
  const addCard = async (placeholder: ScenePlaceholder) => {
    const scene = await onAdd(placeholder.chapter_id);
    if (!scene) return;
    const title = placeholder.excerpt.split(/\s+/).filter(Boolean).slice(0, 6).join(" ") || "New scene";
    try { await onUpdate(scene, { title, link: { passage_index: placeholder.passage_index } }); } catch { /* parent reports the error */ }
  };
  const dragEnd = ({ active, over }: DragEndEvent) => {
    if (offline || moving || !over) return;
    const action = sceneDrop(scenes, placeholders, chapters.map((chapter) => chapter.id), String(active.id), String(over.id));
    if (!action) return;
    if (action.kind === "unassigned") {
      setMoveHint("To take this scene out of the chapter, cut its text in the editor.");
      return;
    }
    setMoveHint(null);
    if (action.kind === "reorder") onMove(action.chapterId, action.sceneIds, action.sceneId);
    else onMoveAcross(action.scene, action.chapterId, action.beforePassageIndex);
  };

  return (
    <section className="scene-board" aria-label="Scene planning board">
      <p className="board-hint">
        Cards can be planned or linked to passages in the text. Drag an in-text card to move its passage, including to another chapter.
        {offline && " Reconnect to edit scene plans."}
      </p>
      {moveHint && <p role="status" className="board-hint">{moveHint}</p>}
      {!dismissed && needsCheck.length > 0 && (
        <aside className="scene-check">
          <p>Check how your scene cards line up with the text.</p>
          <p>{needsCheck.map((chapter) => chapter.title).join(", ")}</p>
          <button className="btn btn-quiet" onClick={() => { localStorage.setItem(`lantern.scene-check.${projectId}`, "1"); setDismissed(true); }}>Dismiss</button>
        </aside>
      )}
      <DndContext sensors={sensors} collisionDetection={boardCollision} onDragEnd={dragEnd}>
      {groupOrder.map((g) => {
        const group = scenes.filter((scene) => scene.chapter_id === g.id).sort((a, b) => a.position - b.position);
        const items = sceneGroupItems(group, placeholders.filter((placeholder) => placeholder.chapter_id === g.id));
        const chapter = chapters.find((item) => item.id === g.id);
        const act = chapter && acts.find((item) => item.id === chapter.act_id);
        const firstInAct = act && rows.find((row) => row.kind === "chapter" && row.chapter.act_id === act.id);
        return (
          <DropGroup id={g.id} label={g.label} key={g.id ?? "unassigned"}>
            {act && firstInAct?.kind === "chapter" && firstInAct.chapter.id === g.id && <h2 className="act-name">{act.title}</h2>}
            <header className="scene-group-head">
              <h2>{g.heading}</h2>
              <button className="btn btn-quiet" disabled={offline || moving} onClick={async () => {
                const scene = await onAdd(g.id);
                if (scene) begin(scene);
              }}>{g.addLabel}</button>
            </header>
            {items.length === 0 ? <p className="scene-empty">{g.empty}</p> : (
              <SortableContext items={group.map((scene) => scene.id)} strategy={rectSortingStrategy}>
              <ol className="scene-cards">
                {items.map((item) => "placeholder" in item ? (
                  <PlaceholderTarget placeholder={item.placeholder} key={`passage-${item.placeholder.passage_index}`}>
                    <span className="scene-status">No card</span>
                    <p className="scene-excerpt">{item.placeholder.excerpt || "Empty passage"}</p>
                    <p className="scene-meta">{item.placeholder.words.toLocaleString()} words</p>
                    <div className="scene-actions">
                      <button className="btn btn-quiet" disabled={offline || moving} onClick={() => void addCard(item.placeholder)}>Add card</button>
                      <label>This is… <select disabled={offline || moving} value="" onChange={(e) => {
                        const scene = group.find((card) => card.id === e.target.value);
                        if (scene) void onUpdate(scene, { link: { passage_index: item.placeholder.passage_index } }).catch(() => {});
                      }}>
                        <option value="">Choose a planned card</option>
                        {group.filter((card) => !card.in_text).map((card) => <option value={card.id} key={card.id}>{card.title}</option>)}
                      </select></label>
                    </div>
                  </PlaceholderTarget>
                ) : (({ scene, index: i }) => (
                  <SortableScene scene={scene} disabled={offline || moving || editing !== null} key={scene.id}>{(handle) => <>
                    {editing === scene.id ? (
                      <div className="scene-edit">
                        <label>Scene title
                          <input maxLength={200} value={draft.title ?? ""} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
                        </label>
                        <label>Summary
                          <textarea maxLength={2000} value={draft.summary ?? ""} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} />
                        </label>
                        <div className="scene-fields">
                          <label>POV
                            <input maxLength={120} value={draft.pov ?? ""} onChange={(e) => setDraft({ ...draft, pov: e.target.value })} />
                          </label>
                          <label>Location
                            <input maxLength={120} value={draft.location ?? ""} onChange={(e) => setDraft({ ...draft, location: e.target.value })} />
                          </label>
                        </div>
                        <label>Status
                          <select value={draft.status ?? "planned"} onChange={(e) => setDraft({ ...draft, status: e.target.value as SceneMeta["status"] })}>
                            <option value="planned">Planned</option>
                            <option value="drafted">Drafted</option>
                          </select>
                        </label>
                        <label>Chapter
                          {chapterPicker(draft.chapter_id ?? null, (chapterId) => setDraft({ ...draft, chapter_id: chapterId }), scene.in_text)}
                        </label>
                        <div className="scene-actions">
                          <button className="btn btn-lamp" disabled={busy || offline || !draft.title?.trim()} onClick={() => void save(scene)}>Save</button>
                          <button className="btn btn-quiet" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="scene-card-head">
                          {handle}
                          <span className={`scene-status ${scene.in_text ? "scene-drafted" : "scene-planned"}`}>{scene.in_text ? "In the text" : "Planned"}</span>
                          <h3>{scene.title}</h3>
                        </div>
                        {scene.in_text && <><p className="scene-meta">{scene.word_count.toLocaleString()} words</p><p className="scene-excerpt">{scene.excerpt}</p></>}
                        {scene.merged_into && <p className="scene-meta">Merged into {scene.merged_into}</p>}
                        <p className={scene.summary ? "scene-summary" : "scene-summary scene-empty"}>
                          {scene.summary || "Add a summary"}
                        </p>
                        {(scene.pov || scene.location) && (
                          <p className="scene-meta">{[scene.pov && `POV: ${scene.pov}`, scene.location && `Location: ${scene.location}`].filter(Boolean).join(" · ")}</p>
                        )}
                        <label className="scene-place">
                          <span>Chapter</span>
                          {chapterPicker(scene.chapter_id, (chapterId) => void place(scene, chapterId), offline || moving || scene.in_text)}
                        </label>
                        <footer className="scene-actions">
                          {scene.in_text && <button className="btn btn-quiet" onClick={() => onOpen(scene)}>Open</button>}
                          {scene.unconfirmed && <><button className="btn btn-quiet" disabled={offline || moving} onClick={() => void onUpdate(scene, { confirm: true }).catch(() => {})}>Looks right</button><button className="btn btn-quiet" disabled={offline || moving} onClick={() => void onUpdate(scene, { unlink: true }).catch(() => {})}>Not this one</button></>}
                          <button className="btn btn-quiet" disabled={offline || moving} onClick={() => begin(scene)}>Edit</button>
                          <button className="btn btn-quiet" disabled={offline || moving || i === 0} aria-label={`Move ${scene.title} up`} onClick={() => onMove(g.id, group.map((s, n) => n === i ? group[i - 1].id : n === i - 1 ? scene.id : s.id), scene.id)}>Up</button>
                          <button className="btn btn-quiet" disabled={offline || moving || i === group.length - 1} aria-label={`Move ${scene.title} down`} onClick={() => onMove(g.id, group.map((s, n) => n === i ? group[i + 1].id : n === i + 1 ? scene.id : s.id), scene.id)}>Down</button>
                          <button className="btn btn-quiet scene-delete" disabled={offline || moving} onClick={() => onDelete(scene)}>Delete</button>
                        </footer>
                      </>
                    )}
                  </>}</SortableScene>
                ))(item))}
              </ol>
              </SortableContext>
            )}
          </DropGroup>
        );
      })}
      </DndContext>
    </section>
  );
}
