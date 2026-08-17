import { expect, type Page, test } from "@playwright/test";

/** The toggle cycles, and the starting zone depends on the runner, so click until it lands. */
async function useTimezone(page: Page, target: string): Promise<void> {
  const toggle = page.getByRole("button", { name: /切换时区|Switch timezone/ });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if ((await toggle.getAttribute("title")) === target) return;
    await toggle.click();
  }
  throw new Error(`timezone toggle never reached ${target}`);
}

test.beforeEach(async ({ page }) => {
  // The browser reports an English locale; the assertions below read the Chinese page.
  await page.addInitScript(() => window.localStorage.setItem("radar-lang", "zh"));
  await page.route("https://pbs.twimg.com/profile_images/**", async (route) => {
    await route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    });
  });
  await mockRadarApi(page);
});

test("renders a stable radar and supports the primary interactions", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Tibo Reset Radar" })).toBeVisible();
  await expect(page.getByRole("figure", { name: "未来 24 小时发生重置的概率 4%" })).toBeVisible();
  await expect(page.getByRole("figure", { name: "未来 48 小时发生重置的概率 8%" })).toBeVisible();
  await expect(page.getByRole("figure", { name: "未来 7 天发生重置的概率 28%" })).toBeVisible();
  await expect(page.getByText("演示数据", { exact: false })).toBeVisible();
  await expect(page.getByRole("img", { name: "Tibo 头像" })).toBeVisible();
  await expect(page.locator(".routine-chip")).toBeVisible();
  await expect(page.locator(".identity-line")).toContainText("上次 Reset");
  await expect(page.locator(".last-reset-bar")).toHaveCount(0);
  await expect(page.getByText("Tibo 当前状态")).toHaveCount(0);
  await expect(page.getByText(/数据正常 · 更新于/)).toBeVisible();
  await page.getByText(/当前公开状态：/).click();
  await expect(page.getByText("公开状态说明")).toBeVisible();

  const edition = await page.locator(".edition").boundingBox();
  const title = await page.getByRole("heading", { name: "Tibo Reset Radar" }).boundingBox();
  expect(edition).not.toBeNull();
  expect(title).not.toBeNull();
  expect((edition?.y ?? 0) + (edition?.height ?? 0)).toBeLessThanOrEqual(title?.y ?? 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  const dailyForecast = page.getByRole("list", { name: "未来七天区间概率" });
  await expect(dailyForecast).toBeVisible();
  await expect(dailyForecast.getByRole("listitem")).toHaveCount(7);
  await expect(page.locator(".hourly-meter, .daily-track")).toHaveCount(0);
  await page.getByRole("button", { name: /近 24 小时原始推文/ }).click();
  await expect(page.getByText("Reset timing update soon.")).toBeVisible();
});

test("presents every probability as a time range", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Tibo Reset Radar" })).toBeVisible();
  await useTimezone(page, "UTC");

  await expect(
    page.getByRole("listitem", {
      name: "第 1 天，8月3日 08:00–8月4日 08:00，区间概率 4%",
    }),
  ).toBeVisible();
  await expect(page.getByText("四个连续 6 小时时间段")).toBeVisible();

  await useTimezone(page, "America/Los_Angeles");
  await expect(
    page.getByRole("listitem", {
      name: "第 1 天，8月3日 01:00–8月4日 01:00，区间概率 4%",
    }),
  ).toBeVisible();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("fits the narrowest phone without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Tibo Reset Radar" })).toBeVisible();
  await expect(page.locator(".masthead")).toHaveCSS("border-bottom-width", "2px");
  await expect(page.locator(".verdict-hero")).toHaveCSS("border-top-width", "0px");

  // The mobile project is 390px wide and passed while production overflowed at that same width,
  // because font metrics differ between environments. 360px is the common small-Android width and
  // leaves the margin that difference needs.
  await page.setViewportSize({ width: 360, height: 740 });

  const overflowing = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    return [...document.querySelectorAll("*")]
      .filter((element) => element.getBoundingClientRect().right > viewport + 1)
      .map((element) => `${element.tagName.toLowerCase()}.${element.className}`);
  });
  expect(overflowing).toEqual([]);

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("serves an English page and remembers the choice", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.removeItem("radar-lang"));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Tibo Reset Radar" })).toBeVisible();
  // An English browser must not land on a Chinese page.
  await expect(page.getByRole("heading", { name: "Next 7 days" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.lang)).toBe("en");

  await page.getByRole("button", { name: /Switch language/ }).click();
  await expect(page.getByRole("heading", { name: "未来 7 天" })).toBeVisible();
  expect(await page.evaluate(() => window.localStorage.getItem("radar-lang"))).toBe("zh");
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
          activity: {
            status: "active",
            lastPublicActivityAt: "2026-08-03T08:00:00.000Z",
            routinePhase: "awake",
          },
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
              authorAvatarUrl:
                "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Crect width='64' height='64' fill='%231c2833'/%3E%3C/svg%3E",
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
