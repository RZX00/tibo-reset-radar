-- Forecast v2 is collected and evaluated in shadow mode before it may replace heuristic-v1.
-- None of these tables are read by the public API.

CREATE TABLE IF NOT EXISTS external_events (
  event_id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('official_status', 'official_release')),
  provider TEXT NOT NULL,
  event_type TEXT NOT NULL,
  title TEXT NOT NULL,
  source_url TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  known_at TEXT NOT NULL,
  ended_at TEXT,
  relevance REAL NOT NULL CHECK (relevance >= 0 AND relevance <= 1),
  severity REAL NOT NULL CHECK (severity >= 0 AND severity <= 1),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS external_events_known_at_idx
  ON external_events (known_at DESC);

CREATE TABLE IF NOT EXISTS external_source_status (
  source TEXT PRIMARY KEY,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_success_at TEXT,
  last_error_code TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS forecast_feature_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  generated_at TEXT NOT NULL,
  feature_version TEXT NOT NULL,
  model_maturity TEXT NOT NULL CHECK (
    model_maturity IN ('insufficient_history', 'shadow', 'backtested', 'calibrated')
  ),
  confirmed_reset_count INTEGER NOT NULL CHECK (confirmed_reset_count >= 0),
  target_coverage REAL NOT NULL CHECK (target_coverage >= 0 AND target_coverage <= 1),
  external_coverage REAL NOT NULL CHECK (external_coverage >= 0 AND external_coverage <= 1),
  input_hash TEXT NOT NULL,
  features_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (feature_version, input_hash)
);

CREATE INDEX IF NOT EXISTS forecast_feature_snapshots_generated_at_idx
  ON forecast_feature_snapshots (generated_at DESC);

CREATE TABLE IF NOT EXISTS forecast_model_versions (
  model_version TEXT PRIMARY KEY,
  feature_version TEXT NOT NULL,
  validation_status TEXT NOT NULL CHECK (
    validation_status IN ('shadow', 'backtested', 'calibrated')
  ),
  training_cutoff TEXT,
  confirmed_reset_count INTEGER NOT NULL CHECK (confirmed_reset_count >= 0),
  parameters_json TEXT NOT NULL DEFAULT '{}',
  metrics_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS shadow_forecast_runs (
  run_id TEXT PRIMARY KEY,
  generated_at TEXT NOT NULL,
  horizon_start TEXT NOT NULL,
  horizon_end TEXT NOT NULL,
  model_version TEXT NOT NULL,
  model_maturity TEXT NOT NULL CHECK (
    model_maturity IN ('insufficient_history', 'shadow', 'backtested', 'calibrated')
  ),
  feature_snapshot_id TEXT NOT NULL REFERENCES forecast_feature_snapshots(snapshot_id),
  input_hash TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS shadow_forecast_runs_generated_at_idx
  ON shadow_forecast_runs (generated_at DESC);
