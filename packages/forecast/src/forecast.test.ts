import { SignalExtractionSchema } from "@tibo-radar/contracts";
import { describe, expect, it } from "vitest";

import {
  deriveActivityStatus,
  deriveFreshness,
  evaluateBacktest,
  type ForecastGenerationInput,
  generateForecast,
  type PersistedForecastSignal,
} from "./index.js";

const GENERATED_AT = "2026-08-03T00:00:00.000Z";

describe("forecast probability properties", () => {
  it("always emits 28 contiguous buckets with coherent interval, hazard, and cumulative probabilities", () => {
    const random = seededRandom(42);
    for (let iteration = 0; iteration < 250; iteration += 1) {
      const signalCount = Math.floor(random() * 15);
      const signals = Array.from({ length: signalCount }, (_, index) =>
        randomSignal(index, random),
      );
      const activity = ["active", "cooling", "quiet", "data_delayed"] as const;
      const snapshot = generateForecast(
        makeInput({
          signals,
          activityStatus: activity[Math.floor(random() * activity.length)] ?? "quiet",
          lastResetHoursAgo: random() * 240,
          recent24hPostCount: Math.floor(random() * 30),
          baselineDailyPostAverage: 1 + random() * 12,
          baselineWindowComplete: true,
        }),
      );
      const buckets = snapshot.days.flatMap((day) => day.buckets);

      expect(buckets).toHaveLength(28);
      let intervalSum = 0;
      let previousCumulative = 0;
      for (const [index, bucket] of buckets.entries()) {
        expect(bucket.index).toBe(index);
        expect(Date.parse(bucket.endAt) - Date.parse(bucket.startAt)).toBe(6 * 60 * 60 * 1_000);
        if (index > 0) expect(bucket.startAt).toBe(buckets[index - 1]?.endAt);
        expect(bucket.intervalProbability).toBeGreaterThanOrEqual(0);
        expect(bucket.intervalProbability).toBeLessThanOrEqual(0.99);
        expect(bucket.cumulativeProbability).toBeGreaterThanOrEqual(previousCumulative);
        expect(bucket.cumulativeProbability).toBeLessThanOrEqual(0.99);
        expect(bucket.hazardProbability).toBeCloseTo(
          bucket.intervalProbability / (1 - previousCumulative),
          12,
        );
        intervalSum += bucket.intervalProbability;
        previousCumulative = bucket.cumulativeProbability;
      }
      expect(intervalSum).toBeCloseTo(snapshot.cumulative.within168h, 12);
      expect(snapshot.cumulative.within24h).toBe(buckets[3]?.cumulativeProbability);
      expect(snapshot.cumulative.within48h).toBe(buckets[7]?.cumulativeProbability);
      expect(snapshot.cumulative.within72h).toBe(buckets[11]?.cumulativeProbability);
      expect(snapshot.horizonEnd).toBe("2026-08-10T00:00:00.000Z");
    }
  });

  it("is deterministic for identical persisted inputs", () => {
    const input = makeInput({
      signals: [randomSignal(1, seededRandom(9))],
      activityStatus: "active",
      recent24hPostCount: 6,
      baselineDailyPostAverage: 3,
      baselineWindowComplete: true,
    });
    expect(generateForecast(input)).toEqual(generateForecast(structuredClone(input)));
  });

  it("starts low after a reset and increases as the historical cadence window approaches", () => {
    const justReset = generateForecast(makeInput({ lastResetHoursAgo: 1 }));
    const twoDaysLater = generateForecast(makeInput({ lastResetHoursAgo: 60 }));

    expect(justReset.cumulative.within24h).toBeCloseTo(0.08, 12);
    expect(justReset.cumulative.within48h).toBeCloseTo(0.3, 12);
    expect(justReset.cumulative.within168h).toBeCloseTo(0.75, 12);
    expect(twoDaysLater.cumulative.within24h).toBeCloseTo(0.35, 12);
    expect(twoDaysLater.cumulative.within48h).toBeCloseTo(0.6, 12);
    expect(twoDaysLater.cumulative.within168h).toBeCloseTo(0.85, 12);
  });

  it("raises near-term probability when six posts are twice the normal daily activity", () => {
    const snapshot = generateForecast(
      makeInput({
        lastResetHoursAgo: 1,
        recent24hPostCount: 6,
        baselineDailyPostAverage: 3,
        baselineWindowComplete: true,
      }),
    );

    expect(snapshot.cumulative.within24h).toBeCloseTo(0.218, 12);
    expect(snapshot.cumulative.within48h).toBeCloseTo(0.363, 12);
    expect(snapshot.cumulative.within168h).toBeCloseTo(0.7575, 12);
    expect(snapshot.days[0]?.buckets[0]?.topReasonCodes).toContain("post_activity_high");
  });

  it("lowers the next 24 hours during Tibo's usual sleep window", () => {
    const sleeping = generateForecast(
      makeInput({ generatedAt: "2026-08-05T08:00:00.000Z", lastResetHoursAgo: 96 }),
    );
    const awake = generateForecast(
      makeInput({ generatedAt: "2026-08-05T17:00:00.000Z", lastResetHoursAgo: 96 }),
    );

    expect(sleeping.cumulative.within24h).toBeLessThan(awake.cumulative.within24h);
    expect(sleeping.cumulative.within48h).toBeLessThan(awake.cumulative.within48h);
    expect(sleeping.cumulative.within168h).toBeLessThan(awake.cumulative.within168h);
    expect(sleeping.days[0]?.buckets[0]?.intervalProbability).toBeLessThan(
      sleeping.days[0]?.buckets[1]?.intervalProbability ?? 0,
    );
    expect(sleeping.days[0]?.buckets[0]?.topReasonCodes).toContain("circadian_sleep");
  });

  it("ignores post wording and falls back to cadence when the activity baseline is incomplete", () => {
    const withoutSignal = generateForecast(makeInput({ signals: [] }));
    const withStrongSignal = generateForecast(
      makeInput({ signals: [randomSignal(1, seededRandom(3))] }),
    );

    expect(withStrongSignal.cumulative).toEqual(withoutSignal.cumulative);
    expect(withStrongSignal.days).toEqual(withoutSignal.days);
    expect(withStrongSignal.days[0]?.buckets[0]?.topReasonCodes).toContain(
      "post_activity_baseline_unavailable",
    );
  });

  it("does not apply a freshness penalty to event probability", () => {
    const signals = [randomSignal(1, seededRandom(3))];
    const fresh = generateForecast(makeInput({ signals, freshnessStatus: "fresh" }));
    const delayed = generateForecast(makeInput({ signals, freshnessStatus: "delayed" }));
    const stale = generateForecast(makeInput({ signals, freshnessStatus: "stale" }));

    expect(delayed.cumulative).toEqual(fresh.cumulative);
    expect(stale.cumulative).toEqual(fresh.cumulative);
    expect(stale.dataFreshness.confidence).toBeLessThan(fresh.dataFreshness.confidence);
  });

  it("freezes the prior forecast when data is stale", () => {
    const previous = generateForecast(makeInput({ signals: [randomSignal(1, seededRandom(5))] }));
    const frozen = generateForecast({
      ...makeInput({
        runId: "ignored-new-run",
        generatedAt: "2026-08-03T06:00:00.000Z",
        freshnessStatus: "stale",
        signals: [],
      }),
      previousSnapshot: previous,
    });

    expect(frozen.runId).toBe(previous.runId);
    expect(frozen.generatedAt).toBe(previous.generatedAt);
    expect(frozen.days).toEqual(previous.days);
    expect(frozen.dataFreshness.status).toBe("stale");
  });
});

describe("rolling backtest metrics", () => {
  it("computes Brier, log loss, and calibration bins", () => {
    const report = evaluateBacktest([
      { predictedProbability: 0.2, outcome: 0 },
      { predictedProbability: 0.8, outcome: 1 },
    ]);

    expect(report.sampleSize).toBe(2);
    expect(report.brierScore).toBeCloseTo(0.04, 12);
    expect(report.logLoss).toBeCloseTo(-Math.log(0.8), 12);
    expect(report.calibration[2]).toMatchObject({ sampleSize: 1, observedRate: 0 });
    expect(report.calibration[8]).toMatchObject({ sampleSize: 1, observedRate: 1 });
  });

  it("reports an explicit empty state before forecasts mature", () => {
    expect(evaluateBacktest([])).toMatchObject({
      sampleSize: 0,
      brierScore: null,
      logLoss: null,
    });
  });
});

describe("activity and freshness derivation", () => {
  it.each([
    ["2026-08-02T23:30:00.000Z", 0, "active"],
    ["2026-08-02T23:29:59.000Z", 0, "cooling"],
    ["2026-08-02T21:00:00.000Z", 0, "cooling"],
    ["2026-08-02T20:59:59.000Z", 0, "quiet"],
    ["2026-08-02T23:59:00.000Z", 2, "data_delayed"],
  ] as const)("maps %s with %d failures to %s", (lastActivity, failures, expected) => {
    expect(deriveActivityStatus(GENERATED_AT, lastActivity, failures).status).toBe(expected);
  });

  it("derives freshness without changing observed timestamps", () => {
    expect(deriveFreshness(GENERATED_AT, "2026-08-02T23:55:00.000Z")).toMatchObject({
      status: "fresh",
      lagSeconds: 300,
      confidence: 1,
    });
    expect(deriveFreshness(GENERATED_AT, null)).toEqual({
      status: "stale",
      lastObservedAt: null,
      lagSeconds: null,
      confidence: 0.15,
    });
  });
});

function makeInput(
  options: {
    runId?: string;
    generatedAt?: string;
    signals?: PersistedForecastSignal[];
    activityStatus?: ForecastGenerationInput["activity"]["status"];
    freshnessStatus?: ForecastGenerationInput["dataFreshness"]["status"];
    lastResetHoursAgo?: number;
    recent24hPostCount?: number;
    baselineDailyPostAverage?: number | null;
    baselineWindowComplete?: boolean;
  } = {},
): ForecastGenerationInput {
  const freshnessStatus = options.freshnessStatus ?? "fresh";
  return {
    runId: options.runId ?? "run-1",
    generatedAt: options.generatedAt ?? GENERATED_AT,
    timezone: "UTC",
    modelVersion: "cadence-activity-v1",
    activity: {
      status: options.activityStatus ?? "cooling",
      lastPublicActivityAt: "2026-08-02T23:00:00.000Z",
    },
    dataFreshness: {
      status: freshnessStatus,
      lastObservedAt: "2026-08-02T23:55:00.000Z",
      lagSeconds: 300,
      confidence: freshnessStatus === "fresh" ? 1 : freshnessStatus === "delayed" ? 0.7 : 0.3,
    },
    signals: options.signals ?? [],
    lastResetAt: new Date(
      Date.parse(options.generatedAt ?? GENERATED_AT) -
        (options.lastResetHoursAgo ?? 1) * 60 * 60 * 1_000,
    ).toISOString(),
    activityMetrics: {
      recent24hPostCount: options.recent24hPostCount ?? 0,
      baselineDailyPostAverage: options.baselineDailyPostAverage ?? null,
      baselineWindowComplete: options.baselineWindowComplete ?? false,
    },
  };
}

function randomSignal(index: number, random: () => number): PersistedForecastSignal {
  const states = [
    "none",
    "future",
    "rolling_out_now",
    "completed",
    "limited",
    "retracted",
    "ambiguous",
  ] as const;
  const commitments = ["none", "weak", "explicit"] as const;
  const state = states[Math.floor(random() * states.length)] ?? "none";
  const timingIndex = Math.floor(random() * 28);
  const hintedAt = new Date(
    Date.parse(GENERATED_AT) + timingIndex * 6 * 60 * 60 * 1_000,
  ).toISOString();
  return {
    postId: `post-${index}`,
    sourceAt: new Date(Date.parse(GENERATED_AT) - random() * 96 * 60 * 60 * 1_000).toISOString(),
    extraction: SignalExtractionSchema.parse({
      explicitResetState: state,
      futureCommitment: commitments[Math.floor(random() * commitments.length)] ?? "none",
      timeHint:
        random() > 0.5
          ? { kind: "absolute", startAt: hintedAt, endAt: hintedAt, rawPhrase: hintedAt }
          : { kind: "none", startAt: null, endAt: null, rawPhrase: null },
      scope: "unknown",
      incidentSignal: random(),
      milestoneSignal: random(),
      resetRelevance: random(),
      sentiment: "neutral",
      confidence: random(),
      evidenceSpans: [],
      reasonCode: `random_${index}`,
    }),
  };
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}
