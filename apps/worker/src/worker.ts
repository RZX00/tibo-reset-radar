import { createHash, randomUUID } from "node:crypto";

import type { SourcePostObserved, TargetConfig } from "@tibo-radar/contracts";
import { deriveActivityStatus, deriveFreshness, generateForecast } from "@tibo-radar/forecast";
import { evaluateConfirmation, extractSignal, type SignalModelAdapter } from "@tibo-radar/signal";
import type { TimelineSource } from "@tibo-radar/x-source";

import type { SqliteWorkerRepository } from "./repository.js";

export interface RadarWorkerOptions {
  source: TimelineSource;
  repository: SqliteWorkerRepository;
  target: TargetConfig;
  signalAdapter: SignalModelAdapter;
  now?: () => Date;
}

export class RadarWorker {
  readonly #source: TimelineSource;
  readonly #repository: SqliteWorkerRepository;
  readonly #target: TargetConfig;
  readonly #signalAdapter: SignalModelAdapter;
  readonly #now: () => Date;
  readonly #cursorSource: string;

  constructor(options: RadarWorkerOptions) {
    this.#source = options.source;
    this.#repository = options.repository;
    this.#target = options.target;
    this.#signalAdapter = options.signalAdapter;
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
        { post, resetDefinition: this.#target.resetDefinition, referenceTime: post.observedAt },
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
    const context = await this.#repository.getForecastContext();
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
