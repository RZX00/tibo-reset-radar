import { describe, expect, it } from "vitest";

import { CONFIRMED_RESET_DISPLAY_WINDOW_HOURS, currentResetState } from "./server.js";

const NOW = new Date("2026-08-03T12:00:00.000Z");

describe("current reset state", () => {
  it("reports a confirmation only while it is still current", () => {
    const justHappened = { status: "confirmed_reset", occurredAt: "2026-08-03T09:00:00.000Z" };
    expect(currentResetState(justHappened, NOW)).toBe("confirmed_reset");
  });

  it("returns to forecasting once the confirmation is history", () => {
    // The event two days ago really happened; the page must not keep announcing it as now.
    const twoDaysAgo = { status: "confirmed_reset", occurredAt: "2026-08-01T03:32:37.000Z" };
    expect(currentResetState(twoDaysAgo, NOW)).toBe("forecasting");
  });

  it("treats the window edge as still current", () => {
    const edge = new Date(
      NOW.getTime() - CONFIRMED_RESET_DISPLAY_WINDOW_HOURS * 60 * 60 * 1_000,
    ).toISOString();
    expect(currentResetState({ status: "confirmed_reset", occurredAt: edge }, NOW)).toBe(
      "confirmed_reset",
    );
  });

  it("keeps non-confirmation states untouched", () => {
    expect(currentResetState({ status: "retracted", occurredAt: null }, NOW)).toBe("retracted");
    expect(currentResetState({ status: "candidate_confirmation", occurredAt: null }, NOW)).toBe(
      "candidate_confirmation",
    );
    expect(currentResetState(null, NOW)).toBe("forecasting");
  });
});
