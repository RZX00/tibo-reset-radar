-- SQLite baseline. One process, one file, no database server.
--
-- Timestamps are ISO-8601 UTC text, which sorts and compares lexicographically, so MAX() and range
-- filters behave exactly as they read. JSON columns are text holding a JSON document.

CREATE TABLE IF NOT EXISTS radar_schema_migrations (
  version TEXT PRIMARY KEY,
  checksum TEXT,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS source_posts (
  post_id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('post', 'reply', 'quote', 'repost')),
  conversation_id TEXT,
  referenced_post_ids TEXT NOT NULL DEFAULT '[]',
  language TEXT,
  source_url TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  text_ephemeral TEXT,
  author_display_name TEXT,
  author_handle TEXT,
  author_avatar_url TEXT,
  created_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS source_posts_created_at_idx ON source_posts (created_at DESC);

CREATE TABLE IF NOT EXISTS collector_cursors (
  source TEXT PRIMARY KEY,
  cursor TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_success_at TEXT,
  last_error_code TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS signal_extractions (
  extraction_id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES source_posts(post_id) ON DELETE CASCADE,
  schema_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  source_content_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  extracted_at TEXT NOT NULL,
  UNIQUE (post_id, prompt_version, model, input_hash)
);

CREATE INDEX IF NOT EXISTS signal_extractions_post_content_idx
  ON signal_extractions (post_id, source_content_hash);

CREATE TABLE IF NOT EXISTS forecast_runs (
  run_id TEXT PRIMARY KEY,
  model_version TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  horizon_start TEXT NOT NULL,
  horizon_end TEXT NOT NULL,
  validation_status TEXT NOT NULL,
  freshness_status TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  summary_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS forecast_runs_generated_at_idx ON forecast_runs (generated_at DESC);

CREATE TABLE IF NOT EXISTS forecast_buckets (
  run_id TEXT NOT NULL REFERENCES forecast_runs(run_id) ON DELETE CASCADE,
  bucket_index INTEGER NOT NULL CHECK (bucket_index >= 0 AND bucket_index < 28),
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  hazard REAL NOT NULL CHECK (hazard >= 0 AND hazard <= 0.99),
  interval_probability REAL NOT NULL CHECK (interval_probability >= 0 AND interval_probability <= 0.99),
  cumulative_probability REAL NOT NULL CHECK (cumulative_probability >= 0 AND cumulative_probability <= 0.99),
  reason_codes TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (run_id, bucket_index)
);

CREATE TABLE IF NOT EXISTS reset_events (
  event_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('candidate_confirmation', 'confirmed_reset', 'retracted')),
  occurred_at TEXT,
  scope TEXT NOT NULL,
  evidence_post_ids TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS confirmation_reviews (
  review_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES reset_events(event_id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject', 'retract')),
  reviewer TEXT NOT NULL,
  reason TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS labels (
  label_id TEXT PRIMARY KEY,
  post_id TEXT REFERENCES source_posts(post_id) ON DELETE CASCADE,
  event_id TEXT REFERENCES reset_events(event_id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  labeled_by TEXT NOT NULL,
  labeled_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK ((post_id IS NOT NULL) + (event_id IS NOT NULL) = 1)
);

-- Posts collected by an operator-run collector outside this deployment. The HTTP surface only
-- appends here; the worker drains it exactly like any other timeline source.
CREATE TABLE IF NOT EXISTS ingest_inbox (
  post_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS ingest_inbox_received_at_idx ON ingest_inbox (received_at);
