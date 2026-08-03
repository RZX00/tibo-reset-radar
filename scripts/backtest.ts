import path from "node:path";
import { loadEnvFile } from "node:process";

import pg from "pg";

import { ForecastSnapshotSchema } from "../packages/contracts/dist/index.js";
import { evaluateBacktest } from "../packages/forecast/dist/index.js";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const windowSize = positiveInteger(process.env.BACKTEST_WINDOW ?? "200");
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });

try {
  const runs = await pool.query<{ summary_json: unknown; horizon_start: Date; horizon_end: Date }>(
    `SELECT summary_json, horizon_start, horizon_end
     FROM forecast_runs
     WHERE status = 'completed' AND horizon_end <= now()
     ORDER BY generated_at DESC
     LIMIT $1`,
    [windowSize],
  );
  const confirmed = await pool.query<{ occurred_at: Date }>(
    `SELECT occurred_at FROM reset_events
     WHERE status = 'confirmed_reset' AND occurred_at IS NOT NULL
     ORDER BY occurred_at`,
  );
  const cases = runs.rows.map((row) => {
    const snapshot = ForecastSnapshotSchema.parse(row.summary_json);
    const outcome = confirmed.rows.some(
      (event) => event.occurred_at >= row.horizon_start && event.occurred_at < row.horizon_end,
    )
      ? 1
      : 0;
    return { predictedProbability: snapshot.cumulative.within168h, outcome } as const;
  });
  const report = evaluateBacktest(cases);
  console.log(
    JSON.stringify(
      {
        status: report.sampleSize ? "evaluated" : "no_matured_runs",
        windowSize,
        generatedAt: new Date().toISOString(),
        ...report,
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
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
