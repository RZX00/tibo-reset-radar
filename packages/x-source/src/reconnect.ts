import type { SourcePostObserved } from "@tibo-radar/contracts";

import type { FilteredStreamSource } from "./types.js";

export interface ReconnectingStreamOptions {
  source: FilteredStreamSource;
  onPost(post: SourcePostObserved): Promise<void>;
  reconcile(): Promise<void>;
  signal: AbortSignal;
  reconcileIntervalMs?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  onError?: (error: unknown) => void;
}

export const DEFAULT_RECONCILE_INTERVAL_MS = 120_000;

export async function runReconnectingStream(options: ReconnectingStreamOptions): Promise<void> {
  const reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
  let attempt = 0;

  while (!options.signal.aborted) {
    const periodic = setInterval(() => {
      void options.reconcile().catch(options.onError ?? (() => undefined));
    }, reconcileIntervalMs);
    try {
      for await (const post of options.source.connect({ signal: options.signal })) {
        attempt = 0;
        await options.onPost(post);
      }
      if (!options.signal.aborted) throw new Error("X filtered stream ended unexpectedly");
    } catch (error) {
      if (options.signal.aborted) return;
      options.onError?.(error);
      await options.reconcile();
      const delay = reconnectDelay(
        attempt,
        options.baseDelayMs,
        options.maxDelayMs,
        options.random,
      );
      attempt += 1;
      await abortableDelay(delay, options.signal);
    } finally {
      clearInterval(periodic);
    }
  }
}

export function reconnectDelay(
  attempt: number,
  baseDelayMs = 1_000,
  maxDelayMs = 60_000,
  random: () => number = Math.random,
): number {
  const bounded = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(attempt, 12));
  return Math.round(bounded * (0.75 + random() * 0.5));
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
