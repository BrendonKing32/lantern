-- Lantern: a log of every call to Claude, used to enforce the daily limit and
-- monthly budget. Costs are estimates in millionths of a US dollar.

CREATE TABLE ai_calls (
  id               TEXT PRIMARY KEY,
  purpose          TEXT NOT NULL,
  model            TEXT NOT NULL,
  status           TEXT NOT NULL,      -- 'pending', 'done', 'failed' (nothing billed) or 'unknown'
  reserved_micros  INTEGER NOT NULL,   -- the most the call could have cost
  cost_micros      INTEGER NOT NULL DEFAULT 0,
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  month            TEXT NOT NULL,      -- YYYY-MM (UTC), for the monthly budget
  created_at       TEXT NOT NULL
);

CREATE INDEX idx_ai_calls_created ON ai_calls(created_at);
CREATE INDEX idx_ai_calls_month ON ai_calls(month);
