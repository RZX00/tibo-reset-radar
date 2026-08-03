import { timingSafeEqual } from "node:crypto";

import { type SourcePostObserved, SourcePostObservedSchema } from "@tibo-radar/contracts";
import type { Pool } from "pg";

export const INGEST_BATCH_LIMIT = 200;

export interface RadarIngestStore {
  accept(posts: readonly SourcePostObserved[]): Promise<number>;
}

export class PostgresRadarIngestStore implements RadarIngestStore {
  constructor(private readonly pool: Pool) {}

  async accept(posts: readonly SourcePostObserved[]): Promise<number> {
    if (posts.length === 0) return 0;
    const result = await this.pool.query(
      `INSERT INTO ingest_inbox (post_id, payload, received_at)
       SELECT value->>'postId', value, now() FROM jsonb_array_elements($1::jsonb) AS value
       ON CONFLICT (post_id) DO UPDATE
         SET payload = EXCLUDED.payload, received_at = EXCLUDED.received_at
         WHERE ingest_inbox.payload IS DISTINCT FROM EXCLUDED.payload`,
      [JSON.stringify(posts)],
    );
    return result.rowCount ?? 0;
  }
}

/**
 * Parses an ingest body. The collector runs outside this deployment, so nothing here trusts it:
 * every post must satisfy the same contract the official source adapter produces.
 */
export function parseIngestBody(
  body: unknown,
): { ok: true; posts: SourcePostObserved[] } | { ok: false; code: string; message: string } {
  const posts = (body as { posts?: unknown } | null)?.posts;
  if (!Array.isArray(posts)) {
    return { ok: false, code: "INVALID_BODY", message: "posts must be an array" };
  }
  if (posts.length > INGEST_BATCH_LIMIT) {
    return {
      ok: false,
      code: "BATCH_TOO_LARGE",
      message: `posts must contain at most ${INGEST_BATCH_LIMIT} entries`,
    };
  }
  const parsed: SourcePostObserved[] = [];
  for (const [index, post] of posts.entries()) {
    const result = SourcePostObservedSchema.safeParse(post);
    if (!result.success) {
      return {
        ok: false,
        code: "INVALID_POST",
        message: `posts[${index}] does not satisfy the observed-post contract`,
      };
    }
    parsed.push(result.data);
  }
  return { ok: true, posts: parsed };
}

export function isAuthorizedIngest(header: string | undefined, expectedToken: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const presentedBytes = Buffer.from(presented);
  const expectedBytes = Buffer.from(expectedToken);
  if (presentedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(presentedBytes, expectedBytes);
}
