-- Forecast snapshots are stored whole, so renaming a field in the snapshot contract leaves older
-- rows unreadable. They are disposable — the worker writes a new one every cycle — so drop the ones
-- that predate `signalLevel` instead of leaving the read path to trip over them.
DELETE FROM forecast_runs
WHERE json_extract(summary_json, '$.days[0].signalLevel') IS NULL;
