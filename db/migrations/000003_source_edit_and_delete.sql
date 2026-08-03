ALTER TABLE signal_extractions
  ADD COLUMN IF NOT EXISTS source_content_hash text;

UPDATE signal_extractions se
SET source_content_hash = sp.content_hash
FROM source_posts sp
WHERE se.post_id = sp.post_id AND se.source_content_hash IS NULL;

ALTER TABLE signal_extractions
  ALTER COLUMN source_content_hash SET NOT NULL;

CREATE INDEX IF NOT EXISTS signal_extractions_post_content_idx
  ON signal_extractions (post_id, source_content_hash);
