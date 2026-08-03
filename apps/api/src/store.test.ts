import { migrate, RadarDatabase } from "@tibo-radar/db";
import { describe, expect, it } from "vitest";

import { SqliteRadarReadStore } from "./store.js";

async function storeWithSnapshots(summaries: unknown[]): Promise<SqliteRadarReadStore> {
  const db = new RadarDatabase({ file: ":memory:" });
  await migrate(db, "db/migrations");
  for (const [index, summary] of summaries.entries()) {
    await db.query(
      `INSERT INTO forecast_runs (
         run_id, model_version, generated_at, horizon_start, horizon_end, validation_status,
         freshness_status, confidence, input_hash, status, summary_json
       ) VALUES ($1,'heuristic-v1',$2,$2,$2,'heuristic','fresh',1,'hash','completed',$3)`,
      [`run-${index}`, `2026-08-0${index + 1}T00:00:00.000Z`, JSON.stringify(summary)],
    );
  }
  return new SqliteRadarReadStore({ db, serviceVersion: "test", demoMode: false });
}

describe("forecast reads", () => {
  it("reports no forecast instead of failing when the newest snapshot predates the contract", async () => {
    const store = await storeWithSnapshots([
      { schemaVersion: "1.0", days: [{ weatherCode: "clear" }] },
    ]);
    await expect(store.getLatestForecast()).resolves.toBeNull();
  });

  it("returns nothing rather than a partially valid snapshot", async () => {
    const store = await storeWithSnapshots([{ nonsense: true }]);
    await expect(store.getLatestForecast()).resolves.toBeNull();
  });
});
