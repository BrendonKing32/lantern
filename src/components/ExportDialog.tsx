import { useEffect, useRef, useState } from "react";
import type { ProjectDetail } from "../../shared/types";
import type { ExportFormat } from "../export";

const AUTHOR_KEY = "lantern:author";

const CHOICES: { id: ExportFormat; name: string; detail: string }[] = [
  { id: "docx", name: "Word (.docx)", detail: "Standard manuscript format, for agents, editors and printing." },
  { id: "epub", name: "EPUB", detail: "An e-book to read on a phone, tablet or e-reader." },
  { id: "md", name: "Markdown (.zip)", detail: "A file per chapter plus the whole book, as plain text." },
];

function savedAuthor(): string {
  try {
    return localStorage.getItem(AUTHOR_KEY) ?? "";
  } catch {
    return "";
  }
}

interface Props {
  detail: ProjectDetail;
  onClose: () => void;
}

export function ExportDialog({ detail, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [format, setFormat] = useState<ExportFormat>("docx");
  const [author, setAuthor] = useState(savedAuthor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem(AUTHOR_KEY, author.trim());
    } catch {
      /* remembering the name is only a convenience */
    }
    try {
      const { exportBook } = await import("../export");
      await exportBook(detail, format, author);
      onClose();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "The export didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="export" onClose={onClose} aria-labelledby="export-title">
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <h2 id="export-title">Export “{detail.project.title}”</h2>

        <fieldset className="export-formats">
          <legend>Format</legend>
          {CHOICES.map((c) => (
            <label key={c.id} className={`export-format${format === c.id ? " is-on" : ""}`}>
              <input
                type="radio"
                name="format"
                value={c.id}
                checked={format === c.id}
                onChange={() => setFormat(c.id)}
              />
              <span>
                <span className="export-name">{c.name}</span>
                <span className="export-detail">{c.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {format !== "md" && (
          <label className="export-author">
            Author name
            <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="As it should appear on the book" maxLength={120} />
          </label>
        )}

        <p className="export-note">
          Includes all {detail.chapters.length} {detail.chapters.length === 1 ? "chapter" : "chapters"} in order, with
          any writing not yet saved.
        </p>
        {error && (
          <p className="export-error" role="alert">
            {error}
          </p>
        )}

        <div className="export-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-lamp" disabled={busy}>
            {busy ? "Exporting…" : "Export"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
