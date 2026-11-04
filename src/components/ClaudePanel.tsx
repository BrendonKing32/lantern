import { useEffect, useRef, useState } from "react";
import { api, describeError } from "../api";
import type { AiStatus } from "../../shared/types";

const money = (usd: number) => (usd > 0 && usd < 0.01 ? "under $0.01" : `$${usd.toFixed(2)}`);

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const STATUS: Record<string, string> = {
  done: "",
  pending: "running",
  failed: "failed, not billed",
  unknown: "interrupted, counted at its maximum",
};

/** Claude setup and usage: whether a key is set, the limits, and recent calls. */
export function ClaudePanel({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = () =>
    api
      .aiStatus()
      .then((s) => {
        setStatus(s);
        setError(null);
      })
      .catch((e) => setError(describeError(e)));

  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    void load();
    return () => d?.close();
  }, []);

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const r = await api.aiTest();
      setResult({
        ok: r.ok,
        text: r.ok
          ? `Claude answered “${r.reply}” in ${(r.ms / 1000).toFixed(1)} s, costing about ${money(r.cost_usd)}.`
          : "Claude answered, but without a reply. Try again in a moment.",
      });
    } catch (e) {
      setResult({ ok: false, text: describeError(e) });
    } finally {
      setTesting(false);
      void load();
    }
  };

  const s = status;
  return (
    <dialog ref={ref} className="export claude" onClose={onClose} aria-labelledby="claude-title">
      <h2 id="claude-title">Claude</h2>

      {error && (
        <p className="export-error" role="alert">
          {error}
        </p>
      )}
      {!s && !error && <p className="export-note">Checking…</p>}

      {s && !s.configured && (
        <div className="claude-setup">
          <p>Claude isn't set up yet. Lantern needs an Anthropic API key, which is billed by use.</p>
          <SetupSteps />
          <button className="btn" onClick={() => void load()}>
            Check again
          </button>
        </div>
      )}

      {s && (
        <>
          <dl className="claude-usage">
            <div>
              <dt>Last 24 hours</dt>
              <dd>
                {s.used_last_24h} of {s.daily_limit} calls
              </dd>
            </div>
            <div>
              <dt>This month</dt>
              <dd>
                {money(s.spent_this_month_usd)} of {money(s.monthly_budget_usd)}
              </dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{s.model}</dd>
            </div>
          </dl>
          <div
            className={`meter${s.spent_this_month_usd >= s.monthly_budget_usd ? " is-over" : ""}`}
            role="progressbar"
            aria-label="Monthly budget used"
            aria-valuemin={0}
            aria-valuemax={s.monthly_budget_usd}
            aria-valuenow={Math.min(s.spent_this_month_usd, s.monthly_budget_usd)}
          >
            <span style={{ width: `${Math.min(100, (s.spent_this_month_usd / s.monthly_budget_usd) * 100)}%` }} />
          </div>
        </>
      )}

      {s?.configured && (
        <div className="claude-test">
          <button className="btn btn-lamp" onClick={test} disabled={testing}>
            {testing ? "Testing…" : "Test connection"}
          </button>
          {result && (
            <p className={result.ok ? "claude-ok" : "export-error"} role="status">
              {result.text}
            </p>
          )}
        </div>
      )}

      {s && s.recent.length > 0 && (
        <section className="claude-recent">
          <h3>Recent calls</h3>
          <ul>
            {s.recent.map((c) => (
              <li key={c.id}>
                <span>
                  {c.purpose}
                  <span className="claude-when"> · {when(c.created_at)}</span>
                  {STATUS[c.status] && <span className="claude-when"> · {STATUS[c.status]}</span>}
                </span>
                <span className="claude-cost">{money(c.cost_usd)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="export-note">
        Limits are set in <code>wrangler.toml</code> (AI_DAILY_LIMIT, AI_MONTHLY_BUDGET_USD). Costs here are estimates;
        the Anthropic Console shows the actual bill.
      </p>
      <div className="export-actions">
        <button className="btn btn-quiet" onClick={onClose}>
          Close
        </button>
      </div>
    </dialog>
  );
}

/** How to connect Claude: shown wherever a Claude feature is used before it's set up. */
export function SetupSteps() {
  return (
    <ol className="setup-steps">
      <li>
        Sign in at <strong>console.anthropic.com</strong>, add billing, and set a monthly spend limit there too.
      </li>
      <li>
        Create a key under <strong>API Keys</strong>.
      </li>
      <li>
        In the Lantern folder on your computer, run <code>npx wrangler secret put ANTHROPIC_API_KEY</code> and paste the
        key. Cloudflare stores it encrypted; it never goes in the code.
      </li>
    </ol>
  );
}
