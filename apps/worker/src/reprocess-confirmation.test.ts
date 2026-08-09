import { createHash } from "node:crypto";

import { SourcePostObservedSchema, TargetConfigSchema } from "@tibo-radar/contracts";
import { migrate, RadarDatabase } from "@tibo-radar/db";
import { extractSignalWithRules } from "@tibo-radar/signal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqliteWorkerRepository } from "./repository.js";
import { reprocessStoredConfirmation } from "./reprocess-confirmation.js";

const MISSED_POST_ID = "2086188036493344823";
const CREATED_AT = "2026-08-08T20:29:22.000Z";
const TARGET = TargetConfigSchema.parse({
  schemaVersion: "1.0",
  mode: "live",
  target: { userId: "1953337039510003712", handle: "thsottiaux", displayName: "Tibo" },
  authoritativeUserIds: ["1953337039510003712"],
  resetDefinition: "A public reset of usage limits",
  bankedResetPolicy: "forecast_only",
});

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

describe("reprocessStoredConfirmation", () => {
  it("records the already-extracted authoritative quote that the old policy skipped", async () => {
    const post = makePost(
      `That's right, GPT-5.6 Sol is awesome and can be used pretty much anywhere, including in the CC harness.

To celebrate this, together with the fact that I'm not going anywhere... I have reset usage limits for all paid users of ChatGPT Work and Codex.

Have fun out there!`,
    );
    await repository.persistBatch("test", { posts: [post], nextSinceId: null });
    await markAsAlreadyExtracted(post.postId, post.contentHash, post.text);
    expect(await repository.getPendingPosts()).toEqual([]);

    const result = await reprocessStoredConfirmation(repository, TARGET, post.postId);

    expect(result).toMatchObject({
      postId: MISSED_POST_ID,
      state: "confirmed_reset",
      reasonCode: "authoritative_completed_reset",
      eventId: `reset-${MISSED_POST_ID}`,
      occurredAt: CREATED_AT,
    });
    const context = await repository.getForecastContext("2026-08-10T00:00:00.000Z");
    expect(context.latestResetAt).toBe(CREATED_AT);
    expect(context.confirmedSignal?.eventId).toBe(`reset-${MISSED_POST_ID}`);

    await reprocessStoredConfirmation(repository, TARGET, post.postId);
    const events = await db.query("SELECT event_id FROM reset_events");
    expect(events.rowCount).toBe(1);
  });

  it("fails closed without writing an event when the stored post is not a reset announcement", async () => {
    const post = makePost("This is worth reading.");
    await repository.persistBatch("test", { posts: [post], nextSinceId: null });

    await expect(reprocessStoredConfirmation(repository, TARGET, post.postId)).rejects.toThrow(
      "no_completed_reset_claim",
    );
    const events = await db.query("SELECT event_id FROM reset_events");
    expect(events.rowCount).toBe(0);
  });
});

function makePost(text: string) {
  return SourcePostObservedSchema.parse({
    postId: MISSED_POST_ID,
    authorId: TARGET.target.userId,
    authorDisplayName: TARGET.target.displayName,
    authorHandle: TARGET.target.handle,
    authorAvatarUrl: null,
    sourceKind: "quote",
    conversationId: MISSED_POST_ID,
    referencedPostIds: ["2086181000000000000"],
    language: "en",
    sourceUrl: `https://x.com/${TARGET.target.handle}/status/${MISSED_POST_ID}`,
    text,
    contentHash: createHash("sha256").update(text).digest("hex"),
    createdAt: CREATED_AT,
    observedAt: "2026-08-09T04:08:06.697Z",
    editedAt: null,
    deletedAt: null,
  });
}

async function markAsAlreadyExtracted(
  postId: string,
  contentHash: string,
  text: string,
): Promise<void> {
  const extraction = extractSignalWithRules(text, CREATED_AT);
  await db.query(
    `INSERT INTO signal_extractions (
       extraction_id, post_id, schema_version, prompt_version, provider, model,
       input_version, input_hash, source_content_hash, result_json, confidence, extracted_at
     ) VALUES (
       'old-extraction', $1, '1.0', 'signal-v1', 'deterministic_rules',
       'deterministic-rules', 'source-post-v1', 'old-input', $2, $3, $4,
       '2026-08-09T04:08:07.000Z'
     )`,
    [postId, contentHash, JSON.stringify(extraction), extraction.confidence],
  );
}
