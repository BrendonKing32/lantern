import { useEffect, useMemo, useState } from "react";
import { api, ApiError, describeError } from "../api";
import { entriesMentioned } from "../../shared/wikilinks";
import type { AiStatus, BibleEntry, ChapterMeta, CheckResult, FindingKind } from "../../shared/types";
import type { EditorControls } from "./ChapterEditor";
import { SetupSteps } from "./ClaudePanel";

interface Props {
  chapter: ChapterMeta;
  /** Chapters before this one, for the synopses sent as context. */
  earlier: ChapterMeta[];
  entries: BibleEntry[];
  controls: { current: EditorControls | null };
  offline: boolean;
  onClose: () => void;
}

const KIND: Record<FindingKind, string> = {
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

const money = (usd: number) => (usd < 0.01 ? "under $0.01" : `$${usd.toFixed(2)}`);

/** "Check this chapter against the bible", beside the page. */
export function CheckPanel({ chapter, earlier, entries, controls, offline, onClose }: Props) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResult | null>(() => savedResult(chapter.id));
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<Set<number>>(new Set());

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
      if (e.key === "Escape" && !running) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, running]);

  // What a check would send, worked out from the text on screen now.
  const preview = useMemo(() => {
    const text = controls.current?.text() ?? "";
    const mentioned = entriesMentioned(text, entries);
    const chars =
      3000 + // instructions
      text.length +
      mentioned.reduce((n, e) => n + e.body.length + e.name.length + 40, 0) +
      earlier.reduce((n, c) => n + c.synopsis.length + c.title.length + 40, 0) +
      (entries.length - mentioned.length) * 25;
    // About four characters a token in, and a few thousand tokens of reasoning
    // and findings out, at the default model's published prices.
    const estimate = (chars / 4) * (4 / 1e6) + 4000 * (20 / 1e6);
    return { empty: !text.trim(), mentioned, estimate };
    // Recomputed each time the panel opens or the chapter's bible links change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapter.id, entries, earlier, result]);

  const run = async () => {
    const text = controls.current?.text();
    if (text === undefined) return;
    setRunning(true);
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
      // A setup or limit problem changes what the panel should show.
      if (e instanceof ApiError && (e.status === 503 || e.status === 429)) loadStatus();
    } finally {
      setRunning(false);
      loadStatus();
    }
  };

  const reveal = (i: number, quote: string) => {
    if (!controls.current?.reveal(quote)) setMissing((m) => new Set(m).add(i));
  };

  const notConnected = status !== null && !status.configured;
  const limitReached =
    status !== null &&
    status.configured &&
    (status.used_last_24h >= status.daily_limit || status.spent_this_month_usd >= status.monthly_budget_usd);

  return (
    <aside className="history check" aria-label={`Continuity check of ${chapter.title}`}>
      <header className="history-head">
        <h2 className="history-title">Continuity check</h2>
        <span className="desk-spacer" />
        <button className="icon-btn" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
        </button>
      </header>

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
        {offline && !notConnected && (
          <p className="check-notice">You're offline. Continuity checks need a connection.</p>
        )}
        {statusError && !offline && <p className="history-note history-error">{statusError}</p>}

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
              {status?.configured && (
                <span className="check-left">
                  {" "}
                  · {Math.max(0, status.daily_limit - status.used_last_24h)} checks left today, $
                  {Math.max(0, status.monthly_budget_usd - status.spent_this_month_usd).toFixed(2)} left this month
                </span>
              )}
            </dd>
          </div>
        </dl>

        <button
          className="btn btn-lamp"
          onClick={run}
          disabled={running || offline || notConnected || limitReached || preview.empty || status === null}
        >
          {running ? "Checking… this can take a minute" : result ? "Check again" : "Run check"}
        </button>
        {preview.empty && <p className="history-note">The chapter is empty, so there's nothing to check yet.</p>}
        {limitReached && (
          <p className="history-note history-error">
            {status!.used_last_24h >= status!.daily_limit
              ? "You've reached today's limit of Claude calls."
              : "This month's Claude budget is used up."}{" "}
            The limits are in wrangler.toml.
          </p>
        )}
        {error && (
          <p className="history-note history-error" role="alert">
            {error}
          </p>
        )}

        {result && (
          <section className="check-result" aria-live="polite">
            <p className="check-meta">
              Checked{" "}
              {new Date(result.checked_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}{" "}
              · {money(result.cost_usd)}
            </p>
            {result.summary && <p className="check-summary">{result.summary}</p>}
            {result.findings.length === 0 ? (
              <p className="history-note">No continuity problems found.</p>
            ) : (
              <ol className="findings">
                {result.findings.map((f, i) => (
                  <li key={i} className={`finding finding-${f.kind}`}>
                    <p className="finding-kind">
                      {KIND[f.kind]}
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
      </div>
    </aside>
  );
}
