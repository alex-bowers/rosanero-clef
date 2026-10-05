CREATE TABLE articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  published_at TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  content_hash TEXT NOT NULL
);

CREATE TABLE chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL REFERENCES articles(id),
  position INTEGER NOT NULL,
  italian_text TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  heuristics_json TEXT,
  cefr_probs_json TEXT,
  cefr_expected REAL,
  cefr_top TEXT,
  cefr_confidence REAL,
  reference_en TEXT,
  translated_at TEXT,
  UNIQUE (article_id, position)
);

CREATE INDEX chunks_cefr_expected ON chunks (cefr_expected);

CREATE TABLE attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chunk_id INTEGER NOT NULL REFERENCES chunks(id),
  attempt_text TEXT NOT NULL,
  verdict_probs_json TEXT NOT NULL,
  verdict_top TEXT NOT NULL,
  fluency_score REAL NOT NULL,
  confidence REAL NOT NULL,
  needs_explanation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX attempts_chunk_id ON attempts (chunk_id);

CREATE TABLE explanations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL UNIQUE REFERENCES attempts(id),
  text TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  target_level TEXT NOT NULL DEFAULT 'B1',
  daily_chunk_cap INTEGER NOT NULL DEFAULT 20
);

INSERT INTO settings (id) VALUES (1);
