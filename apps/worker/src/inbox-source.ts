import { type SourcePostObserved, SourcePostObservedSchema } from "@tibo-radar/contracts";
import type {
  TimelineCollectInput,
  TimelineCollection,
  TimelineSource,
} from "@tibo-radar/x-source";

export interface InboxReader {
  readInbox(sinceId: string | null, limit: number): Promise<unknown[]>;
}

export interface InboxTimelineSourceOptions {
  reader: InboxReader;
  batchSize?: number;
}

/**
 * Drains posts pushed in by an operator-run collector. The collector may live on a different
 * machine — typically a residential one — so this source owns no credentials and no network calls;
 * it only turns rows into the same observed-post contract every other source produces.
 *
 * The reader decides which rows are still outstanding. A collector is free to push history long
 * after newer posts, so "outstanding" cannot mean "newer than the cursor"; the returned cursor is
 * only a high-water mark for reporting.
 */
export class InboxTimelineSource implements TimelineSource {
  readonly #reader: InboxReader;
  readonly #batchSize: number;

  constructor(options: InboxTimelineSourceOptions) {
    this.#reader = options.reader;
    this.#batchSize = options.batchSize ?? 200;
  }

  async collect(input: TimelineCollectInput): Promise<TimelineCollection> {
    const rows = await this.#reader.readInbox(input.sinceId, this.#batchSize);
    const posts: SourcePostObserved[] = [];
    let newestId = input.sinceId;
    for (const row of rows) {
      const parsed = SourcePostObservedSchema.safeParse(row);
      if (!parsed.success) continue;
      if (parsed.data.sourceKind === "repost") continue;
      posts.push(parsed.data);
      newestId = maxSnowflake(newestId, parsed.data.postId);
    }
    return {
      posts: posts.sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
      nextSinceId: newestId,
    };
  }
}

function maxSnowflake(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  try {
    return BigInt(left) >= BigInt(right) ? left : right;
  } catch {
    return left.localeCompare(right) >= 0 ? left : right;
  }
}
