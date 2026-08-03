import { type ExternalEvent, SignalExtractionSchema } from "@tibo-radar/contracts";
import { describe, expect, it } from "vitest";

import {
  type ForecastV2GenerationInput,
  type ForecastV2ResetRecord,
  generateShadowForecastV2,
} from "./index.js";

const GENERATED_AT = "2026-08-03T00:00:00.000Z";
const HOUR_MS = 60 * 60 * 1_000;

describe("forecast v2 shadow model", () => {
  it("emits a coherent 28 bucket survival forecast without changing public output", () => {
    const result = generateShadowForecastV2(makeInput({ resetEvents: resetHistory(20, 72) }));
    const buckets = result.forecast.days.flatMap((day) => day.buckets);

    expect(result.forecast.model).toMatchObject({
      maturity: "shadow",
      publicImpact: "none",
    });
    expect(buckets).toHaveLength(28);
    expect(result.forecast.days).toHaveLength(7);
    expect(result.features.confirmedResetCount).toBe(20);

    let priorCumulative = 0;
    for (const [index, bucket] of buckets.entries()) {
      expect(bucket.index).toBe(index);
      expect(Date.parse(bucket.endAt) - Date.parse(bucket.startAt)).toBe(6 * HOUR_MS);
      if (index > 0) expect(bucket.startAt).toBe(buckets[index - 1]?.endAt);
      expect(bucket.cumulativeProbability).toBeGreaterThanOrEqual(priorCumulative);
      expect(bucket.hazardProbability).toBeCloseTo(
        bucket.intervalProbability / (1 - priorCumulative),
        12,
      );
      priorCumulative = bucket.cumulativeProbability;
    }

    expect(buckets.reduce((sum, bucket) => sum + bucket.intervalProbability, 0)).toBeCloseTo(
      result.forecast.cumulative.within168h,
      12,
    );
    for (const day of result.forecast.days) {
      expect(day.buckets.reduce((sum, bucket) => sum + bucket.intervalProbability, 0)).toBeCloseTo(
        day.intervalProbability,
        12,
      );
    }
  });

  it("uses only effective primary resets and respects as-of correction time", () => {
    const resets: ForecastV2ResetRecord[] = [
      reset("primary-1", 96, "all"),
      reset("limited-1", 72, "cohort"),
      reset("primary-2", 48, "unknown"),
      {
        eventId: "retraction-1",
        status: "retracted",
        occurredAt: null,
        knownAt: "2026-08-04T00:00:00.000Z",
        scope: "unknown",
        supersedesEventId: "primary-2",
      },
    ];

    const beforeCorrection = generateShadowForecastV2(makeInput({ resetEvents: resets }));
    const afterCorrection = generateShadowForecastV2(
      makeInput({ generatedAt: "2026-08-05T00:00:00.000Z", resetEvents: resets }),
    );

    expect(beforeCorrection.features.confirmedResetCount).toBe(2);
    expect(afterCorrection.features.confirmedResetCount).toBe(1);
  });

  it("keeps trained contextual coefficients disabled below 20 confirmed resets", () => {
    const externalEvents = [competitorRelease()];
    const base = generateShadowForecastV2(
      makeInput({ resetEvents: resetHistory(19, 72), externalEvents }),
    );
    const withParameters = generateShadowForecastV2(
      makeInput({
        resetEvents: resetHistory(19, 72),
        externalEvents,
        parameters: {
          modelVersion: "trained-test",
          validationStatus: "backtested",
          trainedResetCount: 19,
          coefficients: {
            postBurstZ: 0,
            replyBurstZ: 0,
            textBucketScore: 0,
            openAiIncident: 0,
            competitorRelease: 1,
          },
        },
      }),
    );

    expect(base.forecast.model.maturity).toBe("insufficient_history");
    expect(withParameters.forecast.model.maturity).toBe("insufficient_history");
    expect(withParameters.forecast.model.version).toBe("survival-v2-shadow");
    expect(withParameters.forecast.cumulative).toEqual(base.forecast.cumulative);
  });

  it("activates an external feature only for a backtested model with enough history", () => {
    const resetEvents = resetHistory(20, 72);
    const shadow = generateShadowForecastV2(
      makeInput({ resetEvents, externalEvents: [competitorRelease()] }),
    );
    const backtested = generateShadowForecastV2(
      makeInput({
        resetEvents,
        externalEvents: [competitorRelease()],
        parameters: {
          modelVersion: "trained-test",
          validationStatus: "backtested",
          trainedResetCount: 20,
          coefficients: {
            postBurstZ: 0,
            replyBurstZ: 0,
            textBucketScore: 0,
            openAiIncident: 0,
            competitorRelease: 1,
          },
        },
      }),
    );

    expect(shadow.forecast.model.maturity).toBe("shadow");
    expect(backtested.forecast.model.maturity).toBe("backtested");
    expect(backtested.forecast.cumulative.within168h).toBeGreaterThan(
      shadow.forecast.cumulative.within168h,
    );
  });

  it("learns a positive, normalized UTC activity rhythm from Tibo's own posts", () => {
    const posts = Array.from({ length: 30 }, (_, index) => {
      const createdAt = new Date(
        Date.parse(GENERATED_AT) - (index + 1) * 24 * HOUR_MS + 15 * HOUR_MS,
      ).toISOString();
      return {
        postId: `post-${index}`,
        createdAt,
        sourceKind: "reply" as const,
        conversationId: `conversation-${index}`,
      };
    });
    const result = generateShadowForecastV2(makeInput({ posts }));
    const multipliers = result.features.circadian.futureMultipliers;

    expect(result.features.circadian.observationCount).toBe(30);
    expect(multipliers.every((value) => value > 0)).toBe(true);
    expect(multipliers.reduce((sum, value) => sum + value, 0) / multipliers.length).toBeCloseTo(
      1,
      12,
    );
    expect(new Set(multipliers).size).toBeGreaterThan(1);
  });

  it("assigns more near-term risk to historically shorter reset intervals", () => {
    const frequent = generateShadowForecastV2(makeInput({ resetEvents: resetHistory(20, 24, 6) }));
    const sparse = generateShadowForecastV2(makeInput({ resetEvents: resetHistory(20, 120, 6) }));

    expect(frequent.forecast.cumulative.within24h).toBeGreaterThan(
      sparse.forecast.cumulative.within24h,
    );
  });
});

function makeInput(overrides: Partial<ForecastV2GenerationInput> = {}): ForecastV2GenerationInput {
  return {
    runId: "v2-run-1",
    snapshotId: "v2-snapshot-1",
    generatedAt: GENERATED_AT,
    posts: [],
    signals: [
      {
        postId: "signal-1",
        observedAt: "2026-08-02T20:00:00.000Z",
        extraction: SignalExtractionSchema.parse({
          explicitResetState: "none",
          futureCommitment: "none",
          timeHint: { kind: "none", startAt: null, endAt: null, rawPhrase: null },
          scope: "unknown",
          incidentSignal: 0,
          milestoneSignal: 0,
          resetRelevance: 0,
          sentiment: "neutral",
          confidence: 1,
          evidenceSpans: [],
          reasonCode: "no_signal",
        }),
      },
    ],
    resetEvents: [],
    externalEvents: [],
    targetCoverage: 1,
    externalCoverage: 1,
    ...overrides,
  };
}

function reset(eventId: string, hoursAgo: number, scope = "all"): ForecastV2ResetRecord {
  const occurredAt = new Date(Date.parse(GENERATED_AT) - hoursAgo * HOUR_MS).toISOString();
  return {
    eventId,
    status: "confirmed_reset",
    occurredAt,
    knownAt: occurredAt,
    scope,
    supersedesEventId: null,
  };
}

function resetHistory(
  count: number,
  intervalHours: number,
  lastResetHoursAgo = intervalHours,
): ForecastV2ResetRecord[] {
  return Array.from({ length: count }, (_, index) =>
    reset(`reset-${index}`, lastResetHoursAgo + (count - index - 1) * intervalHours),
  );
}

function competitorRelease(): ExternalEvent {
  return {
    eventId: "anthropic-release-1",
    sourceType: "official_release",
    provider: "Anthropic",
    eventType: "model_release",
    title: "Model release",
    sourceUrl: "https://www.anthropic.com/news/example",
    occurredAt: "2026-08-02T18:00:00.000Z",
    knownAt: "2026-08-02T18:00:00.000Z",
    endedAt: null,
    relevance: 1,
    severity: 1,
    metadata: {},
  };
}
