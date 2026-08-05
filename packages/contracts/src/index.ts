import { z } from "zod";

export * from "./forecast-v2.js";

export const ActivityStatusSchema = z.enum(["active", "cooling", "quiet", "data_delayed"]);
export type ActivityStatus = z.infer<typeof ActivityStatusSchema>;

export const FreshnessStatusSchema = z.enum(["fresh", "delayed", "stale"]);
export type FreshnessStatus = z.infer<typeof FreshnessStatusSchema>;

export const SourceKindSchema = z.enum(["post", "reply", "quote", "repost"]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const TargetConfigSchema = z.object({
  schemaVersion: z.literal("1.0"),
  mode: z.enum(["demo", "live"]),
  target: z.object({
    userId: z.string().min(1),
    handle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
    displayName: z.string().min(1),
  }),
  authoritativeUserIds: z.array(z.string().min(1)).min(1),
  resetDefinition: z.string().min(1),
  bankedResetPolicy: z.enum(["confirm", "forecast_only", "ignore"]),
});
export type TargetConfig = z.infer<typeof TargetConfigSchema>;

export const SourcePostObservedSchema = z.object({
  postId: z.string().min(1),
  authorId: z.string().min(1),
  authorDisplayName: z.string().nullable(),
  authorHandle: z.string().nullable(),
  authorAvatarUrl: z.string().url().nullable(),
  sourceKind: SourceKindSchema,
  conversationId: z.string().nullable(),
  referencedPostIds: z.array(z.string()),
  language: z.string().nullable(),
  sourceUrl: z.string().url(),
  text: z.string(),
  contentHash: z.string().min(1),
  createdAt: z.string().datetime(),
  observedAt: z.string().datetime(),
  editedAt: z.string().datetime().nullable(),
  deletedAt: z.string().datetime().nullable(),
});
export type SourcePostObserved = z.infer<typeof SourcePostObservedSchema>;

export const EvidenceSpanSchema = z.object({
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  label: z.string().min(1),
});

export const SignalExtractionSchema = z.object({
  explicitResetState: z.enum([
    "none",
    "future",
    "rolling_out_now",
    "completed",
    "limited",
    "retracted",
    "ambiguous",
  ]),
  futureCommitment: z.enum(["none", "weak", "explicit"]),
  timeHint: z.object({
    kind: z.enum(["none", "relative", "absolute", "range"]),
    startAt: z.string().datetime().nullable(),
    endAt: z.string().datetime().nullable(),
    rawPhrase: z.string().nullable(),
  }),
  scope: z.enum(["unknown", "all", "plan", "region", "cohort"]),
  incidentSignal: z.number().min(0).max(1),
  milestoneSignal: z.number().min(0).max(1),
  resetRelevance: z.number().min(0).max(1),
  sentiment: z.enum(["negative", "neutral", "positive", "mixed"]),
  confidence: z.number().min(0).max(1),
  evidenceSpans: z.array(EvidenceSpanSchema),
  reasonCode: z.string().regex(/^[a-z0-9_]+$/),
});
export type SignalExtraction = z.infer<typeof SignalExtractionSchema>;

export const ForecastBucketSchema = z.object({
  index: z.number().int().min(0).max(27),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  hazardProbability: z.number().min(0).max(0.99),
  intervalProbability: z.number().min(0).max(0.99),
  cumulativeProbability: z.number().min(0).max(0.99),
  topReasonCodes: z.array(z.string()).max(4),
});
export type ForecastBucket = z.infer<typeof ForecastBucketSchema>;

export const ForecastDaySchema = z.object({
  dayIndex: z.number().int().min(1).max(7),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  intervalProbability: z.number().min(0).max(0.99),
  cumulativeProbability: z.number().min(0).max(0.99),
  signalLevel: z.enum(["calm", "slight", "gathering", "elevated", "strong"]),
  buckets: z.array(ForecastBucketSchema).length(4),
});
export type ForecastDay = z.infer<typeof ForecastDaySchema>;

export const ResetStateSchema = z.enum([
  "forecasting",
  "candidate_confirmation",
  "confirmed_reset",
  "retracted",
]);
export type ResetState = z.infer<typeof ResetStateSchema>;

export const ResetEventSchema = z.object({
  eventId: z.string(),
  status: ResetStateSchema.exclude(["forecasting"]),
  occurredAt: z.string().datetime().nullable(),
  scope: z.string(),
  evidencePostIds: z.array(z.string()).min(1),
  supersedesEventId: z.string().nullable().default(null),
});
export type ResetEvent = z.infer<typeof ResetEventSchema>;

export const ForecastSnapshotSchema = z.object({
  schemaVersion: z.literal("1.0"),
  runId: z.string(),
  generatedAt: z.string().datetime(),
  horizonStart: z.string().datetime(),
  horizonEnd: z.string().datetime(),
  timezone: z.string(),
  model: z.object({
    version: z.string(),
    validationStatus: z.enum(["heuristic", "backtested", "calibrated"]),
    calibratedAt: z.string().datetime().nullable(),
  }),
  dataFreshness: z.object({
    status: FreshnessStatusSchema,
    lastObservedAt: z.string().datetime().nullable(),
    lagSeconds: z.number().nonnegative().nullable(),
    confidence: z.number().min(0).max(1),
  }),
  activity: z.object({
    status: ActivityStatusSchema,
    lastPublicActivityAt: z.string().datetime().nullable(),
  }),
  cumulative: z.object({
    within24h: z.number().min(0).max(0.99),
    within48h: z.number().min(0).max(0.99),
    within72h: z.number().min(0).max(0.99),
    within168h: z.number().min(0).max(0.99),
  }),
  days: z.array(ForecastDaySchema).length(7),
  confirmedSignal: ResetEventSchema.nullable(),
  disclaimer: z.string(),
});
export type ForecastSnapshot = z.infer<typeof ForecastSnapshotSchema>;

export interface RadarStatus {
  serviceVersion: string;
  demoMode: boolean;
  collector: {
    status: FreshnessStatus;
    lastSuccessAt: string | null;
    consecutiveFailures: number;
  };
  activity: {
    status: ActivityStatus;
    lastPublicActivityAt: string | null;
    likelySleeping?: boolean;
    sleepWindowUtc?: {
      startHour: number;
      endHour: number;
      sampleSize: number;
    } | null;
  };
}

export interface RadarEventsResponse {
  window: string;
  items: SourcePostObserved[];
}

export interface RadarResetStatusResponse {
  state: ResetState;
  event: ResetEvent | null;
}

export interface RadarApiErrorPayload {
  error: {
    code: string;
    message: string;
  };
}
