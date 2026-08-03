import { createHash, randomUUID } from "node:crypto";

import {
  type ForecastSnapshot,
  ForecastSnapshotSchema,
  type ResetEvent,
  SignalExtractionSchema,
  type SourcePostObserved,
  SourcePostObservedSchema,
} from "@tibo-radar/contracts";
import { nowIso, parseJsonColumn, type RadarDatabase } from "@tibo-radar/db";
import type { PersistedForecastSignal } from "@tibo-radar/forecast";
import type { ConfirmationDecision, SignalExtractionResult } from "@tibo-radar/signal";
import { SqliteSourceRepository, type TimelineCollection } from "@tibo-radar/x-source";

const FORECAST_SIGNAL_WINDOW_MS = 168 * 60 * 60 * 1_000;

export interface ForecastContext {
  signals: PersistedForecastSignal[];
  previousSnapshot: ForecastSnapshot | null;
  confirmedSignal: ResetEvent | null;
  lastObservedAt: string | null;
  lastPublicActivityAt: string | null;
  consecutiveFailures: number;
}

export class SqliteWorkerRepository {
  readonly source: SqliteSourceRepository;

  constructor(private readonly db: RadarDatabase) {
    this.source = new SqliteSourceRepository(db);
  }

  async getCursor(source: string) {
    return this.source.getCursor(source);
  }

  async persistBatch(source: string, collection: TimelineCollection) {
    await this.source.persistBatch(source, collection);
  }

  async persistStreamPost(post: SourcePostObserved) {
    await this.source.persistStreamPost(post);
  }

  async recordFailure(source: string, code: string) {
    await this.source.recordFailure(source, code);
  }

  async getPendingPosts(limit = 100): Promise<SourcePostObserved[]> {
    const result = await this.db.query<SourcePostRow>(
      `SELECT sp.* FROM source_posts sp
       WHERE sp.deleted_at IS NULL AND sp.text_ephemeral IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM signal_extractions se
           WHERE se.post_id = sp.post_id AND se.source_content_hash = sp.content_hash
         )
       ORDER BY sp.created_at ASC LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapPostRow);
  }

  async readInbox(_sinceId: string | null, limit: number): Promise<unknown[]> {
    // Outstanding rows, not "newer than the cursor". A collector may push history at any time —
    // a since-id watermark would silently strand every backfilled post older than what it already
    // saw. Comparing against what actually landed also picks up edits, whose content hash changes.
    // post_id is a snowflake, so ordering is numeric; lexical order breaks across digit counts.
    const result = await this.db.query<{ payload: string }>(
      `SELECT inbox.payload FROM ingest_inbox inbox
       LEFT JOIN source_posts stored ON stored.post_id = inbox.post_id
       WHERE inbox.post_id GLOB '[0-9]*'
         AND (stored.post_id IS NULL
              OR stored.content_hash IS NOT json_extract(inbox.payload, '$.contentHash'))
       ORDER BY CAST(inbox.post_id AS INTEGER) ASC LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => parseJsonColumn<unknown>(row.payload, null));
  }

  async saveExtraction(post: SourcePostObserved, result: SignalExtractionResult): Promise<void> {
    await this.db.query(
      `INSERT INTO signal_extractions (
         extraction_id, post_id, schema_version, prompt_version, provider, model,
         input_version, input_hash, source_content_hash, result_json, confidence, extracted_at
       ) VALUES ($1, $2, '1.0', $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (post_id, prompt_version, model, input_hash) DO NOTHING`,
      [
        randomUUID(),
        post.postId,
        result.provenance.promptVersion,
        result.provenance.method,
        result.provenance.model,
        result.provenance.inputSchemaVersion,
        result.provenance.inputHash,
        post.contentHash,
        JSON.stringify(result.extraction),
        result.extraction.confidence,
        nowIso(),
      ],
    );
  }

  async saveConfirmation(post: SourcePostObserved, decision: ConfirmationDecision): Promise<void> {
    const event = decision.event;
    if (!event) return;
    const fingerprint = createHash("sha256").update(`post:${post.postId}`).digest("hex");
    const now = nowIso();
    await this.db.transaction(async () => {
      const existing = await this.db.query<{
        event_id: string;
        supersedes_event_id: string | null;
      }>("SELECT event_id, supersedes_event_id FROM reset_events WHERE fingerprint = $1", [
        fingerprint,
      ]);
      let supersedesEventId = existing.rows[0]?.supersedes_event_id ?? null;
      if (!existing.rows[0]) {
        const previous = await this.db.query<{ event_id: string }>(
          `SELECT event_id FROM reset_events
           ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
        );
        supersedesEventId = previous.rows[0]?.event_id ?? null;
      }

      await this.db.query(
        `INSERT INTO reset_events (
           event_id, status, occurred_at, scope, evidence_post_ids, fingerprint,
           supersedes_event_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         ON CONFLICT (fingerprint) DO UPDATE SET
           status = excluded.status,
           occurred_at = excluded.occurred_at,
           scope = excluded.scope,
           evidence_post_ids = excluded.evidence_post_ids,
           supersedes_event_id = COALESCE(
             reset_events.supersedes_event_id,
             excluded.supersedes_event_id
           ),
           updated_at = excluded.updated_at`,
        [
          event.eventId,
          event.status,
          event.occurredAt,
          event.scope,
          JSON.stringify(event.evidencePostIds),
          fingerprint,
          supersedesEventId,
          now,
        ],
      );
    });
  }

  async getForecastContext(): Promise<ForecastContext> {
    const windowStart = new Date(Date.now() - FORECAST_SIGNAL_WINDOW_MS).toISOString();
    const [signalsResult, forecastResult, eventResult, statusResult] = await Promise.all([
      this.db.query<{
        post_id: string;
        observed_at: string;
        result_json: string;
      }>(
        // One row per post: the newest extraction wins, which is what MAX(extracted_at) selects
        // under SQLite's bare-column rule.
        `SELECT se.post_id, sp.observed_at, se.result_json, MAX(se.extracted_at) AS extracted_at
         FROM signal_extractions se JOIN source_posts sp ON sp.post_id = se.post_id
         WHERE sp.deleted_at IS NULL AND sp.observed_at >= $1
         GROUP BY se.post_id`,
        [windowStart],
      ),
      this.db.query<{ summary_json: string }>(
        `SELECT summary_json FROM forecast_runs WHERE status = 'completed'
         ORDER BY generated_at DESC LIMIT 1`,
      ),
      this.db.query<{
        event_id: string;
        status: "candidate_confirmation" | "confirmed_reset" | "retracted";
        occurred_at: string | null;
        scope: string;
        evidence_post_ids: string;
        supersedes_event_id: string | null;
      }>(
        `SELECT event_id, status, occurred_at, scope, evidence_post_ids, supersedes_event_id
         FROM reset_events ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
      ),
      this.db.query<{
        last_observed_at: string | null;
        last_public_activity_at: string | null;
        consecutive_failures: number;
      }>(
        `SELECT
           (SELECT MAX(last_success_at) FROM collector_cursors) AS last_observed_at,
           (SELECT MAX(created_at) FROM source_posts WHERE deleted_at IS NULL) AS last_public_activity_at,
           COALESCE((SELECT MAX(consecutive_failures) FROM collector_cursors), 0) AS consecutive_failures`,
      ),
    ]);
    const event = eventResult.rows[0];
    const status = statusResult.rows[0];
    const evidencePostIds = event ? parseJsonColumn<string[]>(event.evidence_post_ids, []) : [];
    return {
      signals: signalsResult.rows.map((row) => ({
        postId: row.post_id,
        observedAt: row.observed_at,
        extraction: SignalExtractionSchema.parse(parseJsonColumn(row.result_json, {})),
      })),
      previousSnapshot: forecastResult.rows[0]
        ? ForecastSnapshotSchema.parse(parseJsonColumn(forecastResult.rows[0].summary_json, {}))
        : null,
      confirmedSignal:
        event?.status === "confirmed_reset"
          ? {
              eventId: event.event_id,
              status: event.status,
              occurredAt: event.occurred_at,
              scope: event.scope,
              evidencePostIds: evidencePostIds.filter(
                (value): value is string => typeof value === "string",
              ),
              supersedesEventId: event.supersedes_event_id,
            }
          : null,
      lastObservedAt: status?.last_observed_at ?? null,
      lastPublicActivityAt: status?.last_public_activity_at ?? null,
      consecutiveFailures: status?.consecutive_failures ?? 0,
    };
  }

  async saveForecast(snapshot: ForecastSnapshot, inputHash: string): Promise<void> {
    await this.db.transaction(async () => {
      await this.db.query(
        `INSERT INTO forecast_runs (
           run_id, model_version, generated_at, horizon_start, horizon_end,
           validation_status, freshness_status, confidence, input_hash, status, summary_json
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'completed',$10)
         ON CONFLICT (run_id) DO UPDATE SET
           freshness_status = excluded.freshness_status,
           confidence = excluded.confidence,
           summary_json = excluded.summary_json`,
        [
          snapshot.runId,
          snapshot.model.version,
          snapshot.generatedAt,
          snapshot.horizonStart,
          snapshot.horizonEnd,
          snapshot.model.validationStatus,
          snapshot.dataFreshness.status,
          snapshot.dataFreshness.confidence,
          inputHash,
          JSON.stringify(snapshot),
        ],
      );
      await this.db.query("DELETE FROM forecast_buckets WHERE run_id = $1", [snapshot.runId]);
      for (const bucket of snapshot.days.flatMap((day) => day.buckets))
        await insertBucket(this.db, snapshot.runId, bucket);
    });
  }
}

interface SourcePostRow {
  post_id: string;
  author_id: string;
  source_kind: "post" | "reply" | "quote" | "repost";
  conversation_id: string | null;
  referenced_post_ids: string;
  language: string | null;
  source_url: string;
  content_hash: string;
  text_ephemeral: string | null;
  author_display_name: string | null;
  author_handle: string | null;
  author_avatar_url: string | null;
  created_at: string;
  observed_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

function mapPostRow(row: SourcePostRow): SourcePostObserved {
  return SourcePostObservedSchema.parse({
    postId: row.post_id,
    authorId: row.author_id,
    authorDisplayName: row.author_display_name,
    authorHandle: row.author_handle,
    authorAvatarUrl: row.author_avatar_url,
    sourceKind: row.source_kind,
    conversationId: row.conversation_id,
    referencedPostIds: parseJsonColumn<string[]>(row.referenced_post_ids, []),
    language: row.language,
    sourceUrl: row.source_url,
    text: row.text_ephemeral ?? "",
    contentHash: row.content_hash,
    createdAt: row.created_at,
    observedAt: row.observed_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
  });
}

async function insertBucket(
  db: RadarDatabase,
  runId: string,
  bucket: ForecastSnapshot["days"][number]["buckets"][number],
) {
  await db.query(
    `INSERT INTO forecast_buckets (
       run_id, bucket_index, start_at, end_at, hazard,
       interval_probability, cumulative_probability, reason_codes
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      runId,
      bucket.index,
      bucket.startAt,
      bucket.endAt,
      bucket.hazardProbability,
      bucket.intervalProbability,
      bucket.cumulativeProbability,
      JSON.stringify(bucket.topReasonCodes),
    ],
  );
}
