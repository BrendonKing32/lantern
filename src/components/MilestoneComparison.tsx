import { useEffect, useRef, useState } from "react";
import type { ChapterMeta, Milestone, MilestoneChapter, ProjectDetail } from "../../shared/types";
import { countWords } from "../../shared/wordcount";
import { api, describeError } from "../api";
import { drafts } from "../local";
import { classifyMilestoneChapters } from "../milestoneComparison";
import { HistoryComparison } from "./HistoryComparison";

type Row = {
  before?: MilestoneChapter;
  now?: ChapterMeta;
  oldText: string;
  newText: string;
  added: number;
  removed: number;
};

interface Props {
  milestone: Milestone;
  detail: ProjectDetail;
  activeText: { id: string; text: string } | null;
  onRestore: (chapter: ChapterMeta | undefined, title: string, text: string, expected: string) => Promise<void>;
  onClose: () => void;
}

export function MilestoneComparison({ milestone, detail, activeText, onRestore, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [summary, setSummary] = useState<ReturnType<typeof classifyMilestoneChapters> | null>(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let worker: Worker | undefined;
    const load = async () => {
      const before = await api.milestoneChapters(milestone.id);
      const current = await api.getProject(detail.project.id);
      const classified = classifyMilestoneChapters(before, current.chapters);
      if (cancelled) return;
      if (!cancelled) setSummary(classified);
      worker = new Worker(new URL("../historyDiff.worker.ts", import.meta.url), { type: "module" });
      const result: Row[] = [];
      for (const [index, item] of classified.rows.entries()) {
        if (cancelled) return;
        setProgress(`Comparing ${index + 1} of ${classified.rows.length} chapters…`);
        const oldText = item.before ? (await api.milestoneChapter(milestone.id, item.before.chapter_id)).content : "";
        let newText = "";
        if (item.now) {
          const draft = await drafts.read(item.now.id);
          newText = activeText?.id === item.now.id ? activeText.text : draft?.content ?? (await api.getChapter(item.now.id)).content;
        }
        const counts = await new Promise<{ added: number; removed: number } | null>((resolve, reject) => {
          worker!.onmessage = (event) => resolve(event.data);
          worker!.onerror = worker!.onmessageerror = () => reject(new Error("Couldn't compare these chapters. Try again."));
          worker!.postMessage({ snapshot: oldText, draft: newText, countWords: true });
        });
        if (!counts) throw new Error("A chapter has too many changes to compare. Try comparing a smaller chapter.");
        result.push({ ...item, oldText, newText, ...counts });
      }
      if (!cancelled) { setRows(result); setProgress(""); }
    };
    void load().catch((e) => { if (!cancelled) setError(e instanceof Error && !(e instanceof TypeError) ? e.message : describeError(e)); });
    return () => { cancelled = true; worker?.terminate(); };
  }, [milestone.id, detail.project.id, activeText]);

  const restore = async (row: Row) => {
    if (!row.before) return;
    const question = row.now
      ? "Restore this chapter as it was? What's in the chapter now is kept in History."
      : `Add “${row.before.title}” back as a new chapter?`;
    if (!confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      await onRestore(row.now, row.before.title, row.oldText, row.newText);
      onClose();
    } catch (e) {
      setError(e instanceof Error && !(e instanceof TypeError) ? e.message : describeError(e));
    } finally { setBusy(false); }
  };

  return (
    <dialog ref={dialog} className="milestone-comparison" aria-label={`Compare ${milestone.name} with now`}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
      <header>
        <button className="btn" onClick={onClose} disabled={busy}>← Back to novel</button>
        <h1>Compare {milestone.name} with now</h1>
      </header>
      {summary && rows && <>
        <p>Then: {milestone.word_count.toLocaleString()} words · Now: {rows.reduce((n, row) => n + countWords(row.newText), 0).toLocaleString()} words</p>
        <p>{summary.added} added · {summary.removed} removed · {summary.renamed} renamed · {summary.reordered ? "Chapters reordered" : "Order unchanged"}</p>
        <p>Words changed: {rows.reduce((n, row) => n + row.added + row.removed, 0).toLocaleString()}</p>
      </>}
      {progress && <p role="status">{progress}</p>}
      {error && <p className="export-error" role="alert">{error}</p>}
      {rows && <ul className="milestone-comparison-list">
        {rows.map((row) => {
          const id = row.now?.id ?? row.before!.chapter_id;
          const status = !row.before ? "New" : !row.now ? "Removed" : row.oldText === row.newText ? "Unchanged" : "Changed";
          return <li key={id}>
            <strong>{row.now?.title ?? row.before?.title}</strong>
            {row.before && row.now && row.before.title !== row.now.title && <> (then: {row.before.title})</>}
            <p>{status} · +{row.added.toLocaleString()} / −{row.removed.toLocaleString()} words</p>
            <button className="btn" onClick={() => setOpen(open === id ? null : id)}>{open === id ? "Close" : "Open"}</button>
            {open === id && <>
              <HistoryComparison snapshot={row.oldText} currentText={() => row.newText} />
              {row.before && <button className="btn" disabled={busy} onClick={() => void restore(row)}>
                {row.now ? "Restore this chapter as it was" : "Add it back as a new chapter"}
              </button>}
            </>}
          </li>;
        })}
      </ul>}
    </dialog>
  );
}
