import { useState, type FormEvent } from "react";
import { api, describeError } from "../api";
import { localDay } from "../when";
import type { ProjectInfo } from "../../shared/types";

interface Props {
  project: ProjectInfo;
  words: number;
  onChange: (target: { target_words: number | null; target_date: string | null }) => void;
}

const DAY_MS = 86_400_000;

function daysLeft(date: string): number {
  // Counting today as a writing day, up to and including the deadline.
  const end = Date.parse(`${date}T00:00:00Z`);
  const start = Date.parse(`${localDay()}T00:00:00Z`);
  return Math.round((end - start) / DAY_MS) + 1;
}

function pace(remaining: number, date: string | null): string | null {
  if (remaining <= 0) return "Target reached.";
  if (!date) return `${remaining.toLocaleString()} to go.`;
  const left = daysLeft(date);
  const when = new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (left <= 0) return `${remaining.toLocaleString()} to go. The ${when} deadline has passed.`;
  const perDay = Math.ceil(remaining / left);
  return `About ${perDay.toLocaleString()} a day to finish by ${when}.`;
}

/** A novel's target length and deadline, in the sidebar. */
export function TargetMeter({ project, words, onChange }: Props) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = project.target_words;

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const raw = f.get("words")?.toString().replace(/[^\d]/g, "") ?? "";
    const n = raw ? Number(raw) : null;
    const date = f.get("date")?.toString() || null;
    try {
      const res = await api.setTarget(project.id, n && n > 0 ? n : null, date);
      onChange(res);
      setEditing(false);
      setError(null);
    } catch (err) {
      setError(describeError(err));
    }
  };

  if (editing) {
    return (
      <form className="target-form" onSubmit={save}>
        <label>
          Target length
          <input name="words" inputMode="numeric" defaultValue={target ?? ""} placeholder="e.g. 80000" autoFocus />
        </label>
        <label>
          Finish by <span className="optional">(optional)</span>
          <input name="date" type="date" defaultValue={project.target_date ?? ""} min={localDay()} />
        </label>
        {error && <p className="target-error" role="alert">{error}</p>}
        <div className="target-actions">
          <button className="btn btn-lamp" type="submit">Save</button>
          <button className="btn btn-quiet" type="button" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
        <p className="target-hint">Clear the length to remove the target.</p>
      </form>
    );
  }

  if (target === null) {
    return (
      <button className="target-set" onClick={() => setEditing(true)}>
        Set a target length
      </button>
    );
  }

  const pct = Math.min(100, (words / target) * 100);
  return (
    <div className="target">
      <button className="target-line" onClick={() => setEditing(true)} title="Change target">
        <span>{Math.floor(pct)}% of {target.toLocaleString()}</span>
      </button>
      <div
        className={`meter${pct >= 100 ? " is-done" : ""}`}
        role="progressbar"
        aria-label="Progress to target length"
        aria-valuemin={0}
        aria-valuemax={target}
        aria-valuenow={Math.min(words, target)}
      >
        <span style={{ width: `${pct}%` }} />
      </div>
      <p className="target-pace">{pace(target - words, project.target_date)}</p>
    </div>
  );
}
