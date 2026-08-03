import {
  type ForecastSnapshot,
  ForecastSnapshotSchema,
  type ResetEvent,
  type SignalExtraction,
} from "@tibo-radar/contracts";

const BUCKET_COUNT = 28;
const BUCKET_HOURS = 6;
const BUCKET_MS = BUCKET_HOURS * 60 * 60 * 1_000;
const MAX_FORECAST_PROBABILITY = 0.99;

const WEATHER_CODE_THRESHOLDS = [
  { upperExclusive: 0.2, code: "clear" },
  { upperExclusive: 0.4, code: "partly_cloudy" },
  { upperExclusive: 0.6, code: "cloudy" },
  { upperExclusive: 0.8, code: "storm_watch" },
] as const;

export interface PersistedForecastSignal {
  postId: string;
  observedAt: string;
  extraction: SignalExtraction;
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
  signals: readonly PersistedForecastSignal[];
  confirmedSignal?: ResetEvent | null;
  previousSnapshot?: ForecastSnapshot | null;
}

interface WeightedSignal {
  signal: PersistedForecastSignal;
  contribution: number;
  timingIndex: number | null;
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
  const weightedSignals = input.signals.map((signal) => weightSignal(signal, generatedMs));
  const totalProbability = computeTotalProbability(input.activity.status, weightedSignals);
  const riskWeights = buildRiskWeights(weightedSignals, generatedMs);
  const weightTotal = riskWeights.reduce((sum, weight) => sum + weight, 0);
  const intervalProbabilities = distributeProbability(totalProbability, riskWeights, weightTotal);

  let cumulative = 0;
  const buckets = intervalProbabilities.map((intervalProbability, index) => {
    const previousCumulative = cumulative;
    cumulative += intervalProbability;
    if (index === BUCKET_COUNT - 1) cumulative = totalProbability;
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
      topReasonCodes: reasonsForBucket(index, input.activity.status, weightedSignals),
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
      weatherCode: weatherCodeFor(intervalProbability),
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
    disclaimer: "启发式预测不代表 Reset 已确认；模型概率最高为 99%。",
  });
}

function weightSignal(signal: PersistedForecastSignal, generatedMs: number): WeightedSignal {
  const observedMs = Date.parse(signal.observedAt);
  if (!Number.isFinite(observedMs))
    throw new Error(`Signal ${signal.postId} has an invalid observedAt`);
  const ageHours = Math.max(0, (generatedMs - observedMs) / (60 * 60 * 1_000));
  const recency = Math.exp(-ageHours / 72);
  const extraction = signal.extraction;
  const stateWeight: Record<SignalExtraction["explicitResetState"], number> = {
    none: 0,
    future: 0.85,
    rolling_out_now: 1.35,
    completed: 1.2,
    limited: 0.45,
    retracted: -1.1,
    ambiguous: 0.1,
  };
  const commitmentWeight =
    extraction.futureCommitment === "explicit"
      ? 0.55
      : extraction.futureCommitment === "weak"
        ? 0.2
        : 0;
  const raw =
    stateWeight[extraction.explicitResetState] +
    commitmentWeight +
    extraction.incidentSignal * 0.55 +
    extraction.milestoneSignal * 0.4;
  const contribution = raw * extraction.resetRelevance * extraction.confidence * recency;
  const hintedAt = extraction.timeHint.startAt
    ? Date.parse(extraction.timeHint.startAt)
    : Number.NaN;
  const timingIndex = Number.isFinite(hintedAt)
    ? Math.max(0, Math.min(BUCKET_COUNT - 1, Math.floor((hintedAt - generatedMs) / BUCKET_MS)))
    : null;
  return { signal, contribution, timingIndex };
}

function computeTotalProbability(
  activityStatus: ForecastSnapshot["activity"]["status"],
  signals: readonly WeightedSignal[],
): number {
  const activityContribution =
    activityStatus === "active"
      ? 0.42
      : activityStatus === "cooling"
        ? 0.2
        : activityStatus === "quiet"
          ? -0.08
          : 0;
  const signalContribution = signals.reduce((sum, item) => sum + item.contribution, 0);
  const logOdds = -2.15 + activityContribution + signalContribution;
  return Math.min(MAX_FORECAST_PROBABILITY, Math.max(0, 1 / (1 + Math.exp(-logOdds))));
}

function buildRiskWeights(signals: readonly WeightedSignal[], generatedMs: number): number[] {
  return Array.from({ length: BUCKET_COUNT }, (_, index) => {
    // A broad baseline keeps every interval possible while gently favoring nearer windows.
    let weight = 0.8 + 0.7 * Math.exp(-index / 18);
    for (const item of signals) {
      if (item.contribution === 0) continue;
      const center = item.timingIndex ?? inferredCenter(item.signal.extraction, generatedMs, index);
      const distance = Math.abs(index - center);
      const timingWeight = Math.exp(-(distance * distance) / 12);
      weight += Math.max(-0.65, item.contribution) * timingWeight;
    }
    return Math.max(0.05, weight);
  });
}

function inferredCenter(
  extraction: SignalExtraction,
  _generatedMs: number,
  currentIndex: number,
): number {
  if (
    extraction.explicitResetState === "rolling_out_now" ||
    extraction.explicitResetState === "completed"
  )
    return 0;
  if (extraction.futureCommitment === "explicit") return 6;
  if (extraction.incidentSignal >= 0.7) return 3;
  if (extraction.milestoneSignal >= 0.7) return 8;
  return currentIndex;
}

function distributeProbability(
  total: number,
  weights: readonly number[],
  weightTotal: number,
): number[] {
  let distributed = 0;
  return weights.map((weight, index) => {
    if (index === weights.length - 1) return Math.max(0, total - distributed);
    const value = (total * weight) / weightTotal;
    distributed += value;
    return value;
  });
}

function reasonsForBucket(
  index: number,
  activityStatus: ForecastSnapshot["activity"]["status"],
  signals: readonly WeightedSignal[],
): string[] {
  const reasons = signals
    .filter((item) => item.contribution !== 0)
    .map((item) => ({
      reason: item.signal.extraction.reasonCode,
      strength:
        Math.abs(item.contribution) *
        (item.timingIndex === null ? 1 : Math.exp(-Math.abs(index - item.timingIndex) / 3)),
    }))
    .sort((a, b) => b.strength - a.strength || a.reason.localeCompare(b.reason));
  return Array.from(
    new Set([`${activityStatus}_activity`, ...reasons.map((item) => item.reason)]),
  ).slice(0, 4);
}

export function weatherCodeFor(
  probability: number,
): "clear" | "partly_cloudy" | "cloudy" | "storm_watch" | "storm_warning" {
  return (
    WEATHER_CODE_THRESHOLDS.find(({ upperExclusive }) => probability < upperExclusive)?.code ??
    "storm_warning"
  );
}

function validateTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value)))
    throw new Error(`${label} must be a valid ISO date-time`);
}
