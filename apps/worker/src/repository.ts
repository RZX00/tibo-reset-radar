import { createHash, randomUUID } from "node:crypto";

import {
  type ExternalEvent,
  ExternalEventSchema,
  type ForecastSnapshot,
  ForecastSnapshotSchema,
  ForecastV2CoefficientsSchema,
  type ForecastV2FeatureSnapshot,
  ForecastV2ModelParametersSchema,
  type ResetEvent,
  type ShadowForecastV2,
  SignalExtractionSchema,
  type SourcePostObserved,
  SourcePostObservedSchema,
} from "@tibo-radar/contracts";
import { nowIso, parseJsonColumn, type RadarDatabase } from "@tibo-radar/db";
import {
  FORECAST_V2_FEATURE_VERSION,
  type ForecastV2ModelParameters,
  type ForecastV2Post,
  type ForecastV2ResetRecord,
  type ForecastV2Signal,
  type PersistedForecastSignal,
} from "@tibo-radar/forecast";
import type { ConfirmationDecision, SignalExtractionResult } from "@tibo-radar/signal";
import { SqliteSourceRepository, type TimelineCollection } from "@tibo-radar/x-source";

const FORECAST_SIGNAL_WINDOW_MS = 168 * 60 * 60 * 1_000;
const FORECAST_V2_POST_WINDOW_MS = 90 * 24 * 60 * 60 * 1_000;
const FORECAST_V2_EXTERNAL_WINDOW_MS = 180 * 24 * 60 * 60 * 1_000;

export interface ForecastContext {
  signals: PersistedForecastSignal[];
  previousSnapshot: ForecastSnapshot | null;
  confirmedSignal: ResetEvent | null;
  lastObservedAt: string | null;
  lastPublicActivityAt: string | null;
  consecutiveFailures: number;
}

export interface ForecastV2Context {
  posts: ForecastV2Post[];
  signals: ForecastV2Signal[];
  resetEvents: ForecastV2ResetRecord[];
  externalEvents: ExternalEvent[];
  targetCoverage: number;
  externalCoverage: number;
  parameters?: ForecastV2ModelParameters;
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

  async upsertExternalEvents(events: readonly ExternalEvent[]): Promise<void> {
    const validated = events.map((event) => ExternalEventSchema.parse(event));
    await this.db.transaction(async () => {
      for (const event of validated) {
        const contentHash = createHash("sha256").update(JSON.stringify(event)).digest("hex");
        await this.db.query(
          `INSERT INTO external_events (
             event_id, source_type, provider, event_type, title, source_url,
             occurred_at, known_at, ended_at, relevance, severity, metadata_json,
             content_hash, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
           ON CONFLICT (event_id) DO UPDATE SET
             source_type = excluded.source_type,
             provider = excluded.provider,
             event_type = excluded.event_type,
             title = excluded.title,
             source_url = excluded.source_url,
             occurred_at = excluded.occurred_at,
             known_at = MIN(external_events.known_at, excluded.known_at),
             ended_at = excluded.ended_at,
             relevance = excluded.relevance,
             severity = excluded.severity,
             metadata_json = excluded.metadata_json,
             content_hash = excluded.content_hash,
             updated_at = excluded.updated_at`,
          [
            event.eventId,
            event.sourceType,
            event.provider,
            event.eventType,
            event.title,
            event.sourceUrl,
            event.occurredAt,
            event.knownAt,
            event.endedAt,
            event.relevance,
            event.severity,
            JSON.stringify(event.metadata),
            contentHash,
            nowIso(),
          ],
        );
      }
    });
  }

  async recordExternalSuccess(source: string, observedAt: string): Promise<void> {
    await this.db.query(
      `INSERT INTO external_source_status (
         source, consecutive_failures, last_success_at, last_error_code, updated_at
       ) VALUES ($1,0,$2,NULL,$2)
       ON CONFLICT (source) DO UPDATE SET
         consecutive_failures = 0,
         last_success_at = excluded.last_success_at,
         last_error_code = NULL,
         updated_at = excluded.updated_at`,
      [source, observedAt],
    );
  }

  async recordExternalFailure(source: string, code: string, observedAt: string): Promise<void> {
    await this.db.query(
      `INSERT INTO external_source_status (
         source, consecutive_failures, last_success_at, last_error_code, updated_at
       ) VALUES ($1,1,NULL,$2,$3)
       ON CONFLICT (source) DO UPDATE SET
         consecutive_failures = external_source_status.consecutive_failures + 1,
         last_error_code = excluded.last_error_code,
         updated_at = excluded.updated_at`,
      [source, code, observedAt],
    );
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

  async getForecastContext(generatedAt: string): Promise<ForecastContext> {
    const generatedMs = Date.parse(generatedAt);
    if (!Number.isFinite(generatedMs)) throw new Error("generatedAt must be a valid ISO date-time");
    const windowStart = new Date(generatedMs - FORECAST_SIGNAL_WINDOW_MS).toISOString();
    const [forecastResult, eventResult, statusResult, latestResetResult] = await Promise.all([
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
      this.db.query<{ occurred_at: string }>(
        `SELECT confirmed.occurred_at
         FROM reset_events confirmed
         WHERE confirmed.status = 'confirmed_reset'
           AND confirmed.occurred_at IS NOT NULL
           AND confirmed.occurred_at <= $1
           AND confirmed.updated_at <= $1
           AND confirmed.scope IN ('all', 'unknown')
           AND NOT EXISTS (
             SELECT 1 FROM reset_events correction
             WHERE correction.status = 'retracted'
               AND correction.supersedes_event_id = confirmed.event_id
               AND correction.updated_at <= $1
           )
         ORDER BY confirmed.occurred_at DESC LIMIT 1`,
        [generatedAt],
      ),
    ]);
    const latestResetAt = latestResetResult.rows[0]?.occurred_at ?? null;
    // A late backfill must retain source chronology. Evidence resolved by the latest effective
    // primary Reset belongs to the previous cycle and cannot predict the next one.
    const signalsResult = await this.db.query<{
      post_id: string;
      source_at: string;
      result_json: string;
    }>(
      `WITH latest AS (
         SELECT post_id, MAX(extracted_at) AS extracted_at
         FROM signal_extractions
         WHERE extracted_at <= $3
         GROUP BY post_id
       )
       SELECT se.post_id, COALESCE(sp.edited_at, sp.created_at) AS source_at, se.result_json
       FROM latest
       JOIN signal_extractions se
         ON se.post_id = latest.post_id AND se.extracted_at = latest.extracted_at
       JOIN source_posts sp ON sp.post_id = se.post_id
       WHERE sp.deleted_at IS NULL
         AND COALESCE(sp.edited_at, sp.created_at) >= $1
         AND COALESCE(sp.edited_at, sp.created_at) <= $3
         AND ($2 IS NULL OR COALESCE(sp.edited_at, sp.created_at) > $2)
       ORDER BY source_at ASC, se.post_id ASC`,
      [windowStart, latestResetAt, generatedAt],
    );
    const event = eventResult.rows[0];
    const status = statusResult.rows[0];
    const evidencePostIds = event ? parseJsonColumn<string[]>(event.evidence_post_ids, []) : [];
    return {
      signals: signalsResult.rows.map((row) => ({
        postId: row.post_id,
        sourceAt: row.source_at,
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

  async getForecastV2Context(generatedAt: string): Promise<ForecastV2Context> {
    const generatedMs = Date.parse(generatedAt);
    if (!Number.isFinite(generatedMs)) throw new Error("generatedAt must be a valid ISO date-time");
    const postWindowStart = new Date(generatedMs - FORECAST_V2_POST_WINDOW_MS).toISOString();
    const signalWindowStart = new Date(generatedMs - FORECAST_SIGNAL_WINDOW_MS).toISOString();
    const externalWindowStart = new Date(
      generatedMs - FORECAST_V2_EXTERNAL_WINDOW_MS,
    ).toISOString();
    const [postsResult, signalsResult, resetsResult, externalResult, statusResult, modelResult] =
      await Promise.all([
        this.db.query<{
          post_id: string;
          created_at: string;
          source_kind: ForecastV2Post["sourceKind"];
          conversation_id: string | null;
        }>(
          `SELECT post_id, created_at, source_kind, conversation_id
           FROM source_posts
           WHERE deleted_at IS NULL AND created_at >= $1 AND created_at <= $2
           ORDER BY created_at ASC`,
          [postWindowStart, generatedAt],
        ),
        this.db.query<{
          post_id: string;
          source_at: string;
          result_json: string;
        }>(
          `WITH latest AS (
             SELECT se.post_id, MAX(se.extracted_at) AS extracted_at
             FROM signal_extractions se
             JOIN source_posts sp ON sp.post_id = se.post_id
             WHERE se.extracted_at <= $2
               AND sp.deleted_at IS NULL
               AND COALESCE(sp.edited_at, sp.created_at) >= $1
               AND COALESCE(sp.edited_at, sp.created_at) <= $2
             GROUP BY se.post_id
           )
           SELECT se.post_id, COALESCE(sp.edited_at, sp.created_at) AS source_at, se.result_json
           FROM latest
           JOIN signal_extractions se
             ON se.post_id = latest.post_id AND se.extracted_at = latest.extracted_at
           JOIN source_posts sp ON sp.post_id = se.post_id
           ORDER BY source_at ASC, se.post_id ASC`,
          [signalWindowStart, generatedAt],
        ),
        this.db.query<{
          event_id: string;
          status: ForecastV2ResetRecord["status"];
          occurred_at: string | null;
          scope: string;
          supersedes_event_id: string | null;
          updated_at: string;
        }>(
          `SELECT event_id, status, occurred_at, scope, supersedes_event_id, updated_at
           FROM reset_events WHERE updated_at <= $1
           ORDER BY updated_at ASC`,
          [generatedAt],
        ),
        this.db.query<{
          event_id: string;
          source_type: ExternalEvent["sourceType"];
          provider: string;
          event_type: string;
          title: string;
          source_url: string;
          occurred_at: string;
          known_at: string;
          ended_at: string | null;
          relevance: number;
          severity: number;
          metadata_json: string;
        }>(
          `SELECT event_id, source_type, provider, event_type, title, source_url,
                  occurred_at, known_at, ended_at, relevance, severity, metadata_json
           FROM external_events
           WHERE known_at >= $1 AND known_at <= $2 AND occurred_at <= $2
           ORDER BY known_at ASC`,
          [externalWindowStart, generatedAt],
        ),
        this.db.query<{
          target_last_success_at: string | null;
          target_failures: number;
          external_last_success_at: string | null;
          external_failures: number;
        }>(
          `SELECT
             (SELECT MAX(last_success_at) FROM collector_cursors) AS target_last_success_at,
             COALESCE((SELECT MAX(consecutive_failures) FROM collector_cursors), 0)
               AS target_failures,
             (SELECT MAX(last_success_at) FROM external_source_status)
               AS external_last_success_at,
             COALESCE((SELECT MAX(consecutive_failures) FROM external_source_status), 0)
               AS external_failures`,
        ),
        this.db.query<{
          model_version: string;
          validation_status: "backtested" | "calibrated";
          confirmed_reset_count: number;
          parameters_json: string;
        }>(
          `SELECT model_version, validation_status, confirmed_reset_count, parameters_json
           FROM forecast_model_versions
           WHERE feature_version = $1
             AND validation_status IN ('backtested', 'calibrated')
             AND (training_cutoff IS NULL OR training_cutoff <= $2)
           ORDER BY created_at DESC LIMIT 1`,
          [FORECAST_V2_FEATURE_VERSION, generatedAt],
        ),
      ]);

    const status = statusResult.rows[0];
    const model = modelResult.rows[0];
    const parameters = model
      ? ForecastV2ModelParametersSchema.parse({
          modelVersion: model.model_version,
          validationStatus: model.validation_status,
          trainedResetCount: model.confirmed_reset_count,
          coefficients: ForecastV2CoefficientsSchema.parse(
            parseJsonColumn(model.parameters_json, {}),
          ),
        })
      : undefined;
    return {
      posts: postsResult.rows.map((row) => ({
        postId: row.post_id,
        createdAt: row.created_at,
        sourceKind: row.source_kind,
        conversationId: row.conversation_id,
      })),
      signals: signalsResult.rows.map((row) => ({
        postId: row.post_id,
        sourceAt: row.source_at,
        extraction: SignalExtractionSchema.parse(parseJsonColumn(row.result_json, {})),
      })),
      resetEvents: resetsResult.rows.map((row) => ({
        eventId: row.event_id,
        status: row.status,
        occurredAt: row.occurred_at,
        knownAt: row.updated_at,
        scope: row.scope,
        supersedesEventId: row.supersedes_event_id,
      })),
      externalEvents: externalResult.rows.map((row) =>
        ExternalEventSchema.parse({
          eventId: row.event_id,
          sourceType: row.source_type,
          provider: row.provider,
          eventType: row.event_type,
          title: row.title,
          sourceUrl: row.source_url,
          occurredAt: row.occurred_at,
          knownAt: row.known_at,
          endedAt: row.ended_at,
          relevance: row.relevance,
          severity: row.severity,
          metadata: parseJsonColumn(row.metadata_json, {}),
        }),
      ),
      targetCoverage: freshnessCoverage(
        generatedMs,
        status?.target_last_success_at ?? null,
        status?.target_failures ?? 0,
      ),
      externalCoverage: freshnessCoverage(
        generatedMs,
        status?.external_last_success_at ?? null,
        status?.external_failures ?? 0,
      ),
      ...(parameters ? { parameters } : {}),
    };
  }

  async saveShadowForecast(
    features: ForecastV2FeatureSnapshot,
    forecast: ShadowForecastV2,
  ): Promise<void> {
    await this.db.transaction(async () => {
      const existing = await this.db.query<{ snapshot_id: string }>(
        `SELECT snapshot_id FROM forecast_feature_snapshots
         WHERE feature_version = $1 AND input_hash = $2 LIMIT 1`,
        [features.featureVersion, features.inputHash],
      );
      const snapshotId = existing.rows[0]?.snapshot_id ?? features.snapshotId;
      if (!existing.rows[0]) {
        await this.db.query(
          `INSERT INTO forecast_feature_snapshots (
             snapshot_id, generated_at, feature_version, model_maturity,
             confirmed_reset_count, target_coverage, external_coverage,
             input_hash, features_json
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            snapshotId,
            features.generatedAt,
            features.featureVersion,
            features.maturity,
            features.confirmedResetCount,
            features.coverage.target,
            features.coverage.external,
            features.inputHash,
            JSON.stringify(features),
          ],
        );
      }
      await this.db.query(
        `INSERT INTO shadow_forecast_runs (
           run_id, generated_at, horizon_start, horizon_end, model_version,
           model_maturity, feature_snapshot_id, input_hash, summary_json
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (run_id) DO UPDATE SET summary_json = excluded.summary_json`,
        [
          forecast.runId,
          forecast.generatedAt,
          forecast.horizonStart,
          forecast.horizonEnd,
          forecast.model.version,
          forecast.model.maturity,
          snapshotId,
          features.inputHash,
          JSON.stringify(forecast),
        ],
      );
    });
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

function freshnessCoverage(
  generatedMs: number,
  lastSuccessAt: string | null,
  consecutiveFailures: number,
): number {
  if (lastSuccessAt === null) return 0;
  const lastSuccessMs = Date.parse(lastSuccessAt);
  if (!Number.isFinite(lastSuccessMs) || lastSuccessMs > generatedMs) return 0;
  const ageMs = generatedMs - lastSuccessMs;
  const freshness = ageMs <= 10 * 60 * 1_000 ? 1 : ageMs <= 30 * 60 * 1_000 ? 0.7 : 0.35;
  return Math.max(0, freshness * 0.7 ** Math.min(Math.max(consecutiveFailures, 0), 3));
}
