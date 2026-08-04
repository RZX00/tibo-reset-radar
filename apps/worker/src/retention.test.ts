import { migrate, RadarDatabase } from "@tibo-radar/db";
import { beforeEach, describe, expect, it } from "vitest";

import { applyRetention } from "./retention.js";

const NOW = new Date("2026-08-04T12:00:00.000Z");
const POLICY = { fullResolutionHours: 6, hourlyDays: 30, inboxDays: 7 };

let db: RadarDatabase;

beforeEach(async () => {
  db = new RadarDatabase({ file: ":memory:" });
  await migrate(db, "db/migrations");
});

async function addRun(generatedAt: string): Promise<void> {
  await db.query(
    `INSERT INTO forecast_runs (
       run_id, model_version, generated_at, horizon_start, horizon_end, validation_status,
       freshness_status, confidence, input_hash, status, summary_json
     ) VALUES ($1,'heuristic-v1',$1,$1,$1,'heuristic','fresh',1,'hash','completed','{}')`,
    [generatedAt],
  );
}

async function runIds(): Promise<string[]> {
  const result = await db.query<{ run_id: string }>(
    "SELECT run_id FROM forecast_runs ORDER BY generated_at",
  );
  return result.rows.map((row) => row.run_id);
}

describe("snapshot retention", () => {
  it("keeps every snapshot inside the full-resolution window", async () => {
    for (const minute of ["00", "01", "02"]) await addRun(`2026-08-04T11:${minute}:00.000Z`);
    const report = await applyRetention(db, NOW, POLICY);
    expect(report.forecastRuns).toBe(0);
    expect(await runIds()).toHaveLength(3);
  });

  it("thins an older hour down to its newest snapshot", async () => {
    await addRun("2026-08-03T09:00:00.000Z");
    await addRun("2026-08-03T09:30:00.000Z");
    await addRun("2026-08-03T09:59:00.000Z");
    await addRun("2026-08-03T10:15:00.000Z");
    const report = await applyRetention(db, NOW, POLICY);
    expect(report.forecastRuns).toBe(2);
    expect(await runIds()).toEqual(["2026-08-03T09:59:00.000Z", "2026-08-03T10:15:00.000Z"]);
  });

  it("thins beyond the hourly window down to one snapshot per day", async () => {
    await addRun("2026-05-01T01:00:00.000Z");
    await addRun("2026-05-01T13:00:00.000Z");
    await addRun("2026-05-02T04:00:00.000Z");
    await applyRetention(db, NOW, POLICY);
    expect(await runIds()).toEqual(["2026-05-01T13:00:00.000Z", "2026-05-02T04:00:00.000Z"]);
  });

  it("never deletes the snapshot the API is serving", async () => {
    await addRun("2026-08-04T11:59:00.000Z");
    for (let index = 0; index < 40; index += 1) {
      const hour = String(Math.floor(index / 2)).padStart(2, "0");
      await addRun(`2026-07-04T${hour}:${index % 2 === 0 ? "00" : "30"}:00.000Z`);
    }
    await applyRetention(db, NOW, POLICY);
    expect(await runIds()).toContain("2026-08-04T11:59:00.000Z");
  });

  it("drops the buckets belonging to a deleted run", async () => {
    await addRun("2026-05-01T01:00:00.000Z");
    await addRun("2026-05-01T13:00:00.000Z");
    for (const runId of ["2026-05-01T01:00:00.000Z", "2026-05-01T13:00:00.000Z"]) {
      await db.query(
        `INSERT INTO forecast_buckets (
           run_id, bucket_index, start_at, end_at, hazard,
           interval_probability, cumulative_probability, reason_codes
         ) VALUES ($1, 0, $1, $1, 0.1, 0.1, 0.1, '[]')`,
        [runId],
      );
    }
    await applyRetention(db, NOW, POLICY);
    const buckets = await db.query<{ run_id: string }>("SELECT run_id FROM forecast_buckets");
    expect(buckets.rows.map((row) => row.run_id)).toEqual(["2026-05-01T13:00:00.000Z"]);
  });

  it("keeps an inbox row until the post it delivered is stored", async () => {
    const payload = JSON.stringify({ postId: "1", contentHash: "hash-1" });
    await db.query(
      "INSERT INTO ingest_inbox (post_id, payload, received_at) VALUES ('1', $1, '2026-07-01T00:00:00.000Z')",
      [payload],
    );
    const undelivered = await applyRetention(db, NOW, POLICY);
    expect(undelivered.inboxRows).toBe(0);

    await db.query(
      `INSERT INTO source_posts (
         post_id, author_id, source_kind, source_url, content_hash, created_at, observed_at
       ) VALUES ('1', 'author', 'post', 'https://x.com/a/status/1', 'hash-1', $1, $1)`,
      ["2026-07-01T00:00:00.000Z"],
    );
    const delivered = await applyRetention(db, NOW, POLICY);
    expect(delivered.inboxRows).toBe(1);
  });

  it("keeps a recent inbox row even after the post is stored", async () => {
    const payload = JSON.stringify({ postId: "2", contentHash: "hash-2" });
    await db.query(
      "INSERT INTO ingest_inbox (post_id, payload, received_at) VALUES ('2', $1, '2026-08-04T09:00:00.000Z')",
      [payload],
    );
    await db.query(
      `INSERT INTO source_posts (
         post_id, author_id, source_kind, source_url, content_hash, created_at, observed_at
       ) VALUES ('2', 'author', 'post', 'https://x.com/a/status/2', 'hash-2', $1, $1)`,
      ["2026-08-04T09:00:00.000Z"],
    );
    const report = await applyRetention(db, NOW, POLICY);
    expect(report.inboxRows).toBe(0);
  });
});
