ALTER TABLE reset_events
  ADD COLUMN IF NOT EXISTS supersedes_event_id text;

ALTER TABLE reset_events
  ADD CONSTRAINT reset_events_supersedes_event_id_fkey
  FOREIGN KEY (supersedes_event_id) REFERENCES reset_events(event_id);

CREATE INDEX IF NOT EXISTS reset_events_updated_at_idx
  ON reset_events (updated_at DESC, created_at DESC);
