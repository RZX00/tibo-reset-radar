CREATE TABLE IF NOT EXISTS radar_schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_posts (
  post_id text PRIMARY KEY,
  author_id text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('post', 'reply', 'quote', 'repost')),
  conversation_id text,
  referenced_post_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  language text,
  source_url text NOT NULL,
  content_hash text NOT NULL,
  text_ephemeral text,
  author_display_name text,
  author_handle text,
  author_avatar_url text,
  created_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  edited_at timestamptz,
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS source_posts_created_at_idx ON source_posts (created_at DESC);

CREATE TABLE IF NOT EXISTS collector_cursors (
  source text PRIMARY KEY,
  cursor text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_success_at timestamptz,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS signal_extractions (
  extraction_id text PRIMARY KEY,
  post_id text NOT NULL REFERENCES source_posts(post_id) ON DELETE CASCADE,
  schema_version text NOT NULL,
  prompt_version text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  input_hash text NOT NULL,
  result_json jsonb NOT NULL,
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  extracted_at timestamptz NOT NULL,
  UNIQUE (post_id, prompt_version, model, input_hash)
);

CREATE TABLE IF NOT EXISTS forecast_runs (
  run_id text PRIMARY KEY,
  model_version text NOT NULL,
  generated_at timestamptz NOT NULL,
  horizon_start timestamptz NOT NULL,
  horizon_end timestamptz NOT NULL,
  validation_status text NOT NULL,
  freshness_status text NOT NULL,
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  input_hash text NOT NULL,
  status text NOT NULL,
  summary_json jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS forecast_runs_generated_at_idx ON forecast_runs (generated_at DESC);

CREATE TABLE IF NOT EXISTS forecast_buckets (
  run_id text NOT NULL REFERENCES forecast_runs(run_id) ON DELETE CASCADE,
  bucket_index integer NOT NULL CHECK (bucket_index >= 0 AND bucket_index < 28),
  start_at timestamptz NOT NULL,
  end_at timestamptz NOT NULL,
  hazard double precision NOT NULL CHECK (hazard >= 0 AND hazard <= 0.99),
  interval_probability double precision NOT NULL CHECK (interval_probability >= 0 AND interval_probability <= 0.99),
  cumulative_probability double precision NOT NULL CHECK (cumulative_probability >= 0 AND cumulative_probability <= 0.99),
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (run_id, bucket_index)
);

CREATE TABLE IF NOT EXISTS reset_events (
  event_id text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('candidate_confirmation', 'confirmed_reset', 'retracted')),
  occurred_at timestamptz,
  scope text NOT NULL,
  evidence_post_ids jsonb NOT NULL,
  fingerprint text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS confirmation_reviews (
  review_id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES reset_events(event_id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('approve', 'reject', 'retract')),
  reviewer text NOT NULL,
  reason text NOT NULL,
  rule_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS labels (
  label_id text PRIMARY KEY,
  post_id text REFERENCES source_posts(post_id) ON DELETE CASCADE,
  event_id text REFERENCES reset_events(event_id) ON DELETE CASCADE,
  label text NOT NULL,
  labeled_by text NOT NULL,
  labeled_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((post_id IS NOT NULL)::int + (event_id IS NOT NULL)::int = 1)
);
