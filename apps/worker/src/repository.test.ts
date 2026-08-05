import { SignalExtractionSchema } from "@tibo-radar/contracts";
import { migrate, RadarDatabase } from "@tibo-radar/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteWorkerRepository } from "./repository.js";

const GENERATED_AT = "2026-08-04T00:00:00.000Z";

let db: RadarDatabase;
let repository: SqliteWorkerRepository;

beforeEach(async () => {
  db = new RadarDatabase({ file: ":memory:" });
  await migrate(db, "db/migrations");
  repository = new SqliteWorkerRepository(db);
});

afterEach(async () => {
  await db.close();
});

describe("forecast signal time semantics", () => {
  it("does not treat recently backfilled history or pre-reset signals as current V1 evidence", async () => {
    await addSignal({
      postId: "old-backfill",
      createdAt: "2026-06-01T00:00:00.000Z",
      observedAt: "2026-08-03T23:00:00.000Z",
      extractedAt: "2026-08-03T23:01:00.000Z",
    });
    await addSignal({
      postId: "before-reset",
      createdAt: "2026-08-02T12:00:00.000Z",
      observedAt: "2026-08-03T23:00:00.000Z",
      extractedAt: "2026-08-03T23:02:00.000Z",
    });
    await addReset("reset-1", "2026-08-03T12:00:00.000Z");
    await addSignal({
      postId: "after-reset",
      createdAt: "2026-08-03T18:00:00.000Z",
      observedAt: "2026-08-03T23:00:00.000Z",
      extractedAt: "2026-08-03T23:03:00.000Z",
    });

    const context = await repository.getForecastContext(GENERATED_AT);
    expect(context.signals.map((signal) => signal.postId)).toEqual(["after-reset"]);
    expect(context.signals[0]?.sourceAt).toBe("2026-08-03T18:00:00.000Z");

    const shadowContext = await repository.getForecastV2Context(GENERATED_AT);
    expect(shadowContext.signals.map((signal) => signal.postId)).toEqual([
      "before-reset",
      "after-reset",
    ]);
    expect(shadowContext.signals[0]?.sourceAt).toBe("2026-08-02T12:00:00.000Z");
  });

  it("restores an in-window signal when the reset that cut it off is retracted", async () => {
    await addSignal({
      postId: "before-retracted-reset",
      createdAt: "2026-08-03T06:00:00.000Z",
      observedAt: "2026-08-03T23:00:00.000Z",
      extractedAt: "2026-08-03T23:01:00.000Z",
    });
    await addReset("reset-retracted", "2026-08-03T12:00:00.000Z");
    await db.query(
      `INSERT INTO reset_events (
         event_id, status, occurred_at, scope, evidence_post_ids, fingerprint,
         supersedes_event_id, created_at, updated_at
       ) VALUES (
         'retraction-1', 'retracted', NULL, 'unknown', '[]', 'retraction-fingerprint',
         'reset-retracted', '2026-08-03T18:00:00.000Z', '2026-08-03T18:00:00.000Z'
       )`,
    );

    const context = await repository.getForecastContext(GENERATED_AT);
    expect(context.signals.map((signal) => signal.postId)).toEqual(["before-retracted-reset"]);
  });
});

describe("forecast cadence and activity context", () => {
  it("counts the rolling 24-hour activity against a complete prior 14-day baseline", async () => {
    const generatedMs = Date.parse(GENERATED_AT);
    const baselineStart = new Date(generatedMs - 15 * 24 * 60 * 60 * 1_000).toISOString();
    await addPost("coverage-marker", baselineStart, "post");
    for (let dayOffset = 2; dayOffset <= 15; dayOffset += 1) {
      for (const hour of [1, 8, 16]) {
        await addPost(
          `baseline-${dayOffset}-${hour}`,
          new Date(
            generatedMs - dayOffset * 24 * 60 * 60 * 1_000 + hour * 60 * 60 * 1_000,
          ).toISOString(),
          hour === 8 ? "reply" : "post",
        );
      }
    }
    for (let hoursAgo = 1; hoursAgo <= 6; hoursAgo += 1) {
      await addPost(
        `recent-${hoursAgo}`,
        new Date(generatedMs - hoursAgo * 60 * 60 * 1_000).toISOString(),
        hoursAgo % 2 === 0 ? "reply" : "post",
      );
    }
    await addPost("recent-repost", "2026-08-03T23:30:00.000Z", "repost");
    await addReset("latest-reset", "2026-08-03T12:00:00.000Z");

    const context = await repository.getForecastContext(GENERATED_AT);

    expect(context.latestResetAt).toBe("2026-08-03T12:00:00.000Z");
    expect(context.activityMetrics).toEqual({
      recent24hPostCount: 6,
      baselineDailyPostAverage: 3,
      baselineWindowComplete: true,
    });
  });
});

async function addSignal(input: {
  postId: string;
  createdAt: string;
  observedAt: string;
  extractedAt: string;
}): Promise<void> {
  await db.query(
    `INSERT INTO source_posts (
       post_id, author_id, source_kind, source_url, content_hash, created_at, observed_at
     ) VALUES ($1, 'author', 'post', $2, $3, $4, $5)`,
    [
      input.postId,
      `https://x.com/author/status/${input.postId}`,
      `hash-${input.postId}`,
      input.createdAt,
      input.observedAt,
    ],
  );
  const extraction = SignalExtractionSchema.parse({
    explicitResetState: "future",
    futureCommitment: "explicit",
    timeHint: { kind: "none", startAt: null, endAt: null, rawPhrase: null },
    scope: "unknown",
    incidentSignal: 0,
    milestoneSignal: 0,
    resetRelevance: 0.9,
    sentiment: "neutral",
    confidence: 0.82,
    evidenceSpans: [],
    reasonCode: "rules_future",
  });
  await db.query(
    `INSERT INTO signal_extractions (
       extraction_id, post_id, schema_version, prompt_version, provider, model,
       input_version, input_hash, source_content_hash, result_json, confidence, extracted_at
     ) VALUES ($1, $2, '1.0', 'signal-v1', 'deterministic_rules', 'deterministic-rules',
               'source-post-v1', $3, $4, $5, $6, $7)`,
    [
      `extraction-${input.postId}`,
      input.postId,
      `input-${input.postId}`,
      `hash-${input.postId}`,
      JSON.stringify(extraction),
      extraction.confidence,
      input.extractedAt,
    ],
  );
}

async function addReset(eventId: string, occurredAt: string): Promise<void> {
  await db.query(
    `INSERT INTO reset_events (
       event_id, status, occurred_at, scope, evidence_post_ids, fingerprint,
       supersedes_event_id, created_at, updated_at
     ) VALUES ($1, 'confirmed_reset', $2, 'unknown', '[]', $3, NULL, $2, $2)`,
    [eventId, occurredAt, `fingerprint-${eventId}`],
  );
}

async function addPost(
  postId: string,
  createdAt: string,
  sourceKind: "post" | "reply" | "repost",
): Promise<void> {
  await db.query(
    `INSERT INTO source_posts (
       post_id, author_id, source_kind, source_url, content_hash, created_at, observed_at
     ) VALUES ($1, 'author', $2, $3, $4, $5, $5)`,
    [postId, sourceKind, `https://x.com/author/status/${postId}`, `hash-${postId}`, createdAt],
  );
}
