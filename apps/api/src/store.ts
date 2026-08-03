import {
  type ActivityStatus,
  type ForecastSnapshot,
  ForecastSnapshotSchema,
  type RadarStatus,
  type ResetEvent,
  ResetEventSchema,
  type SourcePostObserved,
  SourcePostObservedSchema,
} from "@tibo-radar/contracts";
import type { Pool } from "pg";

export interface RadarReadStore {
  getStatus(): Promise<RadarStatus>;
  getLatestForecast(): Promise<ForecastSnapshot | null>;
  getEvents(hours: number): Promise<SourcePostObserved[]>;
  getLatestResetEvent(): Promise<ResetEvent | null>;
}

export interface PostgresRadarReadStoreOptions {
  pool: Pool;
  serviceVersion: string;
  demoMode: boolean;
  now?: () => Date;
}

export class PostgresRadarReadStore implements RadarReadStore {
  readonly #pool: Pool;
  readonly #serviceVersion: string;
  readonly #demoMode: boolean;
  readonly #now: () => Date;

  constructor(options: PostgresRadarReadStoreOptions) {
    this.#pool = options.pool;
    this.#serviceVersion = options.serviceVersion;
    this.#demoMode = options.demoMode;
    this.#now = options.now ?? (() => new Date());
  }

  async getStatus(): Promise<RadarStatus> {
    const result = await this.#pool.query<{
      consecutive_failures: number;
      last_success_at: Date | null;
      last_public_activity_at: Date | null;
    }>(
      `SELECT
         COALESCE((SELECT MAX(consecutive_failures) FROM collector_cursors), 0)::int AS consecutive_failures,
         (SELECT MAX(last_success_at) FROM collector_cursors) AS last_success_at,
         (SELECT MAX(created_at) FROM source_posts WHERE deleted_at IS NULL) AS last_public_activity_at`,
    );
    const row = result.rows[0];
    const failures = row?.consecutive_failures ?? 0;
    const lastSuccessAt = row?.last_success_at ?? null;
    const lastActivityAt = row?.last_public_activity_at ?? null;
    const lagMs = lastSuccessAt
      ? this.#now().getTime() - lastSuccessAt.getTime()
      : Number.POSITIVE_INFINITY;

    return {
      serviceVersion: this.#serviceVersion,
      demoMode: this.#demoMode,
      collector: {
        status: lagMs <= 10 * 60_000 ? "fresh" : lagMs <= 30 * 60_000 ? "delayed" : "stale",
        lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
        consecutiveFailures: failures,
      },
      activity: {
        status: activityStatus(lastActivityAt, failures, this.#now()),
        lastPublicActivityAt: lastActivityAt?.toISOString() ?? null,
      },
    };
  }

  async getLatestForecast(): Promise<ForecastSnapshot | null> {
    const result = await this.#pool.query<{ summary_json: unknown }>(
      `SELECT summary_json FROM forecast_runs
       WHERE status = 'completed' ORDER BY generated_at DESC LIMIT 1`,
    );
    return result.rows[0] ? ForecastSnapshotSchema.parse(result.rows[0].summary_json) : null;
  }

  async getEvents(hours: number): Promise<SourcePostObserved[]> {
    const result = await this.#pool.query<{
      post_id: string;
      author_id: string;
      author_display_name: string | null;
      author_handle: string | null;
      author_avatar_url: string | null;
      source_kind: "post" | "reply" | "quote" | "repost";
      conversation_id: string | null;
      referenced_post_ids: unknown;
      language: string | null;
      source_url: string;
      text_ephemeral: string | null;
      content_hash: string;
      created_at: Date;
      observed_at: Date;
      edited_at: Date | null;
      deleted_at: Date | null;
    }>(
      `SELECT * FROM source_posts
       WHERE created_at >= now() - ($1::text || ' hours')::interval
         AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 200`,
      [hours],
    );
    return result.rows.map((row) =>
      SourcePostObservedSchema.parse({
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
      }),
    );
  }

  async getLatestResetEvent(): Promise<ResetEvent | null> {
    const result = await this.#pool.query<{
      event_id: string;
      status: ResetEvent["status"];
      occurred_at: Date | null;
      scope: string;
      evidence_post_ids: unknown;
      supersedes_event_id: string | null;
    }>(
      `SELECT event_id, status, occurred_at, scope, evidence_post_ids, supersedes_event_id
       FROM reset_events ORDER BY updated_at DESC, created_at DESC LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row) return null;
    return ResetEventSchema.parse({
      eventId: row.event_id,
      status: row.status,
      occurredAt: row.occurred_at?.toISOString() ?? null,
      scope: row.scope,
      evidencePostIds: Array.isArray(row.evidence_post_ids) ? row.evidence_post_ids : [],
      supersedesEventId: row.supersedes_event_id,
    });
  }
}

export function activityStatus(
  lastActivityAt: Date | null,
  consecutiveFailures: number,
  now: Date,
): ActivityStatus {
  if (consecutiveFailures >= 2) return "data_delayed";
  if (!lastActivityAt) return "quiet";
  const ageMs = Math.max(0, now.getTime() - lastActivityAt.getTime());
  if (ageMs <= 30 * 60_000) return "active";
  if (ageMs <= 3 * 60 * 60_000) return "cooling";
  return "quiet";
}
