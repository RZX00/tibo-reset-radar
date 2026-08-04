import type { RadarDatabase } from "@tibo-radar/db";

export interface RetentionPolicy {
  /** Every snapshot generated inside this window is kept as-is. */
  fullResolutionHours: number;
  /** Past the full-resolution window and inside this one, keep one snapshot per hour. */
  hourlyDays: number;
  /** Inbox rows already stored as posts are dropped after this many days. */
  inboxDays: number;
}

export interface RetentionReport {
  forecastRuns: number;
  shadowRuns: number;
  featureSnapshots: number;
  inboxRows: number;
  reclaimed: boolean;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  fullResolutionHours: 6,
  hourlyDays: 30,
  inboxDays: 7,
};

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Forecast snapshots are written every cycle, so the table grows without bound while the API only
 * ever reads the newest row and the backtest only needs a sample per matured window. Recent
 * snapshots stay at full resolution, the last month thins to hourly, and everything older thins to
 * daily — a shape that keeps debugging and calibration possible on a bounded disk.
 *
 * Evidence is never touched: posts, extractions and reset events are the audit trail.
 */
export async function applyRetention(
  db: RadarDatabase,
  now: Date,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
): Promise<RetentionReport> {
  const fullResolutionSince = new Date(
    now.getTime() - policy.fullResolutionHours * HOUR_MS,
  ).toISOString();
  const hourlySince = new Date(now.getTime() - policy.hourlyDays * DAY_MS).toISOString();
  const inboxBefore = new Date(now.getTime() - policy.inboxDays * DAY_MS).toISOString();

  const forecastRuns = await thinSnapshots(
    db,
    "forecast_runs",
    "run_id",
    fullResolutionSince,
    hourlySince,
  );
  // Shadow runs reference feature snapshots, so they have to go first or the delete is refused.
  const shadowRuns = await thinSnapshots(
    db,
    "shadow_forecast_runs",
    "run_id",
    fullResolutionSince,
    hourlySince,
  );
  const featureSnapshots = await db.query(
    `DELETE FROM forecast_feature_snapshots
     WHERE generated_at < $1
       AND snapshot_id NOT IN (SELECT feature_snapshot_id FROM shadow_forecast_runs)`,
    [fullResolutionSince],
  );
  // An inbox row is a delivery receipt. Once the post is stored under the same content hash it has
  // done its job; keeping it duplicates every post forever.
  const inboxRows = await db.query(
    `DELETE FROM ingest_inbox
     WHERE received_at < $1
       AND EXISTS (
         SELECT 1 FROM source_posts stored
         WHERE stored.post_id = ingest_inbox.post_id
           AND stored.content_hash = json_extract(ingest_inbox.payload, '$.contentHash')
       )`,
    [inboxBefore],
  );

  const deleted = forecastRuns + shadowRuns + featureSnapshots.rowCount + inboxRows.rowCount > 0;
  // SQLite keeps freed pages in the file, so without this the disk never actually shrinks.
  if (deleted) db.exec("VACUUM");

  return {
    forecastRuns,
    shadowRuns,
    featureSnapshots: featureSnapshots.rowCount,
    inboxRows: inboxRows.rowCount,
    reclaimed: deleted,
  };
}

async function thinSnapshots(
  db: RadarDatabase,
  table: "forecast_runs" | "shadow_forecast_runs",
  idColumn: "run_id",
  fullResolutionSince: string,
  hourlySince: string,
): Promise<number> {
  // Inside the full-resolution window every row buckets to itself, so it always ranks first and is
  // never a deletion candidate — including the newest snapshot the API serves.
  const result = await db.query(
    `DELETE FROM ${table} WHERE ${idColumn} IN (
       SELECT ${idColumn} FROM (
         SELECT ${idColumn},
                ROW_NUMBER() OVER (
                  PARTITION BY bucket ORDER BY generated_at DESC, ${idColumn} DESC
                ) AS bucket_rank
         FROM (
           SELECT ${idColumn}, generated_at,
                  CASE
                    WHEN generated_at >= $1 THEN ${idColumn}
                    WHEN generated_at >= $2 THEN substr(generated_at, 1, 13)
                    ELSE substr(generated_at, 1, 10)
                  END AS bucket
           FROM ${table}
         )
       ) WHERE bucket_rank > 1
     )`,
    [fullResolutionSince, hourlySince],
  );
  return result.rowCount;
}

export function retentionPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  return {
    fullResolutionHours: positiveNumber(
      env.RADAR_RETENTION_FULL_HOURS,
      DEFAULT_RETENTION_POLICY.fullResolutionHours,
    ),
    hourlyDays: positiveNumber(
      env.RADAR_RETENTION_HOURLY_DAYS,
      DEFAULT_RETENTION_POLICY.hourlyDays,
    ),
    inboxDays: positiveNumber(env.RADAR_RETENTION_INBOX_DAYS, DEFAULT_RETENTION_POLICY.inboxDays),
  };
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
