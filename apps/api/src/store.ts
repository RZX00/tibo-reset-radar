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
import { parseJsonColumn, type RadarDatabase } from "@tibo-radar/db";

export interface RadarReadStore {
  getStatus(): Promise<RadarStatus>;
  getLatestForecast(): Promise<ForecastSnapshot | null>;
  getEvents(hours: number): Promise<SourcePostObserved[]>;
  getLatestResetEvent(): Promise<ResetEvent | null>;
}

export interface SqliteRadarReadStoreOptions {
  db: RadarDatabase;
  serviceVersion: string;
  demoMode: boolean;
  now?: () => Date;
}

export class SqliteRadarReadStore implements RadarReadStore {
  readonly #db: RadarDatabase;
  readonly #serviceVersion: string;
  readonly #demoMode: boolean;
  readonly #now: () => Date;

  constructor(options: SqliteRadarReadStoreOptions) {
    this.#db = options.db;
    this.#serviceVersion = options.serviceVersion;
    this.#demoMode = options.demoMode;
    this.#now = options.now ?? (() => new Date());
  }

  async getStatus(): Promise<RadarStatus> {
    const result = await this.#db.query<{
      consecutive_failures: number;
      last_success_at: string | null;
      last_public_activity_at: string | null;
    }>(
      `SELECT
         COALESCE((SELECT MAX(consecutive_failures) FROM collector_cursors), 0) AS consecutive_failures,
         (SELECT MAX(last_success_at) FROM collector_cursors) AS last_success_at,
         (SELECT MAX(created_at) FROM source_posts WHERE deleted_at IS NULL) AS last_public_activity_at`,
    );
    const row = result.rows[0];
    const failures = row?.consecutive_failures ?? 0;
    const lastSuccessAt = toDate(row?.last_success_at ?? null);
    const lastActivityAt = toDate(row?.last_public_activity_at ?? null);
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
    // A snapshot written under an older contract must read as "no forecast yet", which the API
    // already has an answer for, rather than taking the whole page down with a 500.
    const result = await this.#db.query<{ summary_json: string }>(
      `SELECT summary_json FROM forecast_runs
       WHERE status = 'completed' ORDER BY generated_at DESC LIMIT 5`,
    );
    for (const row of result.rows) {
      const parsed = ForecastSnapshotSchema.safeParse(parseJsonColumn(row.summary_json, {}));
      if (parsed.success) return parsed.data;
    }
    return null;
  }

  async getEvents(hours: number): Promise<SourcePostObserved[]> {
    const since = new Date(this.#now().getTime() - hours * 60 * 60 * 1_000).toISOString();
    const result = await this.#db.query<{
      post_id: string;
      author_id: string;
      author_display_name: string | null;
      author_handle: string | null;
      author_avatar_url: string | null;
      source_kind: "post" | "reply" | "quote" | "repost";
      conversation_id: string | null;
      referenced_post_ids: string;
      language: string | null;
      source_url: string;
      text_ephemeral: string | null;
      content_hash: string;
      created_at: string;
      observed_at: string;
      edited_at: string | null;
      deleted_at: string | null;
    }>(
      `SELECT * FROM source_posts
       WHERE created_at >= $1 AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 200`,
      [since],
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
        referencedPostIds: parseJsonColumn<string[]>(row.referenced_post_ids, []),
        language: row.language,
        sourceUrl: row.source_url,
        text: row.text_ephemeral ?? "",
        contentHash: row.content_hash,
        createdAt: row.created_at,
        observedAt: row.observed_at,
        editedAt: row.edited_at,
        deletedAt: row.deleted_at,
      }),
    );
  }

  async getLatestResetEvent(): Promise<ResetEvent | null> {
    const result = await this.#db.query<{
      event_id: string;
      status: ResetEvent["status"];
      occurred_at: string | null;
      scope: string;
      evidence_post_ids: string;
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
      occurredAt: row.occurred_at,
      scope: row.scope,
      evidencePostIds: parseJsonColumn<string[]>(row.evidence_post_ids, []),
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

function toDate(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
