-- Accepted API requests, counted to enforce the per-minute and daily limits.
CREATE TABLE request_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX request_log_route_at ON request_log (route, at);

-- Every call to Workers AI, for latency and cost tracking (Clef compared with Jev, for example).
CREATE TABLE ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  ok INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER
);

CREATE INDEX ai_calls_at ON ai_calls (at);
