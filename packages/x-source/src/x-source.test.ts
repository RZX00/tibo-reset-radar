import { createHash } from "node:crypto";

import { type SourcePostObserved, SourcePostObservedSchema } from "@tibo-radar/contracts";
import { describe, expect, it, vi } from "vitest";

import { DemoTimelineSource } from "./demo.js";
import { reconnectDelay, runReconnectingStream } from "./reconnect.js";
import { decodeJsonLines, mapXPost, XUserTimelineSource } from "./x-api.js";

describe("XUserTimelineSource", () => {
  it("paginates from since_id, filters reposts, deduplicates, and advances to newest snowflake", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          data: [post("103", "new reply", "replied_to"), post("102", "repost", "retweeted")],
          includes: { users: [user()] },
          meta: { newest_id: "103", next_token: "next-page" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: [post("101", "older post"), post("103", "new reply", "replied_to")],
          includes: { users: [user()] },
          meta: {},
        }),
      );
    const source = new XUserTimelineSource({
      bearerToken: "test-token",
      fetch,
      now: () => new Date("2026-08-03T01:00:00.000Z"),
    });

    const result = await source.collect({ userId: "42", sinceId: "100" });

    expect(result.posts.map((item) => item.postId)).toEqual(["101", "103"]);
    expect(result.posts[1]?.sourceKind).toBe("reply");
    expect(result.nextSinceId).toBe("103");
    const firstUrl = new URL(String(fetch.mock.calls[0]?.[0]));
    const secondUrl = new URL(String(fetch.mock.calls[1]?.[0]));
    expect(firstUrl.pathname).toBe("/2/users/42/tweets");
    expect(firstUrl.searchParams.get("since_id")).toBe("100");
    expect(firstUrl.searchParams.get("exclude")).toBe("retweets");
    expect(secondUrl.searchParams.get("pagination_token")).toBe("next-page");
  });

  it("keeps the existing cursor for an empty incremental poll", async () => {
    const source = new XUserTimelineSource({
      bearerToken: "test-token",
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(jsonResponse({ meta: {} })),
    });

    await expect(source.collect({ userId: "42", sinceId: "103" })).resolves.toEqual({
      posts: [],
      nextSinceId: "103",
    });
  });

  it("normalizes quote and edit metadata without losing source identity", () => {
    const mapped = mapXPost(
      {
        ...post("104", "updated quote", "quoted"),
        edit_history_tweet_ids: ["103", "104"],
      },
      [user()],
      new Date("2026-08-03T01:00:00.000Z"),
    );

    expect(mapped).toMatchObject({
      postId: "104",
      sourceKind: "quote",
      referencedPostIds: ["1"],
      editedAt: "2026-08-03T01:00:00.000Z",
    });
  });
});

describe("DemoTimelineSource", () => {
  it("replays only unseen target fixtures in chronological order", async () => {
    const source = new DemoTimelineSource([
      fixture("12", "2026-08-03T02:00:00.000Z"),
      fixture("11", "2026-08-03T01:00:00.000Z"),
      fixture("10", "2026-08-03T00:00:00.000Z"),
    ]);
    const result = await source.collect({ userId: "42", sinceId: "10" });
    expect(result.posts.map((item) => item.postId)).toEqual(["11", "12"]);
    expect(result.nextSinceId).toBe("12");
  });
});

describe("stream primitives", () => {
  it("decodes split NDJSON while ignoring keep-alive blank lines", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"data":{"id":"1"}}\n\n{"data":'));
        controller.enqueue(encoder.encode('{"id":"2"}}\n'));
        controller.close();
      },
    });
    const output = [];
    for await (const value of decodeJsonLines(stream)) output.push(value);
    expect(output).toEqual([{ data: { id: "1" } }, { data: { id: "2" } }]);
  });

  it("uses bounded exponential reconnect delay with deterministic jitter", () => {
    expect(reconnectDelay(0, 1_000, 60_000, () => 0.5)).toBe(1_000);
    expect(reconnectDelay(4, 1_000, 60_000, () => 0.5)).toBe(16_000);
    expect(reconnectDelay(20, 1_000, 60_000, () => 0.5)).toBe(60_000);
  });

  it("reconciles immediately when a stream disconnects", async () => {
    const controller = new AbortController();
    const reconcile = vi.fn(async () => controller.abort());
    const source = {
      async *connect() {
        yield await Promise.reject<SourcePostObserved>(new Error("stream disconnected"));
      },
    };

    await runReconnectingStream({
      source,
      signal: controller.signal,
      onPost: vi.fn(async () => undefined),
      reconcile,
      baseDelayMs: 1,
      maxDelayMs: 1,
    });

    expect(reconcile).toHaveBeenCalledOnce();
  });
});

function user() {
  return {
    id: "42",
    name: "Tibo",
    username: "tibo",
    profile_image_url: "https://example.com/tibo.png",
  };
}

function post(id: string, text: string, referenceType?: "replied_to" | "quoted" | "retweeted") {
  return {
    id,
    text,
    author_id: "42",
    conversation_id: id,
    created_at: `2026-08-03T00:${id === "101" ? "01" : "03"}:00.000Z`,
    ...(referenceType ? { referenced_tweets: [{ id: "1", type: referenceType }] } : {}),
  };
}

function fixture(postId: string, createdAt: string) {
  const text = `fixture-${postId}`;
  return SourcePostObservedSchema.parse({
    postId,
    authorId: "42",
    authorDisplayName: "Tibo",
    authorHandle: "tibo",
    authorAvatarUrl: null,
    sourceKind: "post",
    conversationId: postId,
    referencedPostIds: [],
    language: "en",
    sourceUrl: `https://x.com/tibo/status/${postId}`,
    text,
    contentHash: createHash("sha256").update(text).digest("hex"),
    createdAt,
    observedAt: createdAt,
    editedAt: null,
    deletedAt: null,
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
