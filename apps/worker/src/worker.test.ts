import { TargetConfigSchema } from "@tibo-radar/contracts";
import type { TimelineSource } from "@tibo-radar/x-source";
import { describe, expect, it, vi } from "vitest";

import { createDemoFixtures } from "./demo-fixtures.js";
import { DEFAULT_POLL_INTERVAL_MS, pollIntervalMs } from "./main.js";
import type { SqliteWorkerRepository } from "./repository.js";
import { DeterministicOnlySignalAdapter, errorCode, RadarWorker } from "./worker.js";

describe("worker support", () => {
  it("builds valid, non-secret demo fixtures for the configured target", () => {
    const config = TargetConfigSchema.parse({
      schemaVersion: "1.0",
      mode: "demo",
      target: { userId: "demo", handle: "tibo_demo", displayName: "Tibo" },
      authoritativeUserIds: ["demo"],
      resetDefinition: "A usage reset",
      bankedResetPolicy: "forecast_only",
    });
    const fixtures = createDemoFixtures(config, new Date("2026-08-03T12:00:00.000Z"));
    expect(fixtures).toHaveLength(3);
    expect(fixtures.every((post) => post.authorId === "demo")).toBe(true);
    expect(fixtures.map((post) => post.postId)).toEqual(["1001", "1002", "1003"]);
  });

  it("forces signal extraction through the documented deterministic fallback", async () => {
    await expect(new DeterministicOnlySignalAdapter().extract()).rejects.toThrow(
      "deterministic rule fallback",
    );
  });

  it("reports stable failure codes without leaking error messages", () => {
    expect(errorCode(new TypeError("secret token value"))).toBe("type_error");
    expect(errorCode("bad")).toBe("unknown_error");
  });

  it("defaults collector polling to 120 seconds", () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(120_000);
    expect(pollIntervalMs({})).toBe(120_000);
    expect(pollIntervalMs({ POLL_INTERVAL_MS: "60000" })).toBe(60_000);
  });

  it("keeps a completed v1 forecast when the v2 shadow path fails", async () => {
    const saveForecast = vi.fn(async () => undefined);
    const repository = {
      getForecastContext: async () => ({
        signals: [],
        previousSnapshot: null,
        confirmedSignal: null,
        lastObservedAt: "2026-08-03T11:59:00.000Z",
        lastPublicActivityAt: "2026-08-03T11:00:00.000Z",
        consecutiveFailures: 0,
      }),
      saveForecast,
      getForecastV2Context: async () => {
        throw new Error("shadow database unavailable");
      },
    } as unknown as SqliteWorkerRepository;
    const source = {
      collect: async () => ({ posts: [], nextSinceId: null }),
    } satisfies TimelineSource;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const worker = new RadarWorker({
      source,
      repository,
      target: TargetConfigSchema.parse({
        schemaVersion: "1.0",
        mode: "demo",
        target: { userId: "demo", handle: "tibo_demo", displayName: "Tibo" },
        authoritativeUserIds: ["demo"],
        resetDefinition: "A usage reset",
        bankedResetPolicy: "forecast_only",
      }),
      signalAdapter: new DeterministicOnlySignalAdapter(),
      now: () => new Date("2026-08-03T12:00:00.000Z"),
    });

    try {
      await expect(worker.generateForecast()).resolves.toBeUndefined();
      expect(saveForecast).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith("forecast v2 shadow failed", "error");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps the main cycle successful when external shadow persistence and failure recording fail", async () => {
    const saveForecast = vi.fn(async () => undefined);
    const recordFailure = vi.fn(async () => undefined);
    const repository = {
      getCursor: async () => ({ cursor: null }),
      persistBatch: async () => undefined,
      getPendingPosts: async () => [],
      upsertExternalEvents: async () => {
        throw new Error("external table unavailable");
      },
      recordExternalFailure: async () => {
        throw new Error("external status table unavailable");
      },
      getForecastContext: async () => ({
        signals: [],
        previousSnapshot: null,
        confirmedSignal: null,
        lastObservedAt: "2026-08-03T11:59:00.000Z",
        lastPublicActivityAt: "2026-08-03T11:00:00.000Z",
        consecutiveFailures: 0,
      }),
      saveForecast,
      getForecastV2Context: async () => {
        throw new Error("shadow database unavailable");
      },
      recordFailure,
    } as unknown as SqliteWorkerRepository;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const worker = new RadarWorker({
      source: { collect: async () => ({ posts: [], nextSinceId: null }) },
      repository,
      target: TargetConfigSchema.parse({
        schemaVersion: "1.0",
        mode: "demo",
        target: { userId: "demo", handle: "tibo_demo", displayName: "Tibo" },
        authoritativeUserIds: ["demo"],
        resetDefinition: "A usage reset",
        bankedResetPolicy: "forecast_only",
      }),
      signalAdapter: new DeterministicOnlySignalAdapter(),
      externalEventSource: { sourceId: "test-external", collect: async () => [] },
      now: () => new Date("2026-08-03T12:00:00.000Z"),
    });

    try {
      await expect(worker.runOnce()).resolves.toBeUndefined();
      expect(saveForecast).toHaveBeenCalledOnce();
      expect(recordFailure).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
