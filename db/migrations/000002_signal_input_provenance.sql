ALTER TABLE signal_extractions
  ADD COLUMN IF NOT EXISTS input_version text NOT NULL DEFAULT 'source-post-v1';

ALTER TABLE signal_extractions
  ALTER COLUMN input_version DROP DEFAULT;
