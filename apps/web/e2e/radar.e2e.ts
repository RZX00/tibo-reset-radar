import { expect, type Page, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await mockRadarApi(page);
});

test("renders a stable radar and supports the primary interactions", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Tibo Reset Radar" })).toBeVisible();
  // The hero answers first; the cumulative band now lives inside the detail section.
  await expect(page.getByText("7 天", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("演示数据", { exact: false })).toBeVisible();

  const edition = await page.locator(".edition").boundingBox();
  const title = await page.getByRole("heading", { name: "Tibo Reset Radar" }).boundingBox();
  expect(edition).not.toBeNull();
  expect(title).not.toBeNull();
  expect((edition?.y ?? 0) + (edition?.height ?? 0)).toBeLessThanOrEqual(title?.y ?? 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  await page.getByRole("button", { name: /7 天详细预测数据/ }).click();
  await expect(page.getByLabel("累计概率")).toContainText("168 小时");
  await page.getByRole("button", { name: /DAY 4/ }).click();
  await expect(page.getByText("DAY 4 · 6H WINDOWS")).toBeVisible();
  await page.getByRole("button", { name: /近 24 小时原始推文/ }).click();
  await expect(page.getByText("Reset timing update soon.")).toBeVisible();

  if (test.info().project.name === "mobile-chromium") {
    expect(
      await page
        .locator(".forecast-strip")
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    ).toBe(true);
  }
});

test("presents every probability as a time range", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Tibo Reset Radar" })).toBeVisible();
  await page.getByLabel("时区").selectOption("UTC");

  // A percentage belongs to an interval; a bare start time reads as a predicted reset moment.
  await expect(page.getByText("预期时段", { exact: false })).toContainText(/\d{2}:\d{2}–/);
  // The six-hour cards live behind the detail toggle.
  await page.getByRole("button", { name: /7 天详细预测数据/ }).click();
  await expect(page.getByText("8月3日 08:00–14:00").first()).toBeVisible();
  // Crossing midnight has to stay readable in both directions.
  await expect(page.getByText("8月3日 20:00–8月4日 02:00")).toBeVisible();
  await expect(page.getByText(/每格是该 6 小时区间内发生的概率/)).toBeVisible();
  await expect(page.getByRole("progressbar").first()).toHaveAttribute(
    "aria-label",
    "8月3日 08:00–14:00 区间概率",
  );

  await page.getByLabel("时区").selectOption("America/Los_Angeles");
  await expect(page.getByText("8月3日 01:00–07:00").first()).toBeVisible();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("shows confirmed and public error states", async ({ page }) => {
  await page.route("**/api/reset-status", async (route) => {
    await route.fulfill({
      json: {
        state: "confirmed_reset",
        event: {
          eventId: "reset-confirmed",
          status: "confirmed_reset",
          occurredAt: "2026-08-03T08:00:00.000Z",
          scope: "all",
          evidencePostIds: ["p1"],
          supersedesEventId: null,
        },
      },
    });
  });
  await page.goto("/");
  await expect(page.getByText("Reset 已确认", { exact: true })).toBeVisible();

  await page.route("**/api/forecast?**", async (route) => {
    await route.fulfill({
      status: 500,
      json: { error: { code: "INTERNAL_ERROR", message: "暂时无法生成预测" } },
    });
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "雷达暂时离线" })).toBeVisible();
  await expect(page.getByText("暂时无法生成预测")).toBeVisible();
});

async function mockRadarApi(page: Page): Promise<void> {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/status") {
      await route.fulfill({
        json: {
          serviceVersion: "e2e",
          demoMode: true,
          collector: {
            status: "fresh",
            lastSuccessAt: "2026-08-03T08:00:00.000Z",
            consecutiveFailures: 0,
          },
          activity: { status: "active", lastPublicActivityAt: "2026-08-03T08:00:00.000Z" },
        },
      });
      return;
    }
    if (pathname === "/api/events") {
      await route.fulfill({
        json: {
          window: "24h",
          items: [
            {
              postId: "p1",
              authorId: "demo-tibo",
              authorDisplayName: "Tibo",
              authorHandle: "tibo_demo",
              authorAvatarUrl: null,
              sourceKind: "reply",
              conversationId: "p1",
              referencedPostIds: [],
              language: "en",
              sourceUrl: "https://x.com/tibo_demo/status/p1",
              text: "Reset timing update soon.",
              contentHash: "hash",
              createdAt: "2026-08-03T08:00:00.000Z",
              observedAt: "2026-08-03T08:00:00.000Z",
              editedAt: null,
              deletedAt: null,
            },
          ],
        },
      });
      return;
    }
    if (pathname === "/api/reset-status") {
      await route.fulfill({ json: { state: "forecasting", event: null } });
      return;
    }
    if (pathname === "/api/forecast") {
      await route.fulfill({ json: forecastFixture() });
      return;
    }
    await route.fallback();
  });
}

function forecastFixture() {
  const generatedAt = Date.parse("2026-08-03T08:00:00.000Z");
  const buckets = Array.from({ length: 28 }, (_, index) => ({
    index,
    startAt: new Date(generatedAt + index * 21_600_000).toISOString(),
    endAt: new Date(generatedAt + (index + 1) * 21_600_000).toISOString(),
    hazardProbability: 0.01,
    intervalProbability: 0.01,
    cumulativeProbability: (index + 1) * 0.01,
    topReasonCodes: ["active_activity", "rules_future"],
  }));
  return {
    schemaVersion: "1.0",
    runId: "e2e-run",
    generatedAt: new Date(generatedAt).toISOString(),
    horizonStart: new Date(generatedAt).toISOString(),
    horizonEnd: new Date(generatedAt + 604_800_000).toISOString(),
    timezone: "UTC",
    model: { version: "heuristic-v1", validationStatus: "heuristic", calibratedAt: null },
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
      startAt: buckets[index * 4]?.startAt,
      endAt: buckets[index * 4 + 3]?.endAt,
      intervalProbability: 0.04,
      cumulativeProbability: (index + 1) * 0.04,
      signalLevel: index === 0 ? "slight" : "calm",
      buckets: buckets.slice(index * 4, index * 4 + 4),
    })),
    confirmedSignal: null,
    disclaimer: "启发式预测不代表 Reset 已确认；模型概率最高为 99%。",
  };
}
