import type { SourcePostObserved } from "@tibo-radar/contracts";

import type { TimelineCollectInput, TimelineCollection, TimelineSource } from "./types.js";

export class DemoTimelineSource implements TimelineSource {
  readonly #fixtures: SourcePostObserved[];

  constructor(fixtures: SourcePostObserved[]) {
    this.#fixtures = [...fixtures];
  }

  async collect(input: TimelineCollectInput): Promise<TimelineCollection> {
    const posts = this.#fixtures
      .filter((post) => post.authorId === input.userId)
      .filter((post) => !input.sinceId || compareIds(post.postId, input.sinceId) > 0)
      .filter((post) => post.sourceKind !== "repost")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    return {
      posts,
      nextSinceId: posts.reduce<string | null>(
        (latest, post) => (!latest || compareIds(post.postId, latest) > 0 ? post.postId : latest),
        input.sinceId,
      ),
    };
  }
}

function compareIds(left: string, right: string): number {
  try {
    const difference = BigInt(left) - BigInt(right);
    return difference === 0n ? 0 : difference > 0n ? 1 : -1;
  } catch {
    return left.localeCompare(right);
  }
}
