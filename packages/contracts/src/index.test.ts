import { describe, expect, it } from "vitest";
import { getTiboRoutinePhase, ResetEventSchema, TargetConfigSchema } from "./index.js";

describe("TargetConfigSchema", () => {
  it("accepts the checked-in demo target shape", () => {
    expect(
      TargetConfigSchema.parse({
        schemaVersion: "1.0",
        mode: "demo",
        target: { userId: "demo-tibo", handle: "tibo_demo", displayName: "Tibo" },
        authoritativeUserIds: ["demo-tibo"],
        resetDefinition: "A public Reset event.",
        bankedResetPolicy: "forecast_only",
      }).mode,
    ).toBe("demo");
  });

  it("rejects handles that cannot be used by X rules", () => {
    expect(() =>
      TargetConfigSchema.parse({
        schemaVersion: "1.0",
        mode: "live",
        target: { userId: "1", handle: "not-a-handle", displayName: "Tibo" },
        authoritativeUserIds: ["1"],
        resetDefinition: "Reset",
        bankedResetPolicy: "confirm",
      }),
    ).toThrow();
  });

  it("defaults event correction links for legacy snapshots", () => {
    expect(
      ResetEventSchema.parse({
        eventId: "reset-1",
        status: "confirmed_reset",
        occurredAt: "2026-08-03T00:00:00.000Z",
        scope: "all",
        evidencePostIds: ["post-1"],
      }).supersedesEventId,
    ).toBeNull();
  });
});

describe("getTiboRoutinePhase", () => {
  it("uses the agreed San Francisco schedule", () => {
    expect(getTiboRoutinePhase(new Date("2026-08-05T08:00:00.000Z"), null)).toBe("sleeping");
    expect(getTiboRoutinePhase(new Date("2026-08-05T16:30:00.000Z"), null)).toBe("awake");
    expect(getTiboRoutinePhase(new Date("2026-08-06T05:15:00.000Z"), null)).toBe("social");
    expect(getTiboRoutinePhase(new Date("2026-08-06T06:45:00.000Z"), null)).toBe("winding_down");
  });

  it("lets recent public activity override the sleep schedule", () => {
    expect(
      getTiboRoutinePhase(new Date("2026-08-05T08:00:00.000Z"), "2026-08-05T07:50:00.000Z"),
    ).toBe("awake");
  });
});
