import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { type InboxReader, InboxTimelineSource } from "./inbox-source.js";

describe("pushed inbox timeline source", () => {
  it("returns pushed posts in chronological order and advances the cursor numerically", async () => {
    const reader = new MemoryInbox([
      row("2083395449814229287", "2026-08-01T03:32:37.000Z"),
      row("999999999999999999", "2026-07-30T01:00:00.000Z"),
    ]);
    const collection = await new InboxTimelineSource({ reader }).collect({
      userId: "1953337039510003712",
      sinceId: null,
    });
    expect(collection.posts.map((post) => post.postId)).toEqual([
      "999999999999999999",
      "2083395449814229287",
    ]);
    // 2083… is numerically larger than 999… despite being lexically smaller.
    expect(collection.nextSinceId).toBe("2083395449814229287");
  });

  it("never moves the cursor backwards when a batch is empty", async () => {
    const collection = await new InboxTimelineSource({ reader: new MemoryInbox([]) }).collect({
      userId: "1953337039510003712",
      sinceId: "2083395449814229287",
    });
    expect(collection.posts).toEqual([]);
    expect(collection.nextSinceId).toBe("2083395449814229287");
  });

  it("drops reposts and rows that do not satisfy the contract instead of failing the cycle", async () => {
    const reader = new MemoryInbox([
      { ...row("1001", "2026-08-01T00:00:00.000Z"), sourceKind: "repost" },
      { postId: "1002", text: "missing everything else" },
      row("1003", "2026-08-01T01:00:00.000Z"),
    ]);
    const collection = await new InboxTimelineSource({ reader }).collect({
      userId: "1953337039510003712",
      sinceId: null,
    });
    expect(collection.posts.map((post) => post.postId)).toEqual(["1003"]);
    expect(collection.nextSinceId).toBe("1003");
  });
});

class MemoryInbox implements InboxReader {
  constructor(private readonly rows: unknown[]) {}
  async readInbox(): Promise<unknown[]> {
    return this.rows;
  }
}

function row(postId: string, createdAt: string) {
  const text = `post ${postId}`;
  return {
    postId,
    authorId: "1953337039510003712",
    authorDisplayName: "Tibo",
    authorHandle: "thsottiaux",
    authorAvatarUrl: null,
    sourceKind: "post",
    conversationId: null,
    referencedPostIds: [],
    language: "en",
    sourceUrl: `https://x.com/thsottiaux/status/${postId}`,
    text,
    contentHash: createHash("sha256").update(text).digest("hex"),
    createdAt,
    observedAt: createdAt,
    editedAt: null,
    deletedAt: null,
  };
}
