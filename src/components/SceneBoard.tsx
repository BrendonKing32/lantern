import { useState } from "react";
import type { ChapterMeta, SceneMeta } from "../../shared/types";

type ScenePatch = Partial<Pick<SceneMeta, "title" | "summary" | "pov" | "location" | "status" | "chapter_id">>;

interface Props {
  chapters: ChapterMeta[];
  scenes: SceneMeta[];
  offline: boolean;
  /** Add a scene to a chapter, or with null, a scene that isn't in any chapter yet. */
  onAdd: (chapterId: string | null) => Promise<SceneMeta | null>;
  onUpdate: (scene: SceneMeta, patch: ScenePatch) => Promise<void>;
  onDelete: (scene: SceneMeta) => void;
  onMove: (chapterId: string | null, sceneIds: string[]) => void;
}

// Scenes stand on their own. Each one is either unassigned or placed in a
// chapter, and can be moved between them at any time.
export function SceneBoard({ chapters, scenes, offline, onAdd, onUpdate, onDelete, onMove }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScenePatch>({});
  const [busy, setBusy] = useState(false);
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

  return (
    <section className="scene-board" aria-label="Scene planning board">
      <p className="board-hint">
        Scenes stand on their own: create one, then place it in a chapter whenever you're ready.
        Scene cards are planning notes; they don't change manuscript text.
        {offline && " Reconnect to edit scene plans."}
      </p>
      {groups.map((g) => {
        const group = scenes.filter((scene) => scene.chapter_id === g.id).sort((a, b) => a.position - b.position);
        return (
          <section className={g.id === null ? "scene-group scene-group-unassigned" : "scene-group"} key={g.id ?? "unassigned"} aria-label={g.label}>
            <header className="scene-group-head">
              <h2>{g.heading}</h2>
              <button className="btn btn-quiet" disabled={offline} onClick={async () => {
                const scene = await onAdd(g.id);
                if (scene) begin(scene);
              }}>{g.addLabel}</button>
            </header>
            {group.length === 0 ? <p className="scene-empty">{g.empty}</p> : (
              <ol className="scene-cards">
                {group.map((scene, i) => (
                  <li className="scene-card" key={scene.id}>
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
                          {chapterPicker(draft.chapter_id ?? null, (chapterId) => setDraft({ ...draft, chapter_id: chapterId }), false)}
                        </label>
                        <div className="scene-actions">
                          <button className="btn btn-lamp" disabled={busy || offline || !draft.title?.trim()} onClick={() => void save(scene)}>Save</button>
                          <button className="btn btn-quiet" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="scene-card-head">
                          <span className={`scene-status scene-${scene.status}`}>{scene.status}</span>
                          <h3>{scene.title}</h3>
                        </div>
                        <p className={scene.summary ? "scene-summary" : "scene-summary scene-empty"}>
                          {scene.summary || "Add a summary"}
                        </p>
                        {(scene.pov || scene.location) && (
                          <p className="scene-meta">{[scene.pov && `POV: ${scene.pov}`, scene.location && `Location: ${scene.location}`].filter(Boolean).join(" · ")}</p>
                        )}
                        <label className="scene-place">
                          <span>Chapter</span>
                          {chapterPicker(scene.chapter_id, (chapterId) => void place(scene, chapterId), offline)}
                        </label>
                        <footer className="scene-actions">
                          <button className="btn btn-quiet" disabled={offline} onClick={() => begin(scene)}>Edit</button>
                          <button className="btn btn-quiet" disabled={offline || i === 0} aria-label={`Move ${scene.title} up`} onClick={() => onMove(g.id, group.map((s, n) => n === i ? group[i - 1].id : n === i - 1 ? scene.id : s.id))}>Up</button>
                          <button className="btn btn-quiet" disabled={offline || i === group.length - 1} aria-label={`Move ${scene.title} down`} onClick={() => onMove(g.id, group.map((s, n) => n === i ? group[i + 1].id : n === i + 1 ? scene.id : s.id))}>Down</button>
                          <button className="btn btn-quiet scene-delete" disabled={offline} onClick={() => onDelete(scene)}>Delete</button>
                        </footer>
                      </>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
        );
      })}
    </section>
  );
}
