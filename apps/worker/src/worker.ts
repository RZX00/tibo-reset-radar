import { createHash, randomUUID } from "node:crypto";

import type { SourcePostObserved, TargetConfig } from "@tibo-radar/contracts";
import {
  deriveActivityStatus,
  deriveFreshness,
  generateForecast,
  generateShadowForecastV2,
} from "@tibo-radar/forecast";
import { evaluateConfirmation, extractSignal, type SignalModelAdapter } from "@tibo-radar/signal";
import type { TimelineSource } from "@tibo-radar/x-source";

import type { ExternalEventSource } from "./external-events.js";
import type { SqliteWorkerRepository } from "./repository.js";

export interface RadarWorkerOptions {
  source: TimelineSource;
  repository: SqliteWorkerRepository;
  target: TargetConfig;
  signalAdapter: SignalModelAdapter;
  externalEventSource?: ExternalEventSource;
  now?: () => Date;
}

export class RadarWorker {
  readonly #source: TimelineSource;
  readonly #repository: SqliteWorkerRepository;
  readonly #target: TargetConfig;
  readonly #signalAdapter: SignalModelAdapter;
  readonly #externalEventSource: ExternalEventSource | undefined;
  readonly #now: () => Date;
  readonly #cursorSource: string;

  constructor(options: RadarWorkerOptions) {
    this.#source = options.source;
    this.#repository = options.repository;
    this.#target = options.target;
    this.#signalAdapter = options.signalAdapter;
    this.#externalEventSource = options.externalEventSource;
    this.#now = options.now ?? (() => new Date());
    this.#cursorSource = `x:timeline:${options.target.target.userId}`;
  }

  async runOnce(signal?: AbortSignal): Promise<void> {
    try {
      const cursor = await this.#repository.getCursor(this.#cursorSource);
      const collection = await this.#source.collect({
        userId: this.#target.target.userId,
        sinceId: cursor.cursor,
        ...(signal ? { signal } : {}),
      });
      await this.#repository.persistBatch(this.#cursorSource, collection);
      await this.processPendingSignals();
      await this.collectExternalEvents(signal);
      await this.generateForecast();
    } catch (error) {
      await this.#repository.recordFailure(this.#cursorSource, errorCode(error));
      throw error;
    }
  }

  async processStreamPost(post: SourcePostObserved): Promise<void> {
    await this.#repository.persistStreamPost(post);
    await this.processPendingSignals();
    await this.generateForecast();
  }

  async processPendingSignals(): Promise<void> {
    for (const post of await this.#repository.getPendingPosts()) {
      const result = await extractSignal(
        {
          post,
          resetDefinition: this.#target.resetDefinition,
          referenceTime: post.editedAt ?? post.createdAt,
        },
        this.#signalAdapter,
      );
      await this.#repository.saveExtraction(post, result);
      await this.#repository.saveConfirmation(
        post,
        evaluateConfirmation({
          post,
          extraction: result.extraction,
          authoritativeUserIds: this.#target.authoritativeUserIds,
          bankedResetPolicy: this.#target.bankedResetPolicy,
        }),
      );
    }
  }

  async generateForecast(): Promise<void> {
    const generatedAt = this.#now().toISOString();
    const context = await this.#repository.getForecastContext(generatedAt);
    const dataFreshness = deriveFreshness(generatedAt, context.lastObservedAt);
    const activity = deriveActivityStatus(
      generatedAt,
      context.lastPublicActivityAt,
      context.consecutiveFailures,
    );
    const inputHash = createHash("sha256")
      .update(JSON.stringify({ signals: context.signals, activity, dataFreshness }))
      .digest("hex");
    const snapshot = generateForecast({
      runId: randomUUID(),
      generatedAt,
      timezone: "UTC",
      modelVersion: "heuristic-v1",
      activity,
      dataFreshness,
      signals: context.signals,
      confirmedSignal: context.confirmedSignal,
      previousSnapshot: context.previousSnapshot,
    });
    await this.#repository.saveForecast(snapshot, inputHash);
    try {
      const shadowContext = await this.#repository.getForecastV2Context(generatedAt);
      const shadow = generateShadowForecastV2({
        runId: randomUUID(),
        snapshotId: randomUUID(),
        generatedAt,
        ...shadowContext,
      });
      await this.#repository.saveShadowForecast(shadow.features, shadow.forecast);
    } catch (error) {
      console.error("forecast v2 shadow failed", errorCode(error));
    }
  }

  private async collectExternalEvents(signal?: AbortSignal): Promise<void> {
    if (!this.#externalEventSource) return;
    const observedAt = this.#now().toISOString();
    try {
      const events = await this.#externalEventSource.collect({
        observedAt,
        ...(signal ? { signal } : {}),
      });
      await this.#repository.upsertExternalEvents(events);
      await this.#repository.recordExternalSuccess(this.#externalEventSource.sourceId, observedAt);
    } catch (error) {
      try {
        await this.#repository.recordExternalFailure(
          this.#externalEventSource.sourceId,
          errorCode(error),
          observedAt,
        );
      } catch (recordError) {
        console.error("forecast v2 external failure recording failed", errorCode(recordError));
      }
      console.error("forecast v2 external collection failed", errorCode(error));
    }
  }
}

export class DeterministicOnlySignalAdapter implements SignalModelAdapter {
  readonly model = "deterministic-rules";
  async extract(): Promise<unknown> {
    throw new Error("LLM is disabled; deterministic rule fallback requested");
  }
}

export function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown_error";
  const normalized = error.name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  return normalized.replace(/[^a-z0-9_]/g, "_").slice(0, 120) || "worker_error";
}
