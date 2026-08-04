import { createHash } from "node:crypto";

import {
  type ExternalEvent,
  type ForecastV2Coefficients,
  type ForecastV2FeatureSnapshot,
  ForecastV2FeatureSnapshotSchema,
  type ForecastV2Maturity,
  type ForecastV2ModelParameters,
  type ShadowForecastV2,
  ShadowForecastV2Schema,
  type SignalExtraction,
} from "@tibo-radar/contracts";

const BUCKET_COUNT = 28;
const BUCKET_HOURS = 6;
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_WEEKLY_PRIOR = 0.1;
const PRIOR_EXPOSURE_BUCKETS = 20;
const MAX_HAZARD = 0.99;
const ACTIVITY_WINDOW_MS = 90 * DAY_MS;
const SIGNAL_WINDOW_MS = 168 * HOUR_MS;

export const FORECAST_V2_FEATURE_VERSION = "forecast-features-v2";
export const FORECAST_V2_MODEL_VERSION = "survival-v2-shadow";

export interface ForecastV2Post {
  postId: string;
  createdAt: string;
  sourceKind: "post" | "reply" | "quote" | "repost";
  conversationId: string | null;
}

export interface ForecastV2Signal {
  postId: string;
  /** When the source claim was published or edited, never when extraction happened. */
  sourceAt: string;
  extraction: SignalExtraction;
}

export interface ForecastV2ResetRecord {
  eventId: string;
  status: "candidate_confirmation" | "confirmed_reset" | "retracted";
  occurredAt: string | null;
  knownAt: string;
  scope: string;
  supersedesEventId: string | null;
}

export type { ForecastV2Coefficients, ForecastV2ModelParameters };

export interface ForecastV2GenerationInput {
  runId: string;
  snapshotId: string;
  generatedAt: string;
  posts: readonly ForecastV2Post[];
  signals: readonly ForecastV2Signal[];
  resetEvents: readonly ForecastV2ResetRecord[];
  externalEvents: readonly ExternalEvent[];
  targetCoverage: number;
  externalCoverage: number;
  parameters?: ForecastV2ModelParameters;
}

export interface ForecastV2GenerationResult {
  features: ReturnType<typeof buildForecastV2FeatureSnapshot>;
  forecast: ShadowForecastV2;
}

const BASELINE_BINS = [
  { label: "0_24h", fromHours: 0, toHours: 24 },
  { label: "24_48h", fromHours: 24, toHours: 48 },
  { label: "48_72h", fromHours: 48, toHours: 72 },
  { label: "3_5d", fromHours: 72, toHours: 120 },
  { label: "5_7d", fromHours: 120, toHours: 168 },
  { label: "7_14d", fromHours: 168, toHours: 336 },
  { label: "14d_plus", fromHours: 336, toHours: null },
] as const;

export const ZERO_FORECAST_V2_COEFFICIENTS: ForecastV2Coefficients = {
  postBurstZ: 0,
  replyBurstZ: 0,
  textBucketScore: 0,
  openAiIncident: 0,
  competitorRelease: 0,
};

export function generateShadowForecastV2(
  input: ForecastV2GenerationInput,
): ForecastV2GenerationResult {
  const generatedMs = requiredTimestamp(input.generatedAt, "generatedAt");
  const primaryResets = effectivePrimaryResets(input.resetEvents, generatedMs);
  const maturity = modelMaturity(primaryResets.length, input.parameters);
  const features = buildForecastV2FeatureSnapshot(input, primaryResets, maturity);
  const activeParameters =
    maturity === "backtested" || maturity === "calibrated" ? input.parameters : undefined;
  const coefficients = activeParameters?.coefficients ?? ZERO_FORECAST_V2_COEFFICIENTS;

  let survival = 1;
  const buckets = Array.from({ length: BUCKET_COUNT }, (_, index) => {
    const startMs = generatedMs + index * BUCKET_HOURS * HOUR_MS;
    const endMs = startMs + BUCKET_HOURS * HOUR_MS;
    const elapsedHours =
      features.history.hoursSinceLastReset === null
        ? index * BUCKET_HOURS
        : features.history.hoursSinceLastReset + index * BUCKET_HOURS;
    const baseline = baselineHazard(features.history.baselineBins, elapsedHours);
    const futureHours = index * BUCKET_HOURS;
    const activityDecay = halfLifeDecay(futureHours, 6);
    const externalDecay = halfLifeDecay(futureHours, 24);
    const linearAdjustment =
      coefficients.postBurstZ * features.activity.postBurstZ * activityDecay +
      coefficients.replyBurstZ * features.activity.replyBurstZ * activityDecay +
      coefficients.textBucketScore * (features.text.bucketScores[index] ?? 0) +
      coefficients.openAiIncident * features.external.openAiIncident * externalDecay +
      coefficients.competitorRelease * features.external.competitorRelease * externalDecay;
    const circadian = features.circadian.futureMultipliers[index] ?? 1;
    const baselineIntensity = -Math.log(1 - baseline);
    const intensity = baselineIntensity * circadian * Math.exp(clamp(linearAdjustment, -3, 3));
    const rawHazard = clamp(1 - Math.exp(-intensity), 0, MAX_HAZARD);
    const priorCumulative = 1 - survival;
    const intervalProbability = Math.min(
      survival * rawHazard,
      Math.max(0, MAX_HAZARD - priorCumulative),
    );
    const hazardProbability = survival > 0 ? intervalProbability / survival : 0;
    survival -= intervalProbability;
    const cumulativeProbability = clamp(1 - survival, 0, MAX_HAZARD);
    return {
      index,
      startAt: new Date(startMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
      hazardProbability,
      intervalProbability,
      cumulativeProbability,
      topReasonCodes: bucketReasons(index, features, coefficients),
    };
  });

  const days = Array.from({ length: 7 }, (_, offset) => {
    const dayBuckets = buckets.slice(offset * 4, offset * 4 + 4);
    const last = dayBuckets[3];
    if (!last) throw new Error(`Forecast v2 day ${offset + 1} is incomplete`);
    return {
      dayIndex: offset + 1,
      intervalProbability: dayBuckets.reduce((sum, bucket) => sum + bucket.intervalProbability, 0),
      cumulativeProbability: last.cumulativeProbability,
      buckets: dayBuckets,
    };
  });
  const cumulativeAt = (index: number): number => {
    const bucket = buckets[index];
    if (!bucket) throw new Error(`Forecast v2 bucket ${index} is missing`);
    return bucket.cumulativeProbability;
  };
  const forecast = ShadowForecastV2Schema.parse({
    schemaVersion: "2.0",
    runId: input.runId,
    generatedAt: input.generatedAt,
    horizonStart: input.generatedAt,
    horizonEnd: new Date(generatedMs + BUCKET_COUNT * BUCKET_HOURS * HOUR_MS).toISOString(),
    model: {
      version: activeParameters?.modelVersion ?? FORECAST_V2_MODEL_VERSION,
      featureVersion: FORECAST_V2_FEATURE_VERSION,
      maturity,
      publicImpact: "none",
    },
    coverage: features.coverage,
    cumulative: {
      within24h: cumulativeAt(3),
      within48h: cumulativeAt(7),
      within72h: cumulativeAt(11),
      within168h: cumulativeAt(27),
    },
    days,
    disclaimer: "Shadow forecast only; it does not affect the public heuristic-v1 forecast.",
  });
  return { features, forecast };
}

export function isPrimaryResetScope(scope: string): boolean {
  return scope === "all" || scope === "unknown";
}

function buildForecastV2FeatureSnapshot(
  input: ForecastV2GenerationInput,
  primaryResets: readonly ForecastV2ResetRecord[],
  maturity: ForecastV2Maturity,
) {
  const generatedMs = requiredTimestamp(input.generatedAt, "generatedAt");
  const resetTimes = primaryResets
    .map((event) => requiredTimestamp(event.occurredAt ?? "", `reset ${event.eventId}`))
    .sort((left, right) => left - right);
  const intervalHours = resetTimes.slice(1).flatMap((value, index) => {
    const previous = resetTimes[index];
    if (previous === undefined) throw new Error("Reset interval is missing its start");
    const interval = (value - previous) / HOUR_MS;
    return interval > 0 ? [interval] : [];
  });
  const lastResetMs = resetTimes.at(-1) ?? null;
  const hoursSinceLastReset =
    lastResetMs === null ? null : Math.max(0, (generatedMs - lastResetMs) / HOUR_MS);
  const baselineBins = buildBaselineBins(intervalHours, hoursSinceLastReset);
  const circadian = buildCircadianFeatures(input.posts, generatedMs);
  const activity = buildActivityFeatures(input.posts, generatedMs);
  const text = buildTextFeatures(input.signals, generatedMs, lastResetMs);
  const external = buildExternalFeatures(input.externalEvents, generatedMs);
  const targetCoverage = clamp(input.targetCoverage, 0, 1);
  const externalCoverage = clamp(input.externalCoverage, 0, 1);
  const inputHash = createHash("sha256")
    .update(
      JSON.stringify({
        generatedAt: input.generatedAt,
        posts: input.posts,
        signals: input.signals,
        resetEvents: input.resetEvents,
        externalEvents: input.externalEvents,
        targetCoverage,
        externalCoverage,
        parameters: input.parameters ?? null,
      }),
    )
    .digest("hex");
  return ForecastV2FeatureSnapshotSchema.parse({
    schemaVersion: "2.0",
    snapshotId: input.snapshotId,
    generatedAt: input.generatedAt,
    featureVersion: FORECAST_V2_FEATURE_VERSION,
    inputHash,
    maturity,
    confirmedResetCount: primaryResets.length,
    history: {
      lastResetAt: lastResetMs === null ? null : new Date(lastResetMs).toISOString(),
      hoursSinceLastReset,
      intervalHours,
      quantiles: {
        p25: quantile(intervalHours, 0.25),
        p50: quantile(intervalHours, 0.5),
        p75: quantile(intervalHours, 0.75),
        p90: quantile(intervalHours, 0.9),
      },
      baselineBins,
    },
    circadian,
    activity,
    text,
    external,
    coverage: {
      target: targetCoverage,
      external: externalCoverage,
      targetMissing: targetCoverage < 0.7,
      externalMissing: externalCoverage < 0.7,
    },
  });
}

function effectivePrimaryResets(
  events: readonly ForecastV2ResetRecord[],
  generatedMs: number,
): ForecastV2ResetRecord[] {
  const visibleEvents = events.filter((event) => {
    const knownMs = optionalTimestamp(event.knownAt);
    return knownMs !== null && knownMs <= generatedMs;
  });
  const retracted = new Set(
    visibleEvents
      .filter((event) => event.status === "retracted" && event.supersedesEventId)
      .map((event) => event.supersedesEventId as string),
  );
  return visibleEvents
    .filter(
      (event) =>
        event.status === "confirmed_reset" &&
        event.occurredAt !== null &&
        requiredTimestamp(event.occurredAt, `reset ${event.eventId}`) <= generatedMs &&
        isPrimaryResetScope(event.scope) &&
        !retracted.has(event.eventId),
    )
    .sort((left, right) => (left.occurredAt ?? "").localeCompare(right.occurredAt ?? ""));
}

function buildBaselineBins(intervalHours: readonly number[], censoredElapsedHours: number | null) {
  const counts = BASELINE_BINS.map(() => ({ eventCount: 0, exposureCount: 0 }));
  for (const interval of intervalHours) {
    const exposureBuckets = Math.max(1, Math.ceil(interval / BUCKET_HOURS));
    for (let index = 0; index < exposureBuckets; index += 1) {
      const binIndex = baselineBinIndex(index * BUCKET_HOURS);
      const count = counts[binIndex];
      if (count) count.exposureCount += 1;
    }
    const eventBin = counts[baselineBinIndex(Math.max(0, interval - 1e-9))];
    if (eventBin) eventBin.eventCount += 1;
  }
  if (censoredElapsedHours !== null) {
    const completedBuckets = Math.floor(censoredElapsedHours / BUCKET_HOURS);
    for (let index = 0; index < completedBuckets; index += 1) {
      const bin = counts[baselineBinIndex(index * BUCKET_HOURS)];
      if (bin) bin.exposureCount += 1;
    }
  }
  const totalExposure = counts.reduce((sum, item) => sum + item.exposureCount, 0);
  const totalEvents = counts.reduce((sum, item) => sum + item.eventCount, 0);
  const observedPrior = totalExposure > 0 ? totalEvents / totalExposure : null;
  const prior = clamp(observedPrior ?? weeklyToBucketHazard(DEFAULT_WEEKLY_PRIOR), 0.0001, 0.5);
  return BASELINE_BINS.map((bin, index) => {
    const count = counts[index] ?? { eventCount: 0, exposureCount: 0 };
    return {
      ...bin,
      eventCount: count.eventCount,
      exposureCount: count.exposureCount,
      hazardProbability: clamp(
        (count.eventCount + prior * PRIOR_EXPOSURE_BUCKETS) /
          (count.exposureCount + PRIOR_EXPOSURE_BUCKETS),
        0,
        MAX_HAZARD,
      ),
    };
  });
}

function buildCircadianFeatures(posts: readonly ForecastV2Post[], generatedMs: number) {
  const hourlyActivity = Array.from({ length: 24 }, () => 0);
  let observationCount = 0;
  for (const post of posts) {
    const createdMs = optionalTimestamp(post.createdAt);
    if (
      createdMs === null ||
      createdMs > generatedMs ||
      generatedMs - createdMs > ACTIVITY_WINDOW_MS
    )
      continue;
    const ageDays = (generatedMs - createdMs) / DAY_MS;
    const hour = new Date(createdMs).getUTCHours();
    hourlyActivity[hour] = (hourlyActivity[hour] ?? 0) + Math.exp(-ageDays / 45);
    observationCount += 1;
  }
  const mean = hourlyActivity.reduce((sum, value) => sum + value, 0) / 24;
  const raw = Array.from({ length: BUCKET_COUNT }, (_, index) => {
    const midpoint = new Date(generatedMs + (index * BUCKET_HOURS + BUCKET_HOURS / 2) * HOUR_MS);
    const activity = hourlyActivity[midpoint.getUTCHours()] ?? 0;
    return clamp((activity + 1) / (mean + 1), 0.35, 1.8);
  });
  const rawMean = raw.reduce((sum, value) => sum + value, 0) / raw.length;
  return {
    observationCount,
    hourlyActivity,
    futureMultipliers: raw.map((value) => value / rawMean),
  };
}

function buildActivityFeatures(posts: readonly ForecastV2Post[], generatedMs: number) {
  const usable = posts.flatMap((post) => {
    const createdMs = optionalTimestamp(post.createdAt);
    return createdMs === null || createdMs > generatedMs ? [] : [{ post, createdMs }];
  });
  const recent6h = usable.filter(({ createdMs }) => generatedMs - createdMs <= 6 * HOUR_MS);
  const recent24h = usable.filter(({ createdMs }) => generatedMs - createdMs <= DAY_MS);
  const trailing30d = usable.filter(({ createdMs }) => generatedMs - createdMs <= 30 * DAY_MS);
  const isReply = ({ post }: (typeof usable)[number]) => post.sourceKind === "reply";
  const posts6h = recent6h.filter((item) => !isReply(item)).length;
  const replies6h = recent6h.filter(isReply).length;
  const posts24h = recent24h.filter((item) => !isReply(item)).length;
  const replies24h = recent24h.filter(isReply).length;
  const expectedPosts6h = trailing30d.filter((item) => !isReply(item)).length / 120;
  const expectedReplies6h = trailing30d.filter(isReply).length / 120;
  return {
    posts6h,
    replies6h,
    posts24h,
    replies24h,
    uniqueConversations24h: new Set(
      recent24h.map(({ post }) => post.conversationId).filter((value) => value !== null),
    ).size,
    postBurstZ: poissonZ(posts6h, expectedPosts6h),
    replyBurstZ: poissonZ(replies6h, expectedReplies6h),
  };
}

function buildTextFeatures(
  signals: readonly ForecastV2Signal[],
  generatedMs: number,
  lastResetMs: number | null,
) {
  let explicitFuture = 0;
  let weakFuture = 0;
  let retracted = 0;
  let incident = 0;
  let milestone = 0;
  const bucketScores = Array.from({ length: BUCKET_COUNT }, () => 0);
  const bucketReasonCodes = Array.from({ length: BUCKET_COUNT }, () => [] as string[]);
  for (const signal of signals) {
    const sourceMs = optionalTimestamp(signal.sourceAt);
    if (
      sourceMs === null ||
      sourceMs > generatedMs ||
      generatedMs - sourceMs > SIGNAL_WINDOW_MS ||
      (lastResetMs !== null && sourceMs <= lastResetMs)
    )
      continue;
    const extraction = signal.extraction;
    const ageHours = (generatedMs - sourceMs) / HOUR_MS;
    const common = extraction.resetRelevance * extraction.confidence * Math.exp(-ageHours / 72);
    const explicit = extraction.futureCommitment === "explicit" ? common : 0;
    const weak = extraction.futureCommitment === "weak" ? common : 0;
    const retraction = extraction.explicitResetState === "retracted" ? common : 0;
    const incidentValue = extraction.incidentSignal * common;
    const milestoneValue = extraction.milestoneSignal * common;
    explicitFuture += explicit;
    weakFuture += weak;
    retracted += retraction;
    incident += incidentValue;
    milestone += milestoneValue;
    const hintedMs = optionalTimestamp(extraction.timeHint.startAt);
    const center =
      hintedMs === null
        ? extraction.futureCommitment === "explicit"
          ? 6
          : extraction.incidentSignal >= 0.7
            ? 3
            : extraction.milestoneSignal >= 0.7
              ? 8
              : null
        : clamp(Math.floor((hintedMs - generatedMs) / (BUCKET_HOURS * HOUR_MS)), 0, 27);
    for (let index = 0; index < BUCKET_COUNT; index += 1) {
      const timing = center === null ? 1 : Math.exp(-((index - center) ** 2) / 12);
      const score =
        (explicit + weak * 0.5 - retraction + incidentValue * 0.35 + milestoneValue * 0.25) *
        timing;
      bucketScores[index] = (bucketScores[index] ?? 0) + score;
      if (Math.abs(score) > 0.01) {
        const reasons = bucketReasonCodes[index];
        if (reasons && !reasons.includes(extraction.reasonCode))
          reasons.push(extraction.reasonCode);
      }
    }
  }
  return {
    explicitFuture,
    weakFuture,
    retracted,
    incident,
    milestone,
    bucketScores,
    bucketReasonCodes,
  };
}

function buildExternalFeatures(events: readonly ExternalEvent[], generatedMs: number) {
  let openAiIncident = 0;
  let competitorRelease = 0;
  const reasonCodes = new Set<string>();
  for (const event of events) {
    const knownMs = requiredTimestamp(event.knownAt, `external event ${event.eventId} knownAt`);
    const occurredMs = requiredTimestamp(
      event.occurredAt,
      `external event ${event.eventId} occurredAt`,
    );
    if (knownMs > generatedMs || occurredMs > generatedMs) continue;
    const ageHours = (generatedMs - occurredMs) / HOUR_MS;
    if (event.sourceType === "official_status" && event.provider.toLowerCase() === "openai") {
      const endedMs = optionalTimestamp(event.endedAt);
      const resolvedAgeHours =
        endedMs === null ? 0 : Math.max(0, (generatedMs - endedMs) / HOUR_MS);
      const value =
        event.relevance *
        event.severity *
        (endedMs === null ? 1 : halfLifeDecay(resolvedAgeHours, 24));
      openAiIncident = Math.max(openAiIncident, value);
      if (value > 0.05) reasonCodes.add(`openai_${event.eventType}`);
    }
    if (event.sourceType === "official_release" && event.provider.toLowerCase() !== "openai") {
      const value = event.relevance * event.severity * halfLifeDecay(ageHours, 72);
      competitorRelease = Math.max(competitorRelease, value);
      if (value > 0.05) reasonCodes.add(`${slug(event.provider)}_${event.eventType}`);
    }
  }
  return {
    openAiIncident: clamp(openAiIncident, 0, 1),
    competitorRelease: clamp(competitorRelease, 0, 1),
    reasonCodes: [...reasonCodes].sort(),
  };
}

function modelMaturity(
  confirmedResetCount: number,
  parameters: ForecastV2ModelParameters | undefined,
): ForecastV2Maturity {
  if (confirmedResetCount < 20) return "insufficient_history";
  if (!parameters || parameters.trainedResetCount < 20) return "shadow";
  if (
    parameters.validationStatus === "calibrated" &&
    confirmedResetCount >= 50 &&
    parameters.trainedResetCount >= 50
  )
    return "calibrated";
  if (parameters.validationStatus === "backtested") return "backtested";
  return "shadow";
}

function bucketReasons(
  index: number,
  features: ReturnType<typeof buildForecastV2FeatureSnapshot>,
  coefficients: ForecastV2Coefficients,
): string[] {
  const reasons = ["historical_cycle", "circadian_timing"];
  if (coefficients.textBucketScore !== 0)
    reasons.push(...(features.text.bucketReasonCodes[index] ?? []));
  if (coefficients.replyBurstZ !== 0 && Math.abs(features.activity.replyBurstZ) >= 1)
    reasons.push("tibo_reply_burst");
  if (coefficients.postBurstZ !== 0 && Math.abs(features.activity.postBurstZ) >= 1)
    reasons.push("tibo_post_burst");
  if (coefficients.openAiIncident !== 0 && features.external.openAiIncident > 0.05)
    reasons.push("openai_incident");
  if (coefficients.competitorRelease !== 0 && features.external.competitorRelease > 0.05)
    reasons.push("competitor_release");
  if (features.maturity === "insufficient_history") reasons.push("insufficient_history");
  return Array.from(new Set(reasons)).slice(0, 4);
}

function baselineHazard(
  bins: ForecastV2FeatureSnapshot["history"]["baselineBins"],
  elapsedHours: number,
): number {
  return bins[baselineBinIndex(elapsedHours)]?.hazardProbability ?? weeklyToBucketHazard(0.1);
}

function baselineBinIndex(elapsedHours: number): number {
  const index = BASELINE_BINS.findIndex(
    (bin) => elapsedHours >= bin.fromHours && (bin.toHours === null || elapsedHours < bin.toHours),
  );
  return index === -1 ? BASELINE_BINS.length - 1 : index;
}

function quantile(values: readonly number[], probability: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower];
  const upperValue = sorted[upper];
  if (lowerValue === undefined || upperValue === undefined) return null;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

function poissonZ(observed: number, expected: number): number {
  return clamp((observed - expected) / Math.sqrt(Math.max(expected, 1)), -3, 3);
}

function halfLifeDecay(ageHours: number, halfLifeHours: number): number {
  return 2 ** (-Math.max(0, ageHours) / halfLifeHours);
}

function weeklyToBucketHazard(probability: number): number {
  return 1 - (1 - probability) ** (1 / BUCKET_COUNT);
}

function optionalTimestamp(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requiredTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid ISO date-time`);
  return parsed;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "provider"
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
