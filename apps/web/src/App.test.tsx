// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, getActivityPresentation, getRoutinePresentation } from "./App.js";
import { dictionaries } from "./i18n.js";

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

beforeEach(() => {
  // jsdom reports an English browser, so pin the language the way the timezone is pinned.
  window.localStorage.setItem("radar-lang", "zh");
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  Reflect.deleteProperty(navigator, "share");
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("App", () => {
  it("maps the agreed San Francisco routine and lets recent activity override sleep", () => {
    expect(getRoutinePresentation(new Date("2026-08-05T08:00:00.000Z"), null)).toMatchObject({
      phase: "sleeping",
      label: "大概率睡觉",
      localTime: "01:00",
    });
    expect(getRoutinePresentation(new Date("2026-08-06T05:15:00.000Z"), null)).toMatchObject({
      phase: "social",
      label: "通常在刷推",
      localTime: "22:15",
    });
    expect(getRoutinePresentation(new Date("2026-08-05T16:30:00.000Z"), null)).toMatchObject({
      phase: "awake",
      label: "大概率醒着",
      localTime: "09:30",
    });
    expect(getRoutinePresentation(new Date("2026-08-06T06:45:00.000Z"), null)).toMatchObject({
      phase: "winding_down",
      label: "可能准备休息",
      localTime: "23:45",
    });
    expect(
      getRoutinePresentation(new Date("2026-08-05T08:00:00.000Z"), "2026-08-05T07:50:00.000Z"),
    ).toMatchObject({ phase: "awake", label: "醒着 · 刚刚有公开活动" });
  });

  it("labels a quiet low-activity window as a sleep inference, not a fact", () => {
    expect(
      getActivityPresentation({
        status: "quiet",
        likelySleeping: true,
        sleepWindowUtc: { sampleSize: 20 },
      }),
    ).toEqual({
      label: "可能在睡觉",
      note: "按近 30 天 20 条公开动态推测，当前处于低活跃时段",
    });
  });

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
                      authorAvatarUrl: "https://example.com/tibo.jpg",
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

  it("shows the identity and three headline probabilities, then reports successful sharing", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: share });

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Tibo Reset Radar" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Tibo 头像" })).toHaveAttribute(
      "src",
      expect.stringContaining("pj1vyX6I_400x400.jpg"),
    );
    expect(
      screen.getByText("上次 Reset", { exact: true }).closest(".last-reset-inline"),
    ).toHaveTextContent("上次 Reset");
    expect(document.querySelector(".last-reset-bar")).not.toBeInTheDocument();
    expect(
      screen.getByRole("figure", { name: "未来 24 小时发生重置的概率 20%" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("figure", { name: "未来 48 小时发生重置的概率 40%" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("figure", { name: "未来 7 天发生重置的概率 70%" })).toBeInTheDocument();
    expect(screen.queryByText("Tibo 当前状态")).not.toBeInTheDocument();
    expect(screen.getByText(/数据正常 · 更新于/)).toHaveTextContent("数据来自公开动态");

    await userEvent.click(screen.getByText(/当前公开状态：/));
    expect(screen.getByText("30 分钟内有公开活动")).toBeInTheDocument();
    expect(screen.getByText("公开活动正在减少")).toBeInTheDocument();
    expect(screen.getByText("近期没有新公开动态")).toBeInTheDocument();
    expect(screen.getByText("采集暂时无法确认")).toBeInTheDocument();

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
    expect(
      screen.getByRole("listitem", {
        name: "第 1 天，8月3日 08:00–8月4日 08:00，区间概率 10%",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "未来七天区间概率" }).children).toHaveLength(7);
    expect(document.querySelector(".hourly-meter")).not.toBeInTheDocument();
    expect(document.querySelector(".daily-track")).not.toBeInTheDocument();
    expect(screen.queryByText(/^累计 /)).not.toBeInTheDocument();
    expect(screen.getByText("四个连续 6 小时时间段")).toBeInTheDocument();
  });

  it("formats both endpoints in the selected timezone", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Tibo Reset Radar" })).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("时区"), "America/Los_Angeles");
    await waitFor(() =>
      expect(
        screen.getByRole("listitem", {
          name: "第 1 天，8月3日 01:00–8月4日 01:00，区间概率 10%",
        }),
      ).toBeInTheDocument(),
    );
  });

  it("renders English for an English browser and switches back on demand", async () => {
    window.localStorage.removeItem("radar-lang");
    render(<App />);

    // No stored choice: an English browser gets the English page, numbers unchanged.
    expect(await screen.findByRole("heading", { name: "Tibo Reset Radar" })).toBeInTheDocument();
    expect(screen.getAllByText(dictionaries.en.headline.within24h).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("heading", { name: dictionaries.en.weather.heading }),
    ).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");

    await userEvent.selectOptions(screen.getByLabelText(dictionaries.en.langLabel), "zh");
    await waitFor(() =>
      expect(screen.getAllByText(dictionaries.zh.headline.within24h).length).toBeGreaterThan(0),
    );
    expect(document.documentElement.lang).toBe("zh-CN");
    // The choice survives a reload.
    expect(window.localStorage.getItem("radar-lang")).toBe("zh");
  });

  it("puts the ewo logo in the footer, pointing at the API site", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Tibo Reset Radar" })).toBeInTheDocument();

    const brand = screen.getByRole("link", { name: dictionaries.zh.footer.brandLink });
    expect(brand).toHaveAttribute("href", "https://api.ewo.so");
    expect(brand.querySelector("img")).toHaveAttribute("src", "/brand/ewo-api-lockup.svg");
    expect(brand.querySelector("img")).toHaveAttribute("alt", "ewo API");
    // The credit is one sentence around the logo, not a bare mark.
    expect(brand.parentElement).toHaveTextContent("本项目由");
    expect(brand.parentElement).toHaveTextContent("提供支持");
  });
});
