import { z } from "zod";

export const ForecastV2MaturitySchema = z.enum([
  "insufficient_history",
  "shadow",
  "backtested",
  "calibrated",
]);
export type ForecastV2Maturity = z.infer<typeof ForecastV2MaturitySchema>;

export const ExternalEventSchema = z.object({
  eventId: z.string().min(1),
  sourceType: z.enum(["official_status", "official_release"]),
  provider: z.string().min(1),
  eventType: z.string().regex(/^[a-z0-9_]+$/),
  title: z.string().min(1),
  sourceUrl: z.string().url(),
  occurredAt: z.string().datetime(),
  knownAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  relevance: z.number().min(0).max(1),
  severity: z.number().min(0).max(1),
  metadata: z.record(z.unknown()),
});
export type ExternalEvent = z.infer<typeof ExternalEventSchema>;

export const ForecastV2CoefficientsSchema = z.object({
  postBurstZ: z.number().finite(),
  replyBurstZ: z.number().finite(),
  textBucketScore: z.number().finite(),
  openAiIncident: z.number().finite(),
  competitorRelease: z.number().finite(),
});
export type ForecastV2Coefficients = z.infer<typeof ForecastV2CoefficientsSchema>;

export const ForecastV2ModelParametersSchema = z.object({
  modelVersion: z.string().min(1),
  validationStatus: z.enum(["shadow", "backtested", "calibrated"]),
  trainedResetCount: z.number().int().nonnegative(),
  coefficients: ForecastV2CoefficientsSchema,
});
export type ForecastV2ModelParameters = z.infer<typeof ForecastV2ModelParametersSchema>;

const nullableNonnegativeNumber = z.number().nonnegative().nullable();

export const ForecastV2BaselineBinSchema = z.object({
  label: z.string().min(1),
  fromHours: z.number().nonnegative(),
  toHours: nullableNonnegativeNumber,
  eventCount: z.number().int().nonnegative(),
  exposureCount: z.number().int().nonnegative(),
  hazardProbability: z.number().min(0).max(0.99),
});

export const ForecastV2FeatureSnapshotSchema = z.object({
  schemaVersion: z.literal("2.0"),
  snapshotId: z.string().min(1),
  generatedAt: z.string().datetime(),
  featureVersion: z.string().min(1),
  inputHash: z.string().min(1),
  maturity: ForecastV2MaturitySchema,
  confirmedResetCount: z.number().int().nonnegative(),
  history: z.object({
    lastResetAt: z.string().datetime().nullable(),
    hoursSinceLastReset: nullableNonnegativeNumber,
    intervalHours: z.array(z.number().positive()),
    quantiles: z.object({
      p25: nullableNonnegativeNumber,
      p50: nullableNonnegativeNumber,
      p75: nullableNonnegativeNumber,
      p90: nullableNonnegativeNumber,
    }),
    baselineBins: z.array(ForecastV2BaselineBinSchema).min(1),
  }),
  circadian: z.object({
    observationCount: z.number().int().nonnegative(),
    hourlyActivity: z.array(z.number().nonnegative()).length(24),
    futureMultipliers: z.array(z.number().positive()).length(28),
  }),
  activity: z.object({
    posts6h: z.number().int().nonnegative(),
    replies6h: z.number().int().nonnegative(),
    posts24h: z.number().int().nonnegative(),
    replies24h: z.number().int().nonnegative(),
    uniqueConversations24h: z.number().int().nonnegative(),
    postBurstZ: z.number(),
    replyBurstZ: z.number(),
  }),
  text: z.object({
    explicitFuture: z.number().nonnegative(),
    weakFuture: z.number().nonnegative(),
    retracted: z.number().nonnegative(),
    incident: z.number().nonnegative(),
    milestone: z.number().nonnegative(),
    bucketScores: z.array(z.number()).length(28),
    bucketReasonCodes: z.array(z.array(z.string())).length(28),
  }),
  external: z.object({
    openAiIncident: z.number().min(0).max(1),
    competitorRelease: z.number().min(0).max(1),
    reasonCodes: z.array(z.string()),
  }),
  coverage: z.object({
    target: z.number().min(0).max(1),
    external: z.number().min(0).max(1),
    targetMissing: z.boolean(),
    externalMissing: z.boolean(),
  }),
});
export type ForecastV2FeatureSnapshot = z.infer<typeof ForecastV2FeatureSnapshotSchema>;

export const ShadowForecastV2BucketSchema = z.object({
  index: z.number().int().min(0).max(27),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  hazardProbability: z.number().min(0).max(0.99),
  intervalProbability: z.number().min(0).max(0.99),
  cumulativeProbability: z.number().min(0).max(0.99),
  topReasonCodes: z.array(z.string()).max(4),
});

export const ShadowForecastV2Schema = z.object({
  schemaVersion: z.literal("2.0"),
  runId: z.string().min(1),
  generatedAt: z.string().datetime(),
  horizonStart: z.string().datetime(),
  horizonEnd: z.string().datetime(),
  model: z.object({
    version: z.string().min(1),
    featureVersion: z.string().min(1),
    maturity: ForecastV2MaturitySchema,
    publicImpact: z.literal("none"),
  }),
  coverage: ForecastV2FeatureSnapshotSchema.shape.coverage,
  cumulative: z.object({
    within24h: z.number().min(0).max(0.99),
    within48h: z.number().min(0).max(0.99),
    within72h: z.number().min(0).max(0.99),
    within168h: z.number().min(0).max(0.99),
  }),
  days: z
    .array(
      z.object({
        dayIndex: z.number().int().min(1).max(7),
        intervalProbability: z.number().min(0).max(0.99),
        cumulativeProbability: z.number().min(0).max(0.99),
        buckets: z.array(ShadowForecastV2BucketSchema).length(4),
      }),
    )
    .length(7),
  disclaimer: z.string().min(1),
});
export type ShadowForecastV2 = z.infer<typeof ShadowForecastV2Schema>;
