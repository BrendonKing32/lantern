// Every call Lantern makes to Claude goes through guardedMessage(), which
// enforces the safeguards before any money is spent:
//
//   - No API key set: refuse with setup instructions.
//   - Too much text: refuse before calling (MAX_INPUT_CHARS).
//   - Daily limit: at most AI_DAILY_LIMIT calls in any 24 hours.
//   - Monthly budget: the most a call could cost is reserved up front, and the
//     call is refused if that could take the month past AI_MONTHLY_BUDGET_USD.
//     Reserving and checking happen in one SQL statement, so two calls at once
//     can't both slip under the limit.
//   - Every call is logged in ai_calls with its tokens and estimated cost.
//
// Costs are estimates from published per-token prices, not Anthropic's bill.

import Anthropic from "@anthropic-ai/sdk";
import type { AiCall, AiStatus } from "../shared/types";

export interface AiEnv {
  DB: D1Database;
  ANTHROPIC_API_KEY?: string;
  /** Local testing only: point the SDK at a stand-in server. Never set in production. */
  ANTHROPIC_BASE_URL?: string;
  AI_MODEL?: string;
  AI_DAILY_LIMIT?: string;
  AI_MONTHLY_BUDGET_USD?: string;
}

export const DEFAULT_MODEL = "claude-opus-5-5";
const DEFAULT_DAILY_LIMIT = 30;
const DEFAULT_MONTHLY_BUDGET_USD = 10;
/** About 150,000 tokens of English: a long novel's worth of chapters and notes. */
export const MAX_INPUT_CHARS = 600_000;
const DAY_MS = 86_400_000;

// US dollars per million tokens (input, output), from Anthropic's published
// prices. Thinking is billed as output. Unknown models are priced as the most
// expensive, so estimates err high.
const PRICES: Record<string, [number, number]> = {
  "claude-fable-5-1": [10, 50],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};
const priceOf = (model: string): [number, number] => PRICES[model] ?? [10, 50];
// A refused request can be re-run on a fallback model; reserve for the dearer of
// the chosen model and the Opus 4.8-priced fallbacks.
const reservePrice = (model: string): [number, number] => {
  const [i, o] = priceOf(model);
  return [Math.max(i, 5), Math.max(o, 25)];
};

const toMicros = (usd: number) => Math.ceil(usd * 1_000_000);
const fromMicros = (m: number) => m / 1_000_000;

export class AiError extends Error {
  constructor(public status: number, message: string, public code: string) {
    super(message);
  }
}

function settings(env: AiEnv) {
  const n = (v: string | undefined, d: number) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? x : d;
  };
  return {
    model: env.AI_MODEL?.trim() || DEFAULT_MODEL,
    dailyLimit: Math.floor(n(env.AI_DAILY_LIMIT, DEFAULT_DAILY_LIMIT)),
    budgetMicros: toMicros(n(env.AI_MONTHLY_BUDGET_USD, DEFAULT_MONTHLY_BUDGET_USD)),
  };
}

const monthOf = (iso: string) => iso.slice(0, 7);

// Calls that still count: finished ones at their cost, and pending or uncertain
// ones at their reservation. Calls Anthropic rejected outright cost nothing.
const SPENT = "COALESCE(SUM(CASE WHEN status = 'done' THEN cost_micros ELSE reserved_micros END), 0)";

export async function aiStatus(env: AiEnv): Promise<AiStatus> {
  const s = settings(env);
  const now = new Date();
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const month = monthOf(now.toISOString());
  const [day, spent, recent] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM ai_calls WHERE created_at > ? AND status != 'failed'").bind(since),
    env.DB.prepare(`SELECT ${SPENT} AS m FROM ai_calls WHERE month = ? AND status != 'failed'`).bind(month),
    env.DB.prepare(
      `SELECT id, purpose, model, status, input_tokens, output_tokens, cost_micros, reserved_micros, error, created_at
         FROM ai_calls ORDER BY created_at DESC LIMIT 10`,
    ),
  ]);
  const rows = (recent.results ?? []) as (Omit<AiCall, "cost_usd"> & { cost_micros: number; reserved_micros: number })[];
  return {
    configured: Boolean(env.ANTHROPIC_API_KEY),
    model: s.model,
    daily_limit: s.dailyLimit,
    used_last_24h: (day.results?.[0] as { n: number } | undefined)?.n ?? 0,
    monthly_budget_usd: fromMicros(s.budgetMicros),
    spent_this_month_usd: fromMicros((spent.results?.[0] as { m: number } | undefined)?.m ?? 0),
    recent: rows.map(({ cost_micros, reserved_micros, ...r }) => ({
      ...r,
      cost_usd: fromMicros(r.status === "done" ? cost_micros : r.status === "failed" ? 0 : reserved_micros),
    })),
  };
}

export interface GuardedRequest {
  /** What the call is for, shown in the usage log ("test", "continuity check"). */
  purpose: string;
  system: string;
  /** The user message. Its length (with the system prompt) is checked against MAX_INPUT_CHARS. */
  prompt: string;
  /** Hard cap on what Claude writes back, thinking included. */
  maxTokens: number;
  effort?: "low" | "medium" | "high";
  /** A JSON schema the reply must follow (structured outputs). */
  schema?: Record<string, unknown>;
  /** How long to wait for Claude, in milliseconds. */
  timeoutMs?: number;
}

export interface GuardedResult {
  text: string;
  model: string;
  stopReason: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export async function guardedMessage(env: AiEnv, req: GuardedRequest): Promise<GuardedResult> {
  if (!env.ANTHROPIC_API_KEY) {
    throw new AiError(
      503,
      "Claude isn't set up yet. Create an API key at console.anthropic.com, then run `npx wrangler secret put ANTHROPIC_API_KEY`.",
      "not_configured",
    );
  }
  const chars = req.system.length + req.prompt.length;
  if (chars > MAX_INPUT_CHARS) {
    throw new AiError(413, `That's too much text to send at once (${chars.toLocaleString("en-US")} characters; the limit is ${MAX_INPUT_CHARS.toLocaleString("en-US")}).`, "too_long");
  }

  const s = settings(env);
  // Reserve the most this call could cost: every input character as a token
  // (English averages about four characters per token, so this errs high) and
  // the full output allowance, at the dearest price the call could run at.
  const [inPrice, outPrice] = reservePrice(s.model);
  const reserved = toMicros((chars * inPrice + req.maxTokens * outPrice) / 1_000_000);

  const id = crypto.randomUUID();
  const now = new Date();
  const created = now.toISOString();
  const month = monthOf(created);
  const since = new Date(now.getTime() - DAY_MS).toISOString();

  // One statement: insert the pending call only if both limits still allow it.
  const claim = await env.DB.prepare(
    `INSERT INTO ai_calls (id, purpose, model, status, reserved_micros, cost_micros, input_tokens, output_tokens, month, created_at)
     SELECT ?, ?, ?, 'pending', ?, 0, 0, 0, ?, ?
      WHERE (SELECT COUNT(*) FROM ai_calls WHERE created_at > ? AND status != 'failed') < ?
        AND (SELECT ${SPENT} FROM ai_calls WHERE month = ? AND status != 'failed') + ? <= ?`,
  )
    .bind(id, req.purpose, s.model, reserved, month, created, since, s.dailyLimit, month, reserved, s.budgetMicros)
    .run();

  if (!claim.meta.changes) {
    const st = await aiStatus(env);
    if (st.used_last_24h >= s.dailyLimit) {
      throw new AiError(429, `You've used all ${s.dailyLimit} Claude calls for the last 24 hours. The limit is AI_DAILY_LIMIT in wrangler.toml.`, "daily_limit");
    }
    const left = Math.max(0, st.monthly_budget_usd - st.spent_this_month_usd);
    throw new AiError(
      429,
      `This could cost up to $${fromMicros(reserved).toFixed(2)}, and only $${left.toFixed(2)} of this month's $${st.monthly_budget_usd.toFixed(2)} budget is left. The budget is AI_MONTHLY_BUDGET_USD in wrangler.toml.`,
      "monthly_budget",
    );
  }

  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: env.ANTHROPIC_BASE_URL || undefined,
    maxRetries: 1,
    timeout: req.timeoutMs ?? 120_000,
  });

  try {
    const res = await client.beta.messages.create({
      model: s.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
      thinking: { type: "adaptive" },
      output_config: {
        effort: req.effort ?? "medium",
        ...(req.schema ? { format: { type: "json_schema" as const, schema: req.schema } } : {}),
      },
      // If a safety check declines the request, let Anthropic re-run it on a
      // suitable fallback model instead of failing.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    const u = res.usage;
    const input = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const [pi, po] = priceOf(res.model);
    const [qi, qo] = priceOf(s.model);
    // Price at the dearer of the requested and the serving model, to err high.
    const costMicros = toMicros(
      ((u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1) * Math.max(pi, qi) +
        u.output_tokens * Math.max(po, qo)) /
        1_000_000,
    );
    await env.DB.prepare(
      "UPDATE ai_calls SET status = 'done', model = ?, input_tokens = ?, output_tokens = ?, cost_micros = ? WHERE id = ?",
    )
      .bind(res.model, input, u.output_tokens, costMicros, id)
      .run();
    const text = res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    return {
      text,
      model: res.model,
      stopReason: res.stop_reason,
      costUsd: fromMicros(costMicros),
      inputTokens: input,
      outputTokens: u.output_tokens,
    };
  } catch (e) {
    // Anthropic answered with an error: nothing was billed, so the call stops
    // counting. A dropped connection or timeout might have been billed, so it
    // keeps counting at its reservation.
    const answered = e instanceof Anthropic.APIError && !(e instanceof Anthropic.APIConnectionError);
    const message = e instanceof Error ? e.message : String(e);
    await env.DB.prepare("UPDATE ai_calls SET status = ?, error = ? WHERE id = ?")
      .bind(answered ? "failed" : "unknown", message.slice(0, 500), id)
      .run();
    throw explain(e);
  }
}

function explain(e: unknown): AiError {
  if (e instanceof Anthropic.AuthenticationError) {
    return new AiError(502, "Anthropic rejected the API key. Set a new one with `npx wrangler secret put ANTHROPIC_API_KEY`.", "bad_key");
  }
  if (e instanceof Anthropic.PermissionDeniedError) {
    return new AiError(502, "This API key isn't allowed to use that model. Check the key's workspace in the Anthropic Console.", "forbidden");
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new AiError(429, "Anthropic is rate-limiting this key. Wait a minute and try again.", "rate_limited");
  }
  if (e instanceof Anthropic.BadRequestError) {
    // e.g. "Your credit balance is too low" - Anthropic's wording is the clearest.
    const msg = (e.error as { error?: { message?: string } } | undefined)?.error?.message ?? e.message;
    return new AiError(502, `Anthropic couldn't run this: ${msg}`, "bad_request");
  }
  if (e instanceof Anthropic.APIConnectionTimeoutError) {
    return new AiError(504, "Claude took too long to answer. Try again in a moment.", "timeout");
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new AiError(502, "Couldn't reach Anthropic. Try again in a moment.", "unreachable");
  }
  if (e instanceof Anthropic.APIError) {
    return new AiError(502, `Anthropic had a problem (${e.status ?? "no status"}). Try again in a moment.`, "upstream");
  }
  return new AiError(500, "Something went wrong calling Claude.", "unknown");
}
