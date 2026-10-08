-- Each press of the "Fetch new sentences" button, which replaced the daily cron.
CREATE TABLE crawl_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'running', -- running, done or failed
  step TEXT, -- the step in progress while running
  instance_id TEXT, -- the Workflow instance doing the work
  results_json TEXT, -- one StepResult per step, once done
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
