import path from "node:path";
import { loadEnvFile } from "node:process";

import { ShadowForecastV2Schema } from "../packages/contracts/dist/index.js";
import { RadarDatabase } from "../packages/db/dist/index.js";
import { evaluateBacktest } from "../packages/forecast/dist/index.js";

loadLocalEnv();
const windowSize = positiveInteger(process.env.BACKTEST_WINDOW ?? "200");
const now = new Date();
const firstMaturedAt = new Date(now.getTime() - 24 * 60 * 60 * 1_000).toISOString();
const db = new RadarDatabase({ file: process.env.RADAR_DB_PATH ?? path.resolve("data/radar.db") });

try {
  const schema = await db.query<{ present: number }>(
    `SELECT EXISTS(
       SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'shadow_forecast_runs'
     ) AS present`,
  );
  if (!schema.rows[0]?.present) {
    console.log(
      JSON.stringify(
        {
          status: "schema_not_migrated",
          model: "survival-v2-shadow",
          publicImpact: "none",
          nextStep: "Run pnpm db:migrate against the same RADAR_DB_PATH, then retry.",
        },
        null,
        2,
      ),
    );
  } else {
    const runs = await db.query<{ summary_json: string; generated_at: string }>(
      `SELECT summary_json, generated_at
       FROM shadow_forecast_runs
       WHERE generated_at <= $2
       ORDER BY generated_at DESC
       LIMIT $1`,
      [windowSize, firstMaturedAt],
    );
    const resetRows = await db.query<{
      event_id: string;
      status: "candidate_confirmation" | "confirmed_reset" | "retracted";
      occurred_at: string | null;
      scope: string;
      supersedes_event_id: string | null;
    }>(
      `SELECT event_id, status, occurred_at, scope, supersedes_event_id
       FROM reset_events ORDER BY occurred_at`,
    );
    const retractedIds = new Set(
      resetRows.rows.flatMap((event) =>
        event.status === "retracted" && event.supersedes_event_id
          ? [event.supersedes_event_id]
          : [],
      ),
    );
    const effectiveResetTimes = resetRows.rows.flatMap((event) =>
      event.status === "confirmed_reset" &&
      event.occurred_at !== null &&
      (event.scope === "all" || event.scope === "unknown") &&
      !retractedIds.has(event.event_id)
        ? [Date.parse(event.occurred_at)]
        : [],
    );
    const snapshots = runs.rows.map((row) => ({
      generatedMs: Date.parse(row.generated_at),
      snapshot: ShadowForecastV2Schema.parse(JSON.parse(row.summary_json)),
    }));
    const horizons = [24, 72, 168] as const;
    const reports = Object.fromEntries(
      horizons.map((hours) => {
        const cases = snapshots.flatMap(({ generatedMs, snapshot }) => {
          const horizonEnd = generatedMs + hours * 60 * 60 * 1_000;
          if (horizonEnd > now.getTime()) return [];
          const outcome = effectiveResetTimes.some(
            (occurredMs) => occurredMs >= generatedMs && occurredMs < horizonEnd,
          )
            ? 1
            : 0;
          const predictedProbability =
            hours === 24
              ? snapshot.cumulative.within24h
              : hours === 72
                ? snapshot.cumulative.within72h
                : snapshot.cumulative.within168h;
          return [{ predictedProbability, outcome }];
        });
        return [`within${hours}h`, evaluateBacktest(cases)];
      }),
    );
    console.log(
      JSON.stringify(
        {
          status: snapshots.length ? "evaluated_available_horizons" : "no_matured_runs",
          model: "survival-v2-shadow",
          publicImpact: "none",
          windowSize,
          generatedAt: now.toISOString(),
          reports,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await db.close();
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("BACKTEST_WINDOW must be positive");
  return parsed;
}

function loadLocalEnv(): void {
  try {
    loadEnvFile(path.resolve(".env"));
  } catch (error) {
    if (
      !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
}
