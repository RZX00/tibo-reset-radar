import type { SourcePostObserved } from "@tibo-radar/contracts";

export interface TimelineCollectInput {
  userId: string;
  sinceId: string | null;
  signal?: AbortSignal;
}

export interface TimelineCollection {
  posts: SourcePostObserved[];
  nextSinceId: string | null;
  deletedPostIds?: readonly string[];
}

export interface TimelineSource {
  collect(input: TimelineCollectInput): Promise<TimelineCollection>;
}

export interface StreamConnectInput {
  signal?: AbortSignal;
}

export interface FilteredStreamSource {
  connect(input?: StreamConnectInput): AsyncIterable<SourcePostObserved>;
}
