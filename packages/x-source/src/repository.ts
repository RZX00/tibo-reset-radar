import type { SourcePostObserved } from "@tibo-radar/contracts";
import { nowIso, type RadarDatabase } from "@tibo-radar/db";

import type { TimelineCollection } from "./types.js";

export interface CollectorCursor {
  source: string;
  cursor: string | null;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
}

export class SqliteSourceRepository {
  constructor(private readonly db: RadarDatabase) {}

  async getCursor(source: string): Promise<CollectorCursor> {
    const result = await this.db.query<{
      source: string;
      cursor: string | null;
      consecutive_failures: number;
      last_success_at: string | null;
      last_error_code: string | null;
    }>(
      `SELECT source, cursor, consecutive_failures, last_success_at, last_error_code
         FROM collector_cursors WHERE source = $1`,
      [source],
    );
    const row = result.rows[0];
    return row
      ? {
          source: row.source,
          cursor: row.cursor,
          consecutiveFailures: row.consecutive_failures,
          lastSuccessAt: row.last_success_at,
          lastErrorCode: row.last_error_code,
        }
      : { source, cursor: null, consecutiveFailures: 0, lastSuccessAt: null, lastErrorCode: null };
  }

  async persistBatch(source: string, collection: TimelineCollection): Promise<void> {
    const now = nowIso();
    await this.db.transaction(async () => {
      for (const post of collection.posts) await upsertPost(this.db, post);
      for (const postId of collection.deletedPostIds ?? []) {
        await this.db.query(
          "UPDATE source_posts SET deleted_at = $1, text_ephemeral = NULL WHERE post_id = $2",
          [now, postId],
        );
      }
      await this.db.query(
        `INSERT INTO collector_cursors
           (source, cursor, consecutive_failures, last_success_at, last_error_code, updated_at)
         VALUES ($1, $2, 0, $3, NULL, $3)
         ON CONFLICT (source) DO UPDATE SET
           cursor = COALESCE(excluded.cursor, collector_cursors.cursor),
           consecutive_failures = 0,
           last_success_at = excluded.last_success_at,
           last_error_code = NULL,
           updated_at = excluded.updated_at`,
        [source, collection.nextSinceId, now],
      );
    });
  }

  async persistStreamPost(post: SourcePostObserved): Promise<void> {
    await upsertPost(this.db, post);
  }

  async recordFailure(source: string, errorCode: string): Promise<void> {
    await this.db.query(
      `INSERT INTO collector_cursors
         (source, consecutive_failures, last_error_code, updated_at)
       VALUES ($1, 1, $2, $3)
       ON CONFLICT (source) DO UPDATE SET
         consecutive_failures = collector_cursors.consecutive_failures + 1,
         last_error_code = excluded.last_error_code,
         updated_at = excluded.updated_at`,
      [source, errorCode.slice(0, 120), nowIso()],
    );
  }
}

async function upsertPost(db: RadarDatabase, post: SourcePostObserved): Promise<void> {
  await db.query(
    `INSERT INTO source_posts (
       post_id, author_id, source_kind, conversation_id, referenced_post_ids, language,
       source_url, content_hash, text_ephemeral, author_display_name, author_handle,
       author_avatar_url, created_at, observed_at, edited_at, deleted_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
     ) ON CONFLICT (post_id) DO UPDATE SET
       source_kind = excluded.source_kind,
       conversation_id = excluded.conversation_id,
       referenced_post_ids = excluded.referenced_post_ids,
       language = excluded.language,
       source_url = excluded.source_url,
       content_hash = excluded.content_hash,
       text_ephemeral = excluded.text_ephemeral,
       author_display_name = excluded.author_display_name,
       author_handle = excluded.author_handle,
       author_avatar_url = excluded.author_avatar_url,
       observed_at = MAX(source_posts.observed_at, excluded.observed_at),
       edited_at = COALESCE(excluded.edited_at, source_posts.edited_at),
       deleted_at = COALESCE(excluded.deleted_at, source_posts.deleted_at)`,
    [
      post.postId,
      post.authorId,
      post.sourceKind,
      post.conversationId,
      JSON.stringify(post.referencedPostIds),
      post.language,
      post.sourceUrl,
      post.contentHash,
      post.text,
      post.authorDisplayName,
      post.authorHandle,
      post.authorAvatarUrl,
      post.createdAt,
      post.observedAt,
      post.editedAt,
      post.deletedAt,
    ],
  );
}
