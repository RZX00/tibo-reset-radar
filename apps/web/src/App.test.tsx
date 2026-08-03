// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";

const forecast = {
  schemaVersion: "1.0",
  runId: "run_demo",
  generatedAt: "2026-08-03T08:00:00.000Z",
  horizonStart: "2026-08-03T08:00:00.000Z",
  horizonEnd: "2026-08-10T08:00:00.000Z",
  timezone: "UTC",
  model: { version: "heuristic-v1", validationStatus: "heuristic", calibratedAt: null },
  dataFreshness: {
    status: "fresh",
    lastObservedAt: "2026-08-03T07:59:00.000Z",
    lagSeconds: 60,
    confidence: 0.6,
  },
  activity: { status: "active", lastPublicActivityAt: "2026-08-03T07:59:00.000Z" },
  cumulative: { within24h: 0.2, within48h: 0.4, within72h: 0.5, within168h: 0.7 },
  days: Array.from({ length: 7 }, (_, day) => ({
    dayIndex: day + 1,
    startAt: new Date(Date.UTC(2026, 7, 3 + day, 8)).toISOString(),
    endAt: new Date(Date.UTC(2026, 7, 4 + day, 8)).toISOString(),
    intervalProbability: 0.1,
    cumulativeProbability: Math.min(0.7, 0.1 * (day + 1)),
    signalLevel: day === 2 ? "elevated" : "slight",
    buckets: Array.from({ length: 4 }, (_, bucket) => ({
      index: day * 4 + bucket,
      startAt: new Date(Date.UTC(2026, 7, 3 + day, 8 + bucket * 6)).toISOString(),
      endAt: new Date(Date.UTC(2026, 7, 3 + day, 14 + bucket * 6)).toISOString(),
      hazardProbability: 0.03,
      intervalProbability: 0.025,
      cumulativeProbability: 0.1,
      topReasonCodes: ["recent_activity"],
    })),
  })),
  confirmedSignal: null,
  disclaimer: "预测是启发式估计，不代表事实。",
};

afterEach(() => vi.restoreAllMocks());

describe("App", () => {
  it("renders the radar and expands recent activity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        const payload = url.includes("/status")
          ? {
              serviceVersion: "0.1.0",
              demoMode: true,
              collector: {
                status: "fresh",
                lastSuccessAt: forecast.generatedAt,
                consecutiveFailures: 0,
              },
              activity: forecast.activity,
            }
          : url.includes("/forecast")
            ? forecast
            : url.includes("/events")
              ? {
                  window: "24h",
                  items: [
                    {
                      postId: "p1",
                      authorId: "u1",
                      authorDisplayName: "Tibo",
                      authorHandle: "tibo",
                      authorAvatarUrl: null,
                      sourceKind: "reply",
                      conversationId: null,
                      referencedPostIds: [],
                      language: "en",
                      sourceUrl: "https://x.com/tibo/status/p1",
                      text: "Reset signal update",
                      contentHash: "hash",
                      createdAt: forecast.generatedAt,
                      observedAt: forecast.generatedAt,
                      editedAt: null,
                      deletedAt: null,
                    },
                  ],
                }
              : { state: "forecasting", event: null };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Tibo Reset Radar" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /最近 24 小时/ }));
    await waitFor(() => expect(screen.getByText("Reset signal update")).toBeInTheDocument());
  });
});
