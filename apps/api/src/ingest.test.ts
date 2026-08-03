import { createHash } from "node:crypto";

import type { SourcePostObserved } from "@tibo-radar/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { INGEST_BATCH_LIMIT, isAuthorizedIngest, type RadarIngestStore } from "./ingest.js";
import { buildServer } from "./server.js";
import type { RadarReadStore } from "./store.js";

const servers: ReturnType<typeof buildServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("ingest surface", () => {
  it("does not exist when the deployment configured no ingest token", async () => {
    const app = buildServer({ store: emptyReadStore() });
    servers.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/ingest/posts",
      payload: { posts: [] },
    });
    expect(response.statusCode).toBe(404);
  });

  it("rejects a missing, wrong, or truncated token", async () => {
    const store = new MemoryIngestStore();
    const app = buildServer({ store: emptyReadStore(), ingest: { store, token: "correct-token" } });
    servers.push(app);
    for (const headers of [
      undefined,
      { authorization: "Bearer wrong-token1" },
      { authorization: "Bearer correct" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/ingest/posts",
        ...(headers ? { headers } : {}),
        payload: { posts: [] },
      });
      expect(response.statusCode).toBe(401);
    }
    expect(store.accepted).toHaveLength(0);
  });

  it("stores a valid batch and reports what was new", async () => {
    const store = new MemoryIngestStore();
    const app = buildServer({ store: emptyReadStore(), ingest: { store, token: "t" } });
    servers.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/ingest/posts",
      headers: { authorization: "Bearer t" },
      payload: { posts: [makePost("2083395449814229287")] },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ received: 1, stored: 1 });
    expect(store.accepted).toHaveLength(1);
  });

  it("refuses posts that do not satisfy the observed-post contract", async () => {
    const store = new MemoryIngestStore();
    const app = buildServer({ store: emptyReadStore(), ingest: { store, token: "t" } });
    servers.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/ingest/posts",
      headers: { authorization: "Bearer t" },
      payload: { posts: [{ ...makePost("1"), createdAt: "not-a-time" }] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_POST");
    expect(store.accepted).toHaveLength(0);
  });

  it("refuses a batch larger than the documented limit", async () => {
    const store = new MemoryIngestStore();
    const app = buildServer({ store: emptyReadStore(), ingest: { store, token: "t" } });
    servers.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/ingest/posts",
      headers: { authorization: "Bearer t" },
      payload: {
        posts: Array.from({ length: INGEST_BATCH_LIMIT + 1 }, (_, index) =>
          makePost(`${index + 1}`),
        ),
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("BATCH_TOO_LARGE");
  });

  it("compares tokens without leaking length through an exception", () => {
    expect(isAuthorizedIngest("Bearer abc", "abc")).toBe(true);
    expect(isAuthorizedIngest("Bearer abcd", "abc")).toBe(false);
    expect(isAuthorizedIngest("abc", "abc")).toBe(false);
    expect(isAuthorizedIngest(undefined, "abc")).toBe(false);
  });
});

class MemoryIngestStore implements RadarIngestStore {
  readonly accepted: SourcePostObserved[] = [];
  async accept(posts: readonly SourcePostObserved[]): Promise<number> {
    this.accepted.push(...posts);
    return posts.length;
  }
}

function emptyReadStore(): RadarReadStore {
  return {
    getStatus: async () => {
      throw new Error("not used");
    },
    getLatestForecast: async () => null,
    getEvents: async () => [],
    getLatestResetEvent: async () => null,
  };
}

function makePost(postId: string): SourcePostObserved {
  const text = `post ${postId}`;
  return {
    postId,
    authorId: "1953337039510003712",
    authorDisplayName: "Target",
    authorHandle: "target",
    authorAvatarUrl: null,
    sourceKind: "post",
    conversationId: null,
    referencedPostIds: [],
    language: "en",
    sourceUrl: `https://x.com/target/status/${postId}`,
    text,
    contentHash: createHash("sha256").update(text).digest("hex"),
    createdAt: "2026-08-03T10:00:00.000Z",
    observedAt: "2026-08-03T10:01:00.000Z",
    editedAt: null,
    deletedAt: null,
  };
}
