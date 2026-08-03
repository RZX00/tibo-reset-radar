import type { SourcePostObserved } from "@tibo-radar/contracts";
import type { Pool, PoolClient } from "pg";

import type { TimelineCollection } from "./types.js";

export interface CollectorCursor {
  source: string;
  cursor: string | null;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
}

export class PostgresSourceRepository {
  constructor(private readonly pool: Pool) {}

  async getCursor(source: string): Promise<CollectorCursor> {
    const result = await this.pool.query<{
      source: string;
      cursor: string | null;
      consecutive_failures: number;
      last_success_at: Date | null;
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
          lastSuccessAt: row.last_success_at?.toISOString() ?? null,
          lastErrorCode: row.last_error_code,
        }
      : { source, cursor: null, consecutiveFailures: 0, lastSuccessAt: null, lastErrorCode: null };
  }

  async persistBatch(source: string, collection: TimelineCollection): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const post of collection.posts) await upsertPost(client, post);
      if (collection.deletedPostIds?.length) {
        await client.query(
          `UPDATE source_posts
           SET deleted_at = now(), text_ephemeral = NULL
           WHERE post_id = ANY($1::text[])`,
          [collection.deletedPostIds],
        );
      }
      await client.query(
        `INSERT INTO collector_cursors
           (source, cursor, consecutive_failures, last_success_at, last_error_code, updated_at)
         VALUES ($1, $2, 0, now(), NULL, now())
         ON CONFLICT (source) DO UPDATE SET
           cursor = COALESCE(EXCLUDED.cursor, collector_cursors.cursor),
           consecutive_failures = 0,
           last_success_at = now(),
           last_error_code = NULL,
           updated_at = now()`,
        [source, collection.nextSinceId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async persistStreamPost(post: SourcePostObserved): Promise<void> {
    const client = await this.pool.connect();
    try {
      await upsertPost(client, post);
    } finally {
      client.release();
    }
  }

  async recordFailure(source: string, errorCode: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO collector_cursors
         (source, consecutive_failures, last_error_code, updated_at)
       VALUES ($1, 1, $2, now())
       ON CONFLICT (source) DO UPDATE SET
         consecutive_failures = collector_cursors.consecutive_failures + 1,
         last_error_code = EXCLUDED.last_error_code,
         updated_at = now()`,
      [source, errorCode.slice(0, 120)],
    );
  }
}

async function upsertPost(client: PoolClient, post: SourcePostObserved): Promise<void> {
  await client.query(
    `INSERT INTO source_posts (
       post_id, author_id, source_kind, conversation_id, referenced_post_ids, language,
       source_url, content_hash, text_ephemeral, author_display_name, author_handle,
       author_avatar_url, created_at, observed_at, edited_at, deleted_at
     ) VALUES (
       $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
     ) ON CONFLICT (post_id) DO UPDATE SET
       source_kind = EXCLUDED.source_kind,
       conversation_id = EXCLUDED.conversation_id,
       referenced_post_ids = EXCLUDED.referenced_post_ids,
       language = EXCLUDED.language,
       source_url = EXCLUDED.source_url,
       content_hash = EXCLUDED.content_hash,
       text_ephemeral = EXCLUDED.text_ephemeral,
       author_display_name = EXCLUDED.author_display_name,
       author_handle = EXCLUDED.author_handle,
       author_avatar_url = EXCLUDED.author_avatar_url,
       observed_at = GREATEST(source_posts.observed_at, EXCLUDED.observed_at),
       edited_at = COALESCE(EXCLUDED.edited_at, source_posts.edited_at),
       deleted_at = COALESCE(EXCLUDED.deleted_at, source_posts.deleted_at)`,
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
