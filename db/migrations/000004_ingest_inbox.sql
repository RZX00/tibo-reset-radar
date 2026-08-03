-- Posts collected by an operator-run collector outside this deployment.
-- The API only appends here; the worker drains it exactly like any other timeline source,
-- so every dedup, edit, signal and forecast rule stays in one place.
CREATE TABLE IF NOT EXISTS ingest_inbox (
  post_id text PRIMARY KEY,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ingest_inbox_received_at_idx ON ingest_inbox (received_at);
