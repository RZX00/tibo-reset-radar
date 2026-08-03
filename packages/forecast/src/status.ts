import type { ActivityStatus, ForecastSnapshot, FreshnessStatus } from "@tibo-radar/contracts";

const MINUTE_MS = 60_000;

export interface FreshnessThresholds {
  freshSeconds: number;
  delayedSeconds: number;
}

export function deriveActivityStatus(
  referenceTime: string,
  lastPublicActivityAt: string | null,
  consecutiveCollectorFailures: number,
): ForecastSnapshot["activity"] {
  if (consecutiveCollectorFailures >= 2) {
    return { status: "data_delayed", lastPublicActivityAt };
  }
  if (lastPublicActivityAt === null) {
    return { status: "quiet", lastPublicActivityAt: null };
  }

  const ageMs = ageInMilliseconds(referenceTime, lastPublicActivityAt);
  let status: ActivityStatus;
  if (ageMs <= 30 * MINUTE_MS) status = "active";
  else if (ageMs <= 3 * 60 * MINUTE_MS) status = "cooling";
  else status = "quiet";
  return { status, lastPublicActivityAt };
}

export function deriveFreshness(
  referenceTime: string,
  lastObservedAt: string | null,
  thresholds: FreshnessThresholds = { freshSeconds: 600, delayedSeconds: 1_800 },
): ForecastSnapshot["dataFreshness"] {
  if (thresholds.freshSeconds < 0 || thresholds.delayedSeconds <= thresholds.freshSeconds) {
    throw new Error("Freshness thresholds must be ordered non-negative seconds");
  }
  if (lastObservedAt === null) {
    return { status: "stale", lastObservedAt: null, lagSeconds: null, confidence: 0.15 };
  }

  const lagSeconds = ageInMilliseconds(referenceTime, lastObservedAt) / 1_000;
  let status: FreshnessStatus;
  let confidence: number;
  if (lagSeconds <= thresholds.freshSeconds) {
    status = "fresh";
    confidence = 1;
  } else if (lagSeconds <= thresholds.delayedSeconds) {
    status = "delayed";
    confidence = 0.7;
  } else {
    status = "stale";
    confidence = 0.35;
  }
  return { status, lastObservedAt, lagSeconds, confidence };
}

function ageInMilliseconds(referenceTime: string, earlierTime: string): number {
  const reference = Date.parse(referenceTime);
  const earlier = Date.parse(earlierTime);
  if (!Number.isFinite(reference) || !Number.isFinite(earlier)) {
    throw new Error("Activity and freshness timestamps must be valid ISO date-times");
  }
  return Math.max(0, reference - earlier);
}
