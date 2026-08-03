ALTER TABLE reset_events
  ADD COLUMN supersedes_event_id TEXT REFERENCES reset_events(event_id);

CREATE INDEX IF NOT EXISTS reset_events_updated_at_idx
  ON reset_events (updated_at DESC, created_at DESC);
