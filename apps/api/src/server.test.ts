import type {
  ForecastSnapshot,
  RadarStatus,
  ResetEvent,
  SourcePostObserved,
} from "@tibo-radar/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { buildServer } from "./server.js";
import type { RadarReadStore } from "./store.js";

const servers: ReturnType<typeof buildServer>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("radar read API", () => {
  it("returns forecast with requested timezone and supports ETag revalidation", async () => {
    const app = buildServer({ store: new MemoryStore(makeForecast()) });
    servers.push(app);
    const first = await app.inject({
      method: "GET",
      url: "/api/forecast?timezone=Asia%2FShanghai",
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().timezone).toBe("Asia/Shanghai");
    expect(first.headers.etag).toBeTypeOf("string");

    const second = await app.inject({
      method: "GET",
      url: "/api/forecast?timezone=Asia%2FShanghai",
      headers: { "if-none-match": first.headers.etag ?? "" },
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe("");
  });

  it("rejects an invalid IANA timezone", async () => {
    const app = buildServer({ store: new MemoryStore(makeForecast()) });
    servers.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/forecast?timezone=Mars%2FOlympus",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_TIMEZONE");
  });

  it("returns an explicit empty state when no forecast exists", async () => {
    const app = buildServer({ store: new MemoryStore(null) });
    servers.push(app);
    const response = await app.inject({ method: "GET", url: "/api/forecast" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NO_FORECAST");
  });

  it("serves a real dynamic PNG and validates event windows", async () => {
    const app = buildServer({ store: new MemoryStore(makeForecast()) });
    servers.push(app);
    const image = await app.inject({ method: "GET", url: "/api/share-card.png" });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.rawPayload.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    const invalid = await app.inject({ method: "GET", url: "/api/events?window=999h" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("INVALID_WINDOW");
  });

  it("returns stable event and reset-status response contracts", async () => {
    const resetEvent: ResetEvent = {
      eventId: "reset-1",
      status: "candidate_confirmation",
      occurredAt: null,
      scope: "all",
      evidencePostIds: ["post-1"],
      supersedesEventId: null,
    };
    const app = buildServer({ store: new MemoryStore(makeForecast(), resetEvent) });
    servers.push(app);

    const events = await app.inject({ method: "GET", url: "/api/events?window=24h" });
    expect(events.json()).toEqual({ window: "24h", items: [] });
    const reset = await app.inject({ method: "GET", url: "/api/reset-status" });
    expect(reset.json()).toEqual({ state: "candidate_confirmation", event: resetEvent });
  });

  it("returns generic public errors without leaking internal details", async () => {
    const store = new MemoryStore(makeForecast());
    store.getStatus = async () => {
      throw new Error("database password should never be public");
    };
    const app = buildServer({ store });
    servers.push(app);

    const failed = await app.inject({ method: "GET", url: "/api/status" });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "The radar service could not complete the request",
      },
    });
    expect(failed.body).not.toContain("password");

    const missing = await app.inject({ method: "GET", url: "/api/unknown" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("NOT_FOUND");
  });
});

class MemoryStore implements RadarReadStore {
  constructor(
    private readonly forecast: ForecastSnapshot | null,
    private readonly resetEvent: ResetEvent | null = null,
  ) {}
  async getStatus(): Promise<RadarStatus> {
    return {
      serviceVersion: "test",
      demoMode: true,
      collector: {
        status: "fresh",
        lastSuccessAt: "2026-08-03T00:00:00.000Z",
        consecutiveFailures: 0,
      },
      activity: { status: "active", lastPublicActivityAt: "2026-08-03T00:00:00.000Z" },
    };
  }
  async getLatestForecast() {
    return this.forecast;
  }
  async getEvents(_hours: number): Promise<SourcePostObserved[]> {
    return [];
  }
  async getLatestResetEvent(): Promise<ResetEvent | null> {
    return this.resetEvent;
  }
}

function makeForecast(): ForecastSnapshot {
  const generatedAt = Date.parse("2026-08-03T00:00:00.000Z");
  let cumulative = 0;
  const buckets = Array.from({ length: 28 }, (_, index) => {
    cumulative += 0.01;
    return {
      index,
      startAt: new Date(generatedAt + index * 21_600_000).toISOString(),
      endAt: new Date(generatedAt + (index + 1) * 21_600_000).toISOString(),
      hazardProbability: 0.01 / (1 - (cumulative - 0.01)),
      intervalProbability: 0.01,
      cumulativeProbability: cumulative,
      topReasonCodes: ["test_signal"],
    };
  });
  return {
    schemaVersion: "1.0",
    runId: "run-test",
    generatedAt: new Date(generatedAt).toISOString(),
    horizonStart: new Date(generatedAt).toISOString(),
    horizonEnd: new Date(generatedAt + 168 * 3_600_000).toISOString(),
    timezone: "UTC",
    model: { version: "test-v1", validationStatus: "heuristic", calibratedAt: null },
    dataFreshness: {
      status: "fresh",
      lastObservedAt: new Date(generatedAt).toISOString(),
      lagSeconds: 0,
      confidence: 1,
    },
    activity: { status: "active", lastPublicActivityAt: new Date(generatedAt).toISOString() },
    cumulative: { within24h: 0.04, within48h: 0.08, within72h: 0.12, within168h: 0.28 },
    days: Array.from({ length: 7 }, (_, index) => ({
      dayIndex: index + 1,
      startAt: buckets[index * 4]?.startAt ?? "",
      endAt: buckets[index * 4 + 3]?.endAt ?? "",
      intervalProbability: 0.04,
      cumulativeProbability: (index + 1) * 0.04,
      signalLevel: "calm" as const,
      buckets: buckets.slice(index * 4, index * 4 + 4),
    })),
    confirmedSignal: null,
    disclaimer: "Test heuristic",
  };
}
