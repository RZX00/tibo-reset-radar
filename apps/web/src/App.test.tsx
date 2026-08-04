// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
      topReasonCodes: ["rules_retracted"],
    })),
  })),
  confirmedSignal: null,
  disclaimer: "预测是启发式估计，不代表事实。",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "share");
  Reflect.deleteProperty(navigator, "clipboard");
});

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
    await userEvent.click(screen.getByRole("button", { name: /近 24 小时原始推文/ }));
    await waitFor(() => expect(screen.getByText("Reset signal update")).toBeInTheDocument());
  });

  it("reports successful sharing and renders mapped reason labels", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Tibo Reset Radar" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /7 天详细预测数据/ }));
    expect(screen.getAllByText("Reset 撤回语义").length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: "分享预测" }));
    expect(await screen.findByRole("status")).toHaveTextContent("分享成功");
    expect(share).toHaveBeenCalledOnce();
  });

  it("reports sharing failures to assistive technology", async () => {
    const share = vi.fn().mockRejectedValue(new Error("share unavailable"));
    Object.defineProperty(navigator, "share", { configurable: true, value: share });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Tibo Reset Radar" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "分享预测" }));
    expect(await screen.findByRole("status")).toHaveTextContent("分享失败，请稍后重试");
  });

  it("labels every probability with the interval it belongs to", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Tibo Reset Radar" })).toBeInTheDocument();
    // Pin the timezone so the expected labels do not depend on the machine running the test.
    await userEvent.selectOptions(screen.getByLabelText("时区"), "UTC");
    // The six-hour cards live behind the detail toggle since the redesign.
    await userEvent.click(screen.getByRole("button", { name: /7 天详细预测数据/ }));

    // Buckets are 6 hours: 08:00 UTC -> 14:00 UTC on the same local day.
    expect(screen.getAllByText("8月3日 08:00–14:00").length).toBeGreaterThan(0);
    // The headline window must be a range too, never a single instant.
    expect(screen.getByText(/预期时段：8月\d+日 \d{2}:\d{2}–/)).toBeInTheDocument();
    // A window that crosses midnight repeats the closing date so it cannot read backwards.
    expect(screen.getByText("8月3日 20:00–8月4日 02:00")).toBeInTheDocument();
    expect(screen.getByText(/每格是该 6 小时区间内发生的概率/)).toBeInTheDocument();

    const bar = screen.getAllByRole("progressbar")[0];
    expect(bar).toHaveAttribute("aria-label", "8月3日 08:00–14:00 区间概率");
    expect(
      screen.getByRole("button", { name: /^DAY 1 8月3日 08:00–8月4日 08:00 区间概率/ }),
    ).toBeInTheDocument();
  });

  it("formats both endpoints in the selected timezone", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Tibo Reset Radar" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /7 天详细预测数据/ }));
    await userEvent.selectOptions(screen.getByLabelText("时区"), "America/Los_Angeles");
    // 08:00Z–14:00Z is 01:00–07:00 in Los Angeles on the same local day.
    await waitFor(() =>
      expect(screen.getAllByText("8月3日 01:00–07:00").length).toBeGreaterThan(0),
    );
  });
});
