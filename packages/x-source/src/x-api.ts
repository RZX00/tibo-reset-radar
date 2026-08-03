import { createHash } from "node:crypto";

import { type SourcePostObserved, SourcePostObservedSchema } from "@tibo-radar/contracts";

import type {
  FilteredStreamSource,
  StreamConnectInput,
  TimelineCollectInput,
  TimelineCollection,
  TimelineSource,
} from "./types.js";

interface XApiAdapterOptions {
  bearerToken: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

interface XPost {
  id: string;
  text: string;
  author_id?: string;
  conversation_id?: string;
  created_at?: string;
  lang?: string;
  referenced_tweets?: Array<{ id: string; type: "replied_to" | "quoted" | "retweeted" }>;
  edit_history_tweet_ids?: string[];
}

interface XUser {
  id: string;
  name?: string;
  username?: string;
  profile_image_url?: string;
}

interface XEnvelope {
  data?: XPost[] | XPost;
  includes?: { users?: XUser[] };
  meta?: { next_token?: string; newest_id?: string };
}

const TWEET_FIELDS = [
  "author_id",
  "conversation_id",
  "created_at",
  "edit_history_tweet_ids",
  "lang",
  "referenced_tweets",
].join(",");

const USER_FIELDS = ["name", "profile_image_url", "username"].join(",");

export class XUserTimelineSource implements TimelineSource {
  readonly #bearerToken: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => Date;

  constructor(options: XApiAdapterOptions) {
    this.#bearerToken = requireBearerToken(options.bearerToken);
    this.#baseUrl = (options.baseUrl ?? "https://api.x.com/2").replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async collect(input: TimelineCollectInput): Promise<TimelineCollection> {
    const posts = new Map<string, SourcePostObserved>();
    let paginationToken: string | undefined;
    let newestId = input.sinceId;

    do {
      const url = new URL(`${this.#baseUrl}/users/${encodeURIComponent(input.userId)}/tweets`);
      url.searchParams.set("max_results", "100");
      url.searchParams.set("exclude", "retweets");
      url.searchParams.set("expansions", "author_id");
      url.searchParams.set("tweet.fields", TWEET_FIELDS);
      url.searchParams.set("user.fields", USER_FIELDS);
      if (input.sinceId) url.searchParams.set("since_id", input.sinceId);
      if (paginationToken) url.searchParams.set("pagination_token", paginationToken);

      const envelope = await requestEnvelope(this.#fetch, url, this.#bearerToken, input.signal);
      for (const post of normalizePosts(envelope.data)) {
        const mapped = mapXPost(post, envelope.includes?.users ?? [], this.#now());
        if (mapped.sourceKind === "repost") continue;
        posts.set(mapped.postId, mapped);
        newestId = maxSnowflake(newestId, mapped.postId);
      }
      newestId = maxSnowflake(newestId, envelope.meta?.newest_id ?? null);
      paginationToken = envelope.meta?.next_token;
    } while (paginationToken);

    return {
      posts: [...posts.values()].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      ),
      nextSinceId: newestId,
    };
  }
}

export class XFilteredStreamSource implements FilteredStreamSource {
  readonly #bearerToken: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => Date;

  constructor(options: XApiAdapterOptions) {
    this.#bearerToken = requireBearerToken(options.bearerToken);
    this.#baseUrl = (options.baseUrl ?? "https://api.x.com/2").replace(/\/+$/, "");
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  async *connect(input: StreamConnectInput = {}): AsyncIterable<SourcePostObserved> {
    const url = new URL(`${this.#baseUrl}/tweets/search/stream`);
    url.searchParams.set("expansions", "author_id");
    url.searchParams.set("tweet.fields", TWEET_FIELDS);
    url.searchParams.set("user.fields", USER_FIELDS);

    const response = await this.#fetch(url, requestInit(this.#bearerToken, input.signal));
    if (!response.ok) throw new XApiError(response.status, await safeBody(response));
    if (!response.body) throw new Error("X filtered stream response has no body");

    for await (const envelope of decodeJsonLines(response.body)) {
      for (const post of normalizePosts(envelope.data)) {
        const mapped = mapXPost(post, envelope.includes?.users ?? [], this.#now());
        if (mapped.sourceKind !== "repost") yield mapped;
      }
    }
  }
}

export class XApiError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`X API request failed with HTTP ${status}: ${body.slice(0, 240)}`);
    this.name = "XApiError";
  }
}

export function mapXPost(post: XPost, users: XUser[], observedAt: Date): SourcePostObserved {
  if (!post.id || !post.text || !post.author_id || !post.created_at) {
    throw new Error("X post is missing id, text, author_id, or created_at");
  }
  const author = users.find((candidate) => candidate.id === post.author_id);
  const references = post.referenced_tweets ?? [];
  const sourceKind = references.some((reference) => reference.type === "retweeted")
    ? "repost"
    : references.some((reference) => reference.type === "replied_to")
      ? "reply"
      : references.some((reference) => reference.type === "quoted")
        ? "quote"
        : "post";
  const editHistory = post.edit_history_tweet_ids ?? [];
  const edited = editHistory.length > 1 || (editHistory.length === 1 && editHistory[0] !== post.id);

  return SourcePostObservedSchema.parse({
    postId: post.id,
    authorId: post.author_id,
    authorDisplayName: author?.name ?? null,
    authorHandle: author?.username ?? null,
    authorAvatarUrl: author?.profile_image_url ?? null,
    sourceKind,
    conversationId: post.conversation_id ?? null,
    referencedPostIds: references.map((reference) => reference.id),
    language: post.lang ?? null,
    sourceUrl: `https://x.com/${author?.username ?? "i"}/status/${post.id}`,
    text: post.text,
    contentHash: createHash("sha256").update(post.text).digest("hex"),
    createdAt: new Date(post.created_at).toISOString(),
    observedAt: observedAt.toISOString(),
    editedAt: edited ? observedAt.toISOString() : null,
    deletedAt: null,
  });
}

export async function* decodeJsonLines(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<XEnvelope> {
  const decoder = new TextDecoder();
  let pending = "";
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) yield JSON.parse(line) as XEnvelope;
        newline = pending.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
  pending += decoder.decode();
  if (pending.trim()) yield JSON.parse(pending) as XEnvelope;
}

async function requestEnvelope(
  fetchImpl: typeof globalThis.fetch,
  url: URL,
  bearerToken: string,
  signal?: AbortSignal,
): Promise<XEnvelope> {
  const response = await fetchImpl(url, requestInit(bearerToken, signal));
  if (!response.ok) throw new XApiError(response.status, await safeBody(response));
  return (await response.json()) as XEnvelope;
}

function requestInit(bearerToken: string, signal?: AbortSignal): RequestInit {
  return {
    headers: { authorization: `Bearer ${bearerToken}` },
    ...(signal ? { signal } : {}),
  };
}

function normalizePosts(data: XEnvelope["data"]): XPost[] {
  if (!data) return [];
  return Array.isArray(data) ? data : [data];
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

function requireBearerToken(value: string): string {
  if (!value.trim()) throw new Error("X bearer token is required");
  return value;
}

async function safeBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "unreadable response body";
  }
}
