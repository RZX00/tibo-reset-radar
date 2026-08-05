import { migrate, RadarDatabase } from "@tibo-radar/db";
import { describe, expect, it } from "vitest";

import { inferSleepWindowUtc, isHourInWindow, SqliteRadarReadStore } from "./store.js";

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

describe("sleep inference", () => {
  it("finds the quietest eight-hour UTC window once enough posts exist", () => {
    const hourlyCounts = Array.from({ length: 24 }, () => 2);
    for (let hour = 6; hour < 14; hour += 1) hourlyCounts[hour] = 0;

    const window = inferSleepWindowUtc(hourlyCounts);

    expect(window).toEqual({ startHour: 6, endHour: 14, sampleSize: 32 });
    if (!window) throw new Error("sleep window was not inferred");
    expect(isHourInWindow(8, window)).toBe(true);
    expect(isHourInWindow(5, window)).toBe(false);
    expect(isHourInWindow(14, window)).toBe(false);
  });

  it("does not infer sleep from fewer than twenty posts", () => {
    const hourlyCounts = Array.from({ length: 24 }, () => 0);
    hourlyCounts[2] = 19;
    expect(inferSleepWindowUtc(hourlyCounts)).toBeNull();
  });

  it("exposes a sleep inference only when a quiet account is inside that window", async () => {
    const db = new RadarDatabase({ file: ":memory:" });
    await migrate(db, "db/migrations");
    const now = new Date("2026-08-05T08:00:00.000Z");
    await db.query(
      `INSERT INTO collector_cursors (
         source, cursor, consecutive_failures, last_success_at, updated_at
       ) VALUES ('test', NULL, 0, $1, $1)`,
      [now.toISOString()],
    );
    let postIndex = 0;
    for (let hour = 0; hour < 24; hour += 1) {
      if (hour >= 6 && hour < 14) continue;
      for (let copy = 0; copy < 2; copy += 1) {
        postIndex += 1;
        const createdAt = new Date(Date.UTC(2026, 7, 3, hour, copy)).toISOString();
        await db.query(
          `INSERT INTO source_posts (
             post_id, author_id, source_kind, source_url, content_hash, created_at, observed_at
           ) VALUES ($1, 'tibo', 'post', $2, $3, $4, $4)`,
          [
            `post-${postIndex}`,
            `https://x.com/tibo/status/${postIndex}`,
            `hash-${postIndex}`,
            createdAt,
          ],
        );
      }
    }
    const store = new SqliteRadarReadStore({
      db,
      serviceVersion: "test",
      demoMode: false,
      now: () => now,
    });

    try {
      await expect(store.getStatus()).resolves.toMatchObject({
        collector: { status: "fresh" },
        activity: {
          status: "quiet",
          likelySleeping: true,
          sleepWindowUtc: { startHour: 6, endHour: 14, sampleSize: 32 },
        },
      });
    } finally {
      await db.close();
    }
  });
});
