import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadEnvFile } from "node:process";

import pg from "pg";

import { buildServer } from "../apps/api/src/server.js";
import { PostgresRadarReadStore } from "../apps/api/src/store.js";
import { createDemoFixtures } from "../apps/worker/src/demo-fixtures.js";
import { InboxTimelineSource } from "../apps/worker/src/inbox-source.js";
import { PostgresWorkerRepository } from "../apps/worker/src/repository.js";
import { DeterministicOnlySignalAdapter, RadarWorker } from "../apps/worker/src/worker.js";
import {
  ForecastSnapshotSchema,
  SourcePostObservedSchema,
  TargetConfigSchema,
} from "../packages/contracts/dist/index.js";
import { DemoTimelineSource } from "../packages/x-source/dist/index.js";

loadLocalEnv();
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const target = TargetConfigSchema.parse(
  JSON.parse(await readFile(process.env.TARGET_CONFIG_PATH ?? "config/target.json", "utf8")),
);
assert.equal(target.mode, "demo", "integration test only runs with demo target configuration");

const pool = new pg.Pool({ connectionString: databaseUrl });
const repository = new PostgresWorkerRepository(pool);
const worker = new RadarWorker({
  source: new DemoTimelineSource(createDemoFixtures(target)),
  repository,
  target,
  signalAdapter: new DeterministicOnlySignalAdapter(),
});

try {
  await worker.runOnce();

  const originalText = "A test-only Reset timing note.";
  const original = SourcePostObservedSchema.parse({
    postId: "e2e-edit-delete",
    authorId: target.target.userId,
    authorDisplayName: target.target.displayName,
    authorHandle: target.target.handle,
    authorAvatarUrl: null,
    sourceKind: "reply",
    conversationId: "e2e-edit-delete",
    referencedPostIds: [],
    language: "en",
    sourceUrl: `https://x.com/${target.target.handle}/status/e2e-edit-delete`,
    text: originalText,
    contentHash: createHash("sha256").update(originalText).digest("hex"),
    createdAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
    editedAt: null,
    deletedAt: null,
  });
  await repository.persistBatch("e2e:edit-delete", { posts: [original], nextSinceId: null });
  await worker.processPendingSignals();

  const editedText = "A test-only Reset timing note, edited.";
  const edited = {
    ...original,
    text: editedText,
    contentHash: createHash("sha256").update(editedText).digest("hex"),
    observedAt: new Date().toISOString(),
    editedAt: new Date().toISOString(),
  };
  await repository.persistBatch("e2e:edit-delete", { posts: [edited], nextSinceId: null });
  await worker.processPendingSignals();

  const extractionCount = await pool.query<{ count: string }>(
    "SELECT count(*) FROM signal_extractions WHERE post_id = 'e2e-edit-delete'",
  );
  assert.equal(Number(extractionCount.rows[0]?.count), 2, "edited content must be re-extracted");

  await repository.persistBatch("e2e:edit-delete", {
    posts: [],
    nextSinceId: null,
    deletedPostIds: ["e2e-edit-delete"],
  });
  const deleted = await pool.query<{ deleted: boolean; text_cleared: boolean }>(
    `SELECT deleted_at IS NOT NULL AS deleted, text_ephemeral IS NULL AS text_cleared
     FROM source_posts WHERE post_id = 'e2e-edit-delete'`,
  );
  assert.deepEqual(deleted.rows[0], { deleted: true, text_cleared: true });

  // A collector pushes the newest posts first and history afterwards. Both have to land, so the
  // inbox drain must not be a since-id watermark.
  const inboxWorker = new RadarWorker({
    source: new InboxTimelineSource({ reader: repository }),
    repository,
    target,
    signalAdapter: new DeterministicOnlySignalAdapter(),
  });
  await pushToInbox(pool, target, "2084196918071357707", "Newest pushed post.");
  await inboxWorker.runOnce();
  await pushToInbox(pool, target, "2071381664853319742", "Older backfilled post.");
  await inboxWorker.runOnce();
  const backfilled = await pool.query<{ count: string }>(
    "SELECT count(*) FROM source_posts WHERE post_id IN ('2084196918071357707', '2071381664853319742')",
  );
  assert.equal(Number(backfilled.rows[0]?.count), 2, "backfilled history must not be stranded");

  const snapshotResult = await pool.query<{ summary_json: unknown }>(
    "SELECT summary_json FROM forecast_runs WHERE status = 'completed' ORDER BY generated_at DESC LIMIT 1",
  );
  const snapshot = ForecastSnapshotSchema.parse(snapshotResult.rows[0]?.summary_json);
  assert.equal(snapshot.days.flatMap((day) => day.buckets).length, 28);
  assert.equal(snapshot.dataFreshness.status, "fresh");

  const app = buildServer({
    store: new PostgresRadarReadStore({ pool, serviceVersion: "e2e", demoMode: true }),
  });
  const [status, forecast, events, reset, share] = await Promise.all([
    app.inject({ method: "GET", url: "/api/status" }),
    app.inject({ method: "GET", url: "/api/forecast?timezone=Asia%2FShanghai" }),
    app.inject({ method: "GET", url: "/api/events?window=24h" }),
    app.inject({ method: "GET", url: "/api/reset-status" }),
    app.inject({ method: "GET", url: "/api/share-card.png" }),
  ]);
  assert.equal(status.statusCode, 200);
  assert.equal(forecast.statusCode, 200);
  assert.ok(Array.isArray(events.json().items));
  assert.equal(reset.json().state, "forecasting");
  assert.deepEqual(share.rawPayload.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await app.close();

  console.log("Demo E2E passed: collect -> dedupe/edit/delete -> extract -> forecast -> API/PNG");
} finally {
  await pool.end();
}

async function pushToInbox(
  target_pool: pg.Pool,
  config: { target: { userId: string; handle: string; displayName: string } },
  postId: string,
  text: string,
): Promise<void> {
  const payload = SourcePostObservedSchema.parse({
    postId,
    authorId: config.target.userId,
    authorDisplayName: config.target.displayName,
    authorHandle: config.target.handle,
    authorAvatarUrl: null,
    sourceKind: "post",
    conversationId: null,
    referencedPostIds: [],
    language: "en",
    sourceUrl: `https://x.com/${config.target.handle}/status/${postId}`,
    text,
    contentHash: createHash("sha256").update(text).digest("hex"),
    createdAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
    editedAt: null,
    deletedAt: null,
  });
  await target_pool.query(
    `INSERT INTO ingest_inbox (post_id, payload) VALUES ($1, $2::jsonb)
     ON CONFLICT (post_id) DO UPDATE SET payload = EXCLUDED.payload`,
    [postId, JSON.stringify(payload)],
  );
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
