import {
  type ForecastSnapshot,
  ForecastSnapshotSchema,
  getTiboRoutinePhase,
  type ResetEvent,
  type RoutinePhase,
  type SignalExtraction,
} from "@tibo-radar/contracts";

const BUCKET_COUNT = 28;
const BUCKET_HOURS = 6;
const BUCKET_MS = BUCKET_HOURS * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const MAX_FORECAST_PROBABILITY = 0.99;
const ACTIVITY_ADJUSTMENT_PER_RATIO = 0.15;
const MIN_ACTIVITY_ADJUSTMENT = -0.15;
const MAX_ACTIVITY_ADJUSTMENT = 0.3;
const CIRCADIAN_SAMPLE_MINUTES = 30;

const CIRCADIAN_PHASES: Record<
  RoutinePhase,
  {
    bucketWeight: number;
    probabilityFactors: readonly [number, number, number, number];
    reasonCode: string;
  }
> = {
  sleeping: {
    bucketWeight: 0.15,
    probabilityFactors: [0.65, 0.85, 0.9, 0.97],
    reasonCode: "circadian_sleep",
  },
  awake: {
    bucketWeight: 1,
    probabilityFactors: [1, 1, 1, 1],
    reasonCode: "circadian_awake",
  },
  social: {
    bucketWeight: 1.15,
    probabilityFactors: [1.1, 1.05, 1.03, 1],
    reasonCode: "circadian_social",
  },
  winding_down: {
    bucketWeight: 0.6,
    probabilityFactors: [0.8, 0.92, 0.96, 0.99],
    reasonCode: "circadian_winding_down",
  },
};

interface CadenceBaseline {
  reasonCode: string;
  maxElapsedHours: number;
  within24h: number;
  within48h: number;
  within168h: number;
}

const CADENCE_BASELINES: readonly CadenceBaseline[] = [
  {
    reasonCode: "cadence_0_24h",
    maxElapsedHours: 24,
    within24h: 0.08,
    within48h: 0.3,
    within168h: 0.75,
  },
  {
    reasonCode: "cadence_24_48h",
    maxElapsedHours: 48,
    within24h: 0.2,
    within48h: 0.45,
    within168h: 0.8,
  },
  {
    reasonCode: "cadence_48_72h",
    maxElapsedHours: 72,
    within24h: 0.35,
    within48h: 0.6,
    within168h: 0.85,
  },
  {
    reasonCode: "cadence_3_4d",
    maxElapsedHours: 96,
    within24h: 0.45,
    within48h: 0.7,
    within168h: 0.9,
  },
  {
    reasonCode: "cadence_4_7d",
    maxElapsedHours: 168,
    within24h: 0.55,
    within48h: 0.78,
    within168h: 0.93,
  },
  {
    reasonCode: "cadence_7d_plus",
    maxElapsedHours: Number.POSITIVE_INFINITY,
    within24h: 0.65,
    within48h: 0.85,
    within168h: 0.96,
  },
];

export interface PersistedForecastSignal {
  postId: string;
  /** When the source claim was published or edited, never when a backfill happened. */
  sourceAt: string;
  extraction: SignalExtraction;
}

export interface ForecastActivityMetrics {
  recent24hPostCount: number;
  baselineDailyPostAverage: number | null;
  baselineWindowComplete: boolean;
}

export interface ForecastGenerationInput {
  runId: string;
  generatedAt: string;
  timezone: string;
  modelVersion: string;
  validationStatus?: "heuristic" | "backtested" | "calibrated";
  calibratedAt?: string | null;
  activity: ForecastSnapshot["activity"];
  dataFreshness: ForecastSnapshot["dataFreshness"];
  /** Retained for storage compatibility. Text signals do not change this model's probability. */
  signals: readonly PersistedForecastSignal[];
  lastResetAt?: string | null;
  activityMetrics?: ForecastActivityMetrics;
  confirmedSignal?: ResetEvent | null;
  previousSnapshot?: ForecastSnapshot | null;
}

interface AdjustedProbabilities {
  within24h: number;
  within48h: number;
  within72h: number;
  within168h: number;
  reasonCodes: string[];
}

export function generateForecast(input: ForecastGenerationInput): ForecastSnapshot {
  validateTimestamp(input.generatedAt, "generatedAt");
  if (input.dataFreshness.status === "stale" && input.previousSnapshot) {
    return ForecastSnapshotSchema.parse({
      ...input.previousSnapshot,
      dataFreshness: input.dataFreshness,
      activity: input.activity,
    });
  }

  const generatedMs = Date.parse(input.generatedAt);
  const elapsedHours = hoursSinceLastReset(input.lastResetAt, generatedMs);
  const baseline = cadenceBaseline(elapsedHours);
  const postingAdjusted = adjustForPostingActivity(baseline, input.activityMetrics);
  const adjusted = adjustForCircadianPhase(
    postingAdjusted,
    generatedMs,
    input.activity.lastPublicActivityAt,
  );
  const intervalProbabilities = distributeAcrossBuckets(adjusted, generatedMs);

  let cumulative = 0;
  const buckets = intervalProbabilities.map((intervalProbability, index) => {
    const previousCumulative = cumulative;
    cumulative += intervalProbability;
    if (index === BUCKET_COUNT - 1) cumulative = adjusted.within168h;
    const startAt = new Date(generatedMs + index * BUCKET_MS).toISOString();
    const endAt = new Date(generatedMs + (index + 1) * BUCKET_MS).toISOString();
    const hazardProbability = intervalProbability / (1 - previousCumulative);
    return {
      index,
      startAt,
      endAt,
      hazardProbability: Math.min(MAX_FORECAST_PROBABILITY, hazardProbability),
      intervalProbability,
      cumulativeProbability: cumulative,
      topReasonCodes: adjusted.reasonCodes,
    };
  });

  const days = Array.from({ length: 7 }, (_, dayOffset) => {
    const dayBuckets = buckets.slice(dayOffset * 4, dayOffset * 4 + 4);
    const intervalProbability = dayBuckets.reduce(
      (sum, bucket) => sum + bucket.intervalProbability,
      0,
    );
    const last = dayBuckets[3];
    if (!last) throw new Error(`Forecast day ${dayOffset + 1} is missing buckets`);
    return {
      dayIndex: dayOffset + 1,
      startAt: dayBuckets[0]?.startAt,
      endAt: last.endAt,
      intervalProbability,
      cumulativeProbability: last.cumulativeProbability,
      signalLevel: signalLevelFor(intervalProbability),
      buckets: dayBuckets,
    };
  });

  const atBucketEnd = (index: number): number => {
    const bucket = buckets[index];
    if (!bucket) throw new Error(`Forecast bucket ${index} is missing`);
    return bucket.cumulativeProbability;
  };

  return ForecastSnapshotSchema.parse({
    schemaVersion: "1.0",
    runId: input.runId,
    generatedAt: input.generatedAt,
    horizonStart: input.generatedAt,
    horizonEnd: new Date(generatedMs + BUCKET_COUNT * BUCKET_MS).toISOString(),
    timezone: input.timezone,
    model: {
      version: input.modelVersion,
      validationStatus: input.validationStatus ?? "heuristic",
      calibratedAt: input.calibratedAt ?? null,
    },
    dataFreshness: input.dataFreshness,
    activity: input.activity,
    cumulative: {
      within24h: atBucketEnd(3),
      within48h: atBucketEnd(7),
      within72h: atBucketEnd(11),
      within168h: atBucketEnd(27),
    },
    days,
    confirmedSignal: input.confirmedSignal ?? null,
    disclaimer:
      "概率基于距上次确认 Reset 的时间、Tibo 发帖数量与旧金山作息；不分析文案，不使用随机数，最高为 99%。",
  });
}

function hoursSinceLastReset(lastResetAt: string | null | undefined, generatedMs: number) {
  if (!lastResetAt) return null;
  const resetMs = Date.parse(lastResetAt);
  if (!Number.isFinite(resetMs)) throw new Error("lastResetAt must be a valid ISO date-time");
  return Math.max(0, (generatedMs - resetMs) / HOUR_MS);
}

function cadenceBaseline(elapsedHours: number | null): CadenceBaseline {
  if (elapsedHours === null) return CADENCE_BASELINES[1] as CadenceBaseline;
  return (
    CADENCE_BASELINES.find((candidate) => elapsedHours < candidate.maxElapsedHours) ??
    (CADENCE_BASELINES.at(-1) as CadenceBaseline)
  );
}

function adjustForPostingActivity(
  baseline: CadenceBaseline,
  metrics: ForecastActivityMetrics | undefined,
): AdjustedProbabilities {
  const activity = activityAdjustment(metrics);
  const baseline72h = baseline.within48h + (baseline.within168h - baseline.within48h) * 0.2;
  const within24h = adjustProbability(baseline.within24h, activity.value, 0.95);
  const within48h = Math.max(
    within24h,
    adjustProbability(baseline.within48h, activity.value * 0.6, 0.97),
  );
  const within72h = Math.max(within48h, adjustProbability(baseline72h, activity.value * 0.4, 0.98));
  const within168h = Math.max(
    within72h,
    adjustProbability(baseline.within168h, activity.value * 0.2, MAX_FORECAST_PROBABILITY),
  );
  return {
    within24h,
    within48h,
    within72h,
    within168h,
    reasonCodes: [baseline.reasonCode, activity.reasonCode],
  };
}

function activityAdjustment(metrics: ForecastActivityMetrics | undefined): {
  value: number;
  reasonCode: string;
} {
  if (
    !metrics?.baselineWindowComplete ||
    metrics.baselineDailyPostAverage === null ||
    metrics.baselineDailyPostAverage <= 0
  ) {
    return { value: 0, reasonCode: "post_activity_baseline_unavailable" };
  }
  const ratio = metrics.recent24hPostCount / metrics.baselineDailyPostAverage;
  const value = clamp(
    (ratio - 1) * ACTIVITY_ADJUSTMENT_PER_RATIO,
    MIN_ACTIVITY_ADJUSTMENT,
    MAX_ACTIVITY_ADJUSTMENT,
  );
  if (value > 0.001) return { value, reasonCode: "post_activity_high" };
  if (value < -0.001) return { value, reasonCode: "post_activity_low" };
  return { value: 0, reasonCode: "post_activity_normal" };
}

function adjustProbability(base: number, adjustment: number, maximum: number): number {
  const adjusted = adjustment >= 0 ? base + (1 - base) * adjustment : base * (1 + adjustment);
  return clamp(adjusted, 0.01, maximum);
}

function adjustForCircadianPhase(
  probabilities: AdjustedProbabilities,
  generatedMs: number,
  lastPublicActivityAt: string | null,
): AdjustedProbabilities {
  const phase = getTiboRoutinePhase(new Date(generatedMs), lastPublicActivityAt);
  const [factor24h, factor48h, factor72h, factor168h] = CIRCADIAN_PHASES[phase].probabilityFactors;
  const within24h = clamp(probabilities.within24h * factor24h, 0.01, 0.95);
  const within48h = Math.max(within24h, clamp(probabilities.within48h * factor48h, 0.01, 0.97));
  const within72h = Math.max(within48h, clamp(probabilities.within72h * factor72h, 0.01, 0.98));
  const within168h = Math.max(
    within72h,
    clamp(probabilities.within168h * factor168h, 0.01, MAX_FORECAST_PROBABILITY),
  );
  return {
    within24h,
    within48h,
    within72h,
    within168h,
    reasonCodes: [...probabilities.reasonCodes, CIRCADIAN_PHASES[phase].reasonCode],
  };
}

function distributeAcrossBuckets(
  probabilities: AdjustedProbabilities,
  generatedMs: number,
): number[] {
  const anchors = [
    { endIndex: 3, probability: probabilities.within24h },
    { endIndex: 7, probability: probabilities.within48h },
    { endIndex: 11, probability: probabilities.within72h },
    { endIndex: 27, probability: probabilities.within168h },
  ];
  const intervals: number[] = [];
  let previousIndex = -1;
  let previousProbability = 0;
  for (const anchor of anchors) {
    const bucketCount = anchor.endIndex - previousIndex;
    const segmentProbability = anchor.probability - previousProbability;
    const weights = Array.from({ length: bucketCount }, (_, offset) =>
      circadianBucketWeight(generatedMs + (previousIndex + 1 + offset) * BUCKET_MS),
    );
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    for (const weight of weights) intervals.push(segmentProbability * (weight / totalWeight));
    previousIndex = anchor.endIndex;
    previousProbability = anchor.probability;
  }
  return intervals;
}

function circadianBucketWeight(startMs: number): number {
  const sampleMs = CIRCADIAN_SAMPLE_MINUTES * 60 * 1_000;
  const sampleCount = BUCKET_MS / sampleMs;
  let total = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const sampleAt = startMs + (index + 0.5) * sampleMs;
    total += CIRCADIAN_PHASES[getTiboRoutinePhase(new Date(sampleAt), null)].bucketWeight;
  }
  return total / sampleCount;
}

function signalLevelFor(
  probability: number,
): "calm" | "slight" | "gathering" | "elevated" | "strong" {
  if (probability < 0.06) return "calm";
  if (probability < 0.12) return "slight";
  if (probability < 0.2) return "gathering";
  if (probability < 0.35) return "elevated";
  return "strong";
}

function validateTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value)))
    throw new Error(`${label} must be a valid ISO date-time`);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
