-- cf-bench run history.
-- Tasks themselves live in code, not in the database: a task is a seed/reset/
-- grade triple, and storing its definition here would let the two drift.

CREATE TABLE IF NOT EXISTS runs (
  id                TEXT PRIMARY KEY,
  task_id           TEXT NOT NULL,
  actor             TEXT NOT NULL CHECK (actor IN ('human', 'agent')),
  status            TEXT NOT NULL,          -- pending|running|grading|graded|error|cancelled
  passed            INTEGER,                -- 0|1, NULL until graded
  created_at        TEXT NOT NULL,
  finished_at       TEXT,
  graded_at         TEXT,

  coasty_run_id     TEXT,
  coasty_machine_id TEXT,
  coasty_status     TEXT,
  coasty_steps      INTEGER,
  coasty_cost_cents INTEGER,

  -- Returned exactly once when a Coasty run is created, and required to verify
  -- that run's webhooks. Never serialised to any API response.
  webhook_secret    TEXT,

  video_url         TEXT,                   -- human runs: screen recording
  notes             TEXT,
  error             TEXT
);

CREATE INDEX IF NOT EXISTS runs_by_task ON runs (task_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS runs_coasty
  ON runs (coasty_run_id) WHERE coasty_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS checks (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  ord     INTEGER NOT NULL,
  name    TEXT NOT NULL,
  pass    INTEGER NOT NULL,
  kind    TEXT NOT NULL,                    -- config|http
  detail  TEXT
);

CREATE INDEX IF NOT EXISTS checks_by_run ON checks (run_id, ord);

-- Webhook replay protection. A duplicate delivery of the same bytes is a
-- no-op rather than a second state transition.
CREATE TABLE IF NOT EXISTS webhook_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  coasty_run_id TEXT NOT NULL,
  event         TEXT NOT NULL,
  body_sha256   TEXT NOT NULL UNIQUE,
  signature_ts  INTEGER NOT NULL,
  received_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit (
  bucket       TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL
);
