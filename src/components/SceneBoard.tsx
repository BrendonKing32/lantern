import { useState } from "react";
import type { ChapterMeta, SceneMeta } from "../../shared/types";

interface Props {
  chapters: ChapterMeta[];
  scenes: SceneMeta[];
  offline: boolean;
  onAdd: (chapterId: string) => Promise<SceneMeta | null>;
  onUpdate: (scene: SceneMeta, patch: Partial<Pick<SceneMeta, "title" | "summary" | "pov" | "location" | "status">>) => Promise<void>;
  onDelete: (scene: SceneMeta) => void;
  onMove: (chapterId: string, sceneIds: string[]) => void;
}

export function SceneBoard({ chapters, scenes, offline, onAdd, onUpdate, onDelete, onMove }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<Pick<SceneMeta, "title" | "summary" | "pov" | "location" | "status">>>({});
  const [busy, setBusy] = useState(false);
  const begin = (scene: SceneMeta) => {
    setDraft({
      title: scene.title,
      summary: scene.summary,
      pov: scene.pov,
      location: scene.location,
      status: scene.status,
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

  return (
    <section className="scene-board" aria-label="Scene planning board">
      <p className="board-hint">
        Plan scenes inside each chapter. Scene cards are planning notes; they don't change manuscript text.
        {offline && " Reconnect to edit scene plans."}
      </p>
      {chapters.map((chapter, chapterIndex) => {
        const group = scenes.filter((scene) => scene.chapter_id === chapter.id).sort((a, b) => a.position - b.position);
        return (
          <section className="scene-group" key={chapter.id} aria-label={`Scenes in ${chapter.title}`}>
            <header className="scene-group-head">
              <h2>{chapterIndex + 1}. {chapter.title}</h2>
              <button className="btn btn-quiet" disabled={offline} onClick={async () => {
                const scene = await onAdd(chapter.id);
                if (scene) begin(scene);
              }}>Add scene</button>
            </header>
            {group.length === 0 ? <p className="scene-empty">No scenes planned yet.</p> : (
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
                        <footer className="scene-actions">
                          <button className="btn btn-quiet" disabled={offline} onClick={() => begin(scene)}>Edit</button>
                          <button className="btn btn-quiet" disabled={offline || i === 0} aria-label={`Move ${scene.title} up`} onClick={() => onMove(chapter.id, group.map((s, n) => n === i ? group[i - 1].id : n === i - 1 ? scene.id : s.id))}>Up</button>
                          <button className="btn btn-quiet" disabled={offline || i === group.length - 1} aria-label={`Move ${scene.title} down`} onClick={() => onMove(chapter.id, group.map((s, n) => n === i ? group[i + 1].id : n === i + 1 ? scene.id : s.id))}>Down</button>
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
