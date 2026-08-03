import { createHash, randomUUID } from "node:crypto";

import {
  type ForecastSnapshot,
  ForecastSnapshotSchema,
  type ResetEvent,
  SignalExtractionSchema,
  type SourcePostObserved,
  SourcePostObservedSchema,
} from "@tibo-radar/contracts";
import type { PersistedForecastSignal } from "@tibo-radar/forecast";
import type { ConfirmationDecision, SignalExtractionResult } from "@tibo-radar/signal";
import { PostgresSourceRepository, type TimelineCollection } from "@tibo-radar/x-source";
import type { Pool, PoolClient } from "pg";

export interface ForecastContext {
  signals: PersistedForecastSignal[];
  previousSnapshot: ForecastSnapshot | null;
  confirmedSignal: ResetEvent | null;
  lastObservedAt: string | null;
  lastPublicActivityAt: string | null;
  consecutiveFailures: number;
}

export class PostgresWorkerRepository {
  readonly source: PostgresSourceRepository;

  constructor(private readonly pool: Pool) {
    this.source = new PostgresSourceRepository(pool);
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
    const result = await this.pool.query<SourcePostRow>(
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

  async saveExtraction(post: SourcePostObserved, result: SignalExtractionResult): Promise<void> {
    await this.pool.query(
      `INSERT INTO signal_extractions (
         extraction_id, post_id, schema_version, prompt_version, provider, model,
         input_version, input_hash, source_content_hash, result_json, confidence, extracted_at
       ) VALUES ($1, $2, '1.0', $3, $4, $5, $6, $7, $8, $9::jsonb, $10, now())
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
      ],
    );
  }

  async saveConfirmation(post: SourcePostObserved, decision: ConfirmationDecision): Promise<void> {
    if (!decision.event) return;
    const fingerprint = createHash("sha256").update(`post:${post.postId}`).digest("hex");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{
        event_id: string;
        supersedes_event_id: string | null;
      }>(
        "SELECT event_id, supersedes_event_id FROM reset_events WHERE fingerprint = $1 FOR UPDATE",
        [fingerprint],
      );
      let supersedesEventId = existing.rows[0]?.supersedes_event_id ?? null;
      if (!existing.rows[0]) {
        const previous = await client.query<{ event_id: string }>(
          `SELECT event_id FROM reset_events
           ORDER BY updated_at DESC, created_at DESC LIMIT 1
           FOR UPDATE`,
        );
        supersedesEventId = previous.rows[0]?.event_id ?? null;
      }

      await client.query(
        `INSERT INTO reset_events (
           event_id, status, occurred_at, scope, evidence_post_ids, fingerprint,
           supersedes_event_id, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, now(), now())
         ON CONFLICT (fingerprint) DO UPDATE SET
           status = EXCLUDED.status,
           occurred_at = EXCLUDED.occurred_at,
           scope = EXCLUDED.scope,
           evidence_post_ids = EXCLUDED.evidence_post_ids,
           supersedes_event_id = COALESCE(
             reset_events.supersedes_event_id,
             EXCLUDED.supersedes_event_id
           ),
           updated_at = now()`,
        [
          decision.event.eventId,
          decision.event.status,
          decision.event.occurredAt,
          decision.event.scope,
          JSON.stringify(decision.event.evidencePostIds),
          fingerprint,
          supersedesEventId,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getForecastContext(): Promise<ForecastContext> {
    const [signalsResult, forecastResult, eventResult, statusResult] = await Promise.all([
      this.pool.query<{
        post_id: string;
        observed_at: Date;
        result_json: unknown;
      }>(
        `SELECT DISTINCT ON (se.post_id) se.post_id, sp.observed_at, se.result_json
         FROM signal_extractions se JOIN source_posts sp ON sp.post_id = se.post_id
         WHERE sp.deleted_at IS NULL AND sp.observed_at >= now() - interval '168 hours'
         ORDER BY se.post_id, se.extracted_at DESC`,
      ),
      this.pool.query<{ summary_json: unknown }>(
        `SELECT summary_json FROM forecast_runs WHERE status = 'completed'
         ORDER BY generated_at DESC LIMIT 1`,
      ),
      this.pool.query<{
        event_id: string;
        status: "candidate_confirmation" | "confirmed_reset" | "retracted";
        occurred_at: Date | null;
        scope: string;
        evidence_post_ids: unknown;
        supersedes_event_id: string | null;
      }>(
        `SELECT event_id, status, occurred_at, scope, evidence_post_ids, supersedes_event_id
         FROM reset_events ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
      ),
      this.pool.query<{
        last_observed_at: Date | null;
        last_public_activity_at: Date | null;
        consecutive_failures: number;
      }>(
        `SELECT
           (SELECT MAX(last_success_at) FROM collector_cursors) AS last_observed_at,
           (SELECT MAX(created_at) FROM source_posts WHERE deleted_at IS NULL) AS last_public_activity_at,
           COALESCE((SELECT MAX(consecutive_failures) FROM collector_cursors), 0)::int AS consecutive_failures`,
      ),
    ]);
    const event = eventResult.rows[0];
    const status = statusResult.rows[0];
    return {
      signals: signalsResult.rows.map((row) => ({
        postId: row.post_id,
        observedAt: row.observed_at.toISOString(),
        extraction: SignalExtractionSchema.parse(row.result_json),
      })),
      previousSnapshot: forecastResult.rows[0]
        ? ForecastSnapshotSchema.parse(forecastResult.rows[0].summary_json)
        : null,
      confirmedSignal:
        event?.status === "confirmed_reset"
          ? {
              eventId: event.event_id,
              status: event.status,
              occurredAt: event.occurred_at?.toISOString() ?? null,
              scope: event.scope,
              evidencePostIds: Array.isArray(event.evidence_post_ids)
                ? event.evidence_post_ids.filter(
                    (value): value is string => typeof value === "string",
                  )
                : [],
              supersedesEventId: event.supersedes_event_id,
            }
          : null,
      lastObservedAt: status?.last_observed_at?.toISOString() ?? null,
      lastPublicActivityAt: status?.last_public_activity_at?.toISOString() ?? null,
      consecutiveFailures: status?.consecutive_failures ?? 0,
    };
  }

  async saveForecast(snapshot: ForecastSnapshot, inputHash: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO forecast_runs (
           run_id, model_version, generated_at, horizon_start, horizon_end,
           validation_status, freshness_status, confidence, input_hash, status, summary_json
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'completed',$10::jsonb)
         ON CONFLICT (run_id) DO UPDATE SET
           freshness_status = EXCLUDED.freshness_status,
           confidence = EXCLUDED.confidence,
           summary_json = EXCLUDED.summary_json`,
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
      await client.query("DELETE FROM forecast_buckets WHERE run_id = $1", [snapshot.runId]);
      for (const bucket of snapshot.days.flatMap((day) => day.buckets))
        await insertBucket(client, snapshot.runId, bucket);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

interface SourcePostRow {
  post_id: string;
  author_id: string;
  source_kind: "post" | "reply" | "quote" | "repost";
  conversation_id: string | null;
  referenced_post_ids: unknown;
  language: string | null;
  source_url: string;
  content_hash: string;
  text_ephemeral: string | null;
  author_display_name: string | null;
  author_handle: string | null;
  author_avatar_url: string | null;
  created_at: Date;
  observed_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
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
    referencedPostIds: Array.isArray(row.referenced_post_ids) ? row.referenced_post_ids : [],
    language: row.language,
    sourceUrl: row.source_url,
    text: row.text_ephemeral ?? "",
    contentHash: row.content_hash,
    createdAt: row.created_at.toISOString(),
    observedAt: row.observed_at.toISOString(),
    editedAt: row.edited_at?.toISOString() ?? null,
    deletedAt: row.deleted_at?.toISOString() ?? null,
  });
}

async function insertBucket(
  client: PoolClient,
  runId: string,
  bucket: ForecastSnapshot["days"][number]["buckets"][number],
) {
  await client.query(
    `INSERT INTO forecast_buckets (
       run_id, bucket_index, start_at, end_at, hazard,
       interval_probability, cumulative_probability, reason_codes
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
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
