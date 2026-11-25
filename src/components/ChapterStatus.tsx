import type { ChapterMeta, ChapterRevisionStatus } from "../../shared/types";

export function ChapterStatus({ chapter, onChange, offline }: {
  chapter: ChapterMeta;
  onChange: (id: string, status: ChapterRevisionStatus) => void;
  offline?: boolean;
}) {
  return <select
    className="chapter-status"
    aria-label={`Revision status for ${chapter.title}`}
    title={offline ? "Changing chapter status needs a connection" : "Change revision status"}
    value={chapter.revision_status ?? "drafting"}
    disabled={offline}
    onPointerDown={(e) => e.stopPropagation()}
    onKeyDown={(e) => e.stopPropagation()}
    onChange={(e) => onChange(chapter.id, e.currentTarget.value as ChapterRevisionStatus)}
  >
    <option value="drafting">Drafting</option>
    <option value="revising">Revising</option>
    <option value="done">Done</option>
  </select>;
}
