import { describe, expect, it } from "vitest";
import { TargetConfigSchema } from "./index.js";

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
});
