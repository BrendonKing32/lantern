import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, describeError, streamBookCheck } from "../api";
import { drafts } from "../local";
import { entriesMentioned } from "../../shared/wikilinks";
import type {
  AiStatus,
  BibleEntry,
  BookCheckResult,
  BookFindingKind,
  ChapterMeta,
  CheckResult,
  FindingKind,
} from "../../shared/types";
import type { EditorControls } from "./ChapterEditor";
import { SetupSteps } from "./ClaudePanel";

export type CheckTab = "chapter" | "book";

interface Props {
  projectId: string;
  /** The chapter open in the editor. */
  chapter: ChapterMeta;
  /** Every chapter, in book order. */
  chapters: ChapterMeta[];
  wordsFor: (c: ChapterMeta) => number;
  entries: BibleEntry[];
  controls: { current: EditorControls | null };
  offline: boolean;
  tab: CheckTab;
  onTab: (t: CheckTab) => void;
  /** Open a chapter and select a quoted passage in it. Resolves false if it isn't there. */
  onOpenQuote: (chapterId: string, quote: string) => Promise<boolean>;
  onClose: () => void;
}

const money = (usd: number) => (usd < 0.01 ? "under $0.01" : `$${usd.toFixed(2)}`);
const stamp = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Continuity checks beside the page: this chapter, or the whole book. */
export function CheckPanel(props: Props) {
  const { tab, onTab, onClose, offline } = props;
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadStatus = () => {
    setStatusError(null);
    api
      .aiStatus()
      .then(setStatus)
      .catch((e) => setStatusError(describeError(e)));
  };
  useEffect(loadStatus, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const notConnected = status !== null && !status.configured;
  const limitReached =
    status !== null &&
    status.configured &&
    (status.used_last_24h >= status.daily_limit || status.spent_this_month_usd >= status.monthly_budget_usd);
  const canRun = !offline && !notConnected && !limitReached && status !== null;

  const shared = { status, canRun, limitReached, loadStatus, onBusy: setBusy };

  return (
    <aside className="history check" aria-label="Continuity check">
      <header className="history-head">
        <h2 className="history-title">Continuity check</h2>
        <span className="desk-spacer" />
        <button className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </header>
      <div className="check-tabs" role="tablist" aria-label="What to check">
        {(
          [
            ["chapter", "This chapter"],
            ["book", "Whole book"],
          ] as const
        ).map(([t, label]) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`check-tab${tab === t ? " is-on" : ""}`}
            onClick={() => onTab(t)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="history-body">
        {notConnected && (
          <div className="check-notice" role="alert">
            <p>
              <strong>Claude isn't connected.</strong> Continuity checks need an Anthropic API key before they can run.
            </p>
            <SetupSteps />
            <button className="btn" onClick={loadStatus}>
              Check again
            </button>
          </div>
        )}
        {offline && !notConnected && <p className="check-notice">You're offline. Continuity checks need a connection.</p>}
        {statusError && !offline && <p className="history-note history-error">{statusError}</p>}

        {/* The book check stays mounted while another tab or chapter is shown, so a run isn't lost. */}
        <div hidden={tab !== "chapter"}>
          <ChapterCheck key={props.chapter.id} {...props} {...shared} />
        </div>
        <div hidden={tab !== "book"}>
          <BookCheck {...props} {...shared} />
        </div>
      </div>
    </aside>
  );
}

interface Shared {
  status: AiStatus | null;
  canRun: boolean;
  limitReached: boolean;
  loadStatus: () => void;
  onBusy: (b: boolean) => void;
}

function Remaining({ status }: { status: AiStatus | null }) {
  if (!status?.configured) return null;
  return (
    <span className="check-left">
      {" "}
      · {Math.max(0, status.daily_limit - status.used_last_24h)} checks left today, $
      {Math.max(0, status.monthly_budget_usd - status.spent_this_month_usd).toFixed(2)} left this month
    </span>
  );
}

function LimitNote({ status, limitReached }: { status: AiStatus | null; limitReached: boolean }) {
  if (!limitReached || !status) return null;
  return (
    <p className="history-note history-error">
      {status.used_last_24h >= status.daily_limit
        ? "You've reached today's limit of Claude calls."
        : "This month's Claude budget is used up."}{" "}
      The limits are in wrangler.toml.
    </p>
  );
}

// ---------- this chapter ----------

const CHAPTER_KIND: Record<FindingKind, string> = {
  contradiction: "Contradiction",
  internal: "Contradicts itself",
  new_fact: "Not in the bible yet",
};

const resultKey = (chapterId: string) => `lantern:check:${chapterId}`;

function savedResult(chapterId: string): CheckResult | null {
  try {
    const raw = localStorage.getItem(resultKey(chapterId));
    return raw ? (JSON.parse(raw) as CheckResult) : null;
  } catch {
    return null;
  }
}

function ChapterCheck({ chapter, chapters, entries, controls, status, canRun, limitReached, loadStatus, onBusy }: Props & Shared) {
  const [result, setResult] = useState<CheckResult | null>(() => savedResult(chapter.id));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<Set<number>>(new Set());
  const earlier = useMemo(() => chapters.slice(0, chapters.findIndex((c) => c.id === chapter.id)), [chapters, chapter.id]);

  const preview = useMemo(() => {
    const text = controls.current?.text() ?? "";
    const mentioned = entriesMentioned(text, entries);
    const chars =
      3000 +
      text.length +
      mentioned.reduce((n, e) => n + e.body.length + e.name.length + 40, 0) +
      earlier.reduce((n, c) => n + c.synopsis.length + c.title.length + 40, 0) +
      (entries.length - mentioned.length) * 25;
    // About four characters a token in, and a few thousand tokens of reasoning
    // and findings out, at the default model's published prices.
    const estimate = (chars / 4) * (4 / 1e6) + 4000 * (20 / 1e6);
    return { empty: !text.trim(), mentioned, estimate };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter.id, entries, earlier, result]);

  const run = async () => {
    const text = controls.current?.text();
    if (text === undefined) return;
    setRunning(true);
    onBusy(true);
    setError(null);
    try {
      const r = await api.checkChapter(chapter.id, text);
      setResult(r);
      setMissing(new Set());
      try {
        localStorage.setItem(resultKey(chapter.id), JSON.stringify(r));
      } catch {
        /* only a convenience */
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setRunning(false);
      onBusy(false);
      loadStatus();
    }
  };

  const reveal = (i: number, quote: string) => {
    if (!controls.current?.reveal(quote)) setMissing((m) => new Set(m).add(i));
  };

  return (
    <>
      <p className="history-note">
        Claude reads “{chapter.title}” alongside the bible entries it mentions and the synopses of earlier chapters, and
        points out anything that doesn't line up.
      </p>
      <dl className="check-send">
        <div>
          <dt>Bible entries</dt>
          <dd>
            {preview.mentioned.length
              ? preview.mentioned.map((e) => e.name).join(", ")
              : "None mentioned. Claude will still check the chapter against itself and the earlier synopses."}
          </dd>
        </div>
        <div>
          <dt>Earlier chapters</dt>
          <dd>
            {earlier.length === 0
              ? "None, this is the first"
              : `${earlier.length} (${earlier.filter((c) => c.synopsis.trim()).length} with synopses)`}
          </dd>
        </div>
        <div>
          <dt>Estimated cost</dt>
          <dd>
            about {money(preview.estimate)}
            <Remaining status={status} />
          </dd>
        </div>
      </dl>
      <button className="btn btn-lamp" onClick={run} disabled={running || !canRun || preview.empty}>
        {running ? "Checking… this can take a minute" : result ? "Check again" : "Run check"}
      </button>
      {preview.empty && <p className="history-note">The chapter is empty, so there's nothing to check yet.</p>}
      <LimitNote status={status} limitReached={limitReached} />
      {error && (
        <p className="history-note history-error" role="alert">
          {error}
        </p>
      )}

      {result && (
        <section className="check-result" aria-live="polite">
          <p className="check-meta">
            Checked {stamp(result.checked_at)} · {money(result.cost_usd)}
          </p>
          {result.summary && <p className="check-summary">{result.summary}</p>}
          {result.findings.length === 0 ? (
            <p className="history-note">No continuity problems found.</p>
          ) : (
            <ol className="findings">
              {result.findings.map((f, i) => (
                <li key={i} className={`finding finding-${f.kind}`}>
                  <p className="finding-kind">
                    {CHAPTER_KIND[f.kind]}
                    {f.entry && <span> · {f.entry}</span>}
                  </p>
                  {f.quote && (
                    <button className="finding-quote" onClick={() => reveal(i, f.quote)} title="Show in the chapter">
                      “{f.quote}”
                    </button>
                  )}
                  {missing.has(i) && <p className="history-note">That passage isn't in the chapter any more.</p>}
                  <p className="finding-text">{f.explanation}</p>
                  {f.suggestion && <p className="finding-fix">{f.suggestion}</p>}
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </>
  );
}

// ---------- whole book ----------

const BOOK_KIND: Record<BookFindingKind, string> = {
  contradiction: "Contradiction",
  timeline: "Timeline",
  bible: "Bible out of date",
};

/** Roughly what fits in one book check: about a million characters. */
const MAX_BOOK_WORDS = 160_000;

function BookCheck({
  projectId,
  chapter,
  chapters,
  wordsFor,
  entries,
  controls,
  onOpenQuote,
  status,
  canRun,
  limitReached,
  loadStatus,
  onBusy,
}: Props & Shared) {
  const [result, setResult] = useState<BookCheckResult | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState<{ chapters: number; words: number; seconds: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<Set<number>>(new Set());
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    api
      .lastBookCheck(projectId)
      .then((r) => alive.current && setResult(r))
      .catch(() => {})
      .finally(() => alive.current && setLoaded(true));
    return () => {
      alive.current = false;
    };
  }, [projectId]);

  // Closing the page mid-check loses the result and still costs the call.
  useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  const words = chapters.reduce((n, c) => n + wordsFor(c), 0);
  const notes = entries.reduce((n, e) => n + e.body.length, 0);
  // About 1.35 tokens a word of English, plus the bible, and around ten
  // thousand tokens of reasoning and findings out, at published prices.
  const estimate = ((words * 1.35 + notes / 4 + 2000) * 4) / 1e6 + (10_000 * 20) / 1e6;
  const tooLong = words > MAX_BOOK_WORDS;

  const run = async () => {
    setError(null);
    setMissing(new Set());
    setRunning({ chapters: chapters.length, words, seconds: 0 });
    onBusy(true);
    try {
      // Send the text for any chapter with writing not yet saved, and the
      // chapter on screen as it is now.
      const overrides: Record<string, string> = {};
      const ids = new Set(chapters.map((c) => c.id));
      for (const d of await drafts.all()) if (ids.has(d.chapterId)) overrides[d.chapterId] = d.content;
      const onScreen = controls.current?.text();
      if (onScreen !== undefined) overrides[chapter.id] = onScreen;

      await streamBookCheck(projectId, overrides, (e) => {
        if (!alive.current) return;
        if (e.type === "started") setRunning({ chapters: e.chapters, words: e.words, seconds: 0 });
        else if (e.type === "progress") setRunning((r) => (r ? { ...r, seconds: e.seconds } : r));
        else if (e.type === "result") setResult(e.result);
        else if (e.type === "error") setError(e.error);
      });
    } catch (e) {
      if (alive.current) setError(e instanceof ApiError || e instanceof TypeError ? describeError(e) : "The check stopped unexpectedly. Try again.");
    } finally {
      if (alive.current) {
        setRunning(null);
        onBusy(false);
        loadStatus();
      }
    }
  };

  const open = async (i: number, chapterId: string, quote: string) => {
    if (!chapterId || !(await onOpenQuote(chapterId, quote))) setMissing((m) => new Set(m).add(i));
  };

  const order = new Map(chapters.map((c, i) => [c.id, i]));
  const findings = (result?.findings ?? [])
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (order.get(a.f.chapter_id) ?? 1e9) - (order.get(b.f.chapter_id) ?? 1e9));

  return (
    <>
      <p className="history-note">
        Claude reads every chapter in order, with the whole story bible, and points out contradictions between chapters,
        timeline problems, and places the bible has fallen behind the book.
      </p>
      <dl className="check-send">
        <div>
          <dt>Manuscript</dt>
          <dd>
            {chapters.length} {chapters.length === 1 ? "chapter" : "chapters"}, {words.toLocaleString()} words
          </dd>
        </div>
        <div>
          <dt>Bible</dt>
          <dd>
            {entries.length} {entries.length === 1 ? "entry" : "entries"}
          </dd>
        </div>
        <div>
          <dt>Estimated cost</dt>
          <dd>
            about {money(estimate)}
            <Remaining status={status} />
          </dd>
        </div>
      </dl>

      <button className="btn btn-lamp" onClick={run} disabled={!!running || !canRun || words === 0 || tooLong}>
        {running ? "Checking the book…" : result ? "Check the book again" : "Check the whole book"}
      </button>
      {tooLong && (
        <p className="history-note history-error">
          At {words.toLocaleString()} words the book is too long for one check (about {MAX_BOOK_WORDS.toLocaleString()} is
          the most). Check chapters one at a time instead.
        </p>
      )}
      {words === 0 && <p className="history-note">The book has no text yet.</p>}
      <LimitNote status={status} limitReached={limitReached} />
      {running && (
        <p className="history-note check-running" role="status">
          Claude is reading {running.chapters} {running.chapters === 1 ? "chapter" : "chapters"} (
          {running.words.toLocaleString()} words){running.seconds ? `, ${running.seconds} s so far` : ""}. A whole book
          can take a few minutes; keep this page open.
        </p>
      )}
      {error && (
        <p className="history-note history-error" role="alert">
          {error}
        </p>
      )}

      {!loaded && <p className="history-note">Looking for the last check…</p>}
      {result && (
        <section className="check-result" aria-live="polite">
          <p className="check-meta">
            Checked {stamp(result.checked_at)} · {result.chapters_checked} chapters, {result.words_checked.toLocaleString()} words ·{" "}
            {money(result.cost_usd)}
          </p>
          {result.summary && <p className="check-summary">{result.summary}</p>}
          {findings.length === 0 ? (
            <p className="history-note">No continuity problems found.</p>
          ) : (
            <ol className="findings">
              {findings.map(({ f, i }, n) => {
                const heading = f.chapter_title && f.chapter_id !== findings[n - 1]?.f.chapter_id;
                return (
                  <li key={i} className={`finding finding-${f.kind === "bible" ? "new_fact" : f.kind === "timeline" ? "internal" : "contradiction"}`}>
                    {heading && <p className="finding-chapter">{f.chapter_title}</p>}
                    <p className="finding-kind">
                      {BOOK_KIND[f.kind]}
                      {f.conflicts_with && <span> · with {f.conflicts_with}</span>}
                    </p>
                    {f.quote && (
                      <button className="finding-quote" onClick={() => open(i, f.chapter_id, f.quote)} title="Show in the chapter">
                        “{f.quote}”
                      </button>
                    )}
                    {missing.has(i) && <p className="history-note">That passage isn't in the chapter any more.</p>}
                    <p className="finding-text">{f.explanation}</p>
                    {f.suggestion && <p className="finding-fix">{f.suggestion}</p>}
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      )}
    </>
  );
}
