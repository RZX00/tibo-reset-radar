import { TargetConfigSchema } from "@tibo-radar/contracts";
import { describe, expect, it } from "vitest";

import { createDemoFixtures } from "./demo-fixtures.js";
import { DEFAULT_POLL_INTERVAL_MS, pollIntervalMs } from "./main.js";
import { DeterministicOnlySignalAdapter, errorCode } from "./worker.js";

describe("worker support", () => {
  it("builds valid, non-secret demo fixtures for the configured target", () => {
    const config = TargetConfigSchema.parse({
      schemaVersion: "1.0",
      mode: "demo",
      target: { userId: "demo", handle: "tibo_demo", displayName: "Tibo" },
      authoritativeUserIds: ["demo"],
      resetDefinition: "A usage reset",
      bankedResetPolicy: "forecast_only",
    });
    const fixtures = createDemoFixtures(config, new Date("2026-08-03T12:00:00.000Z"));
    expect(fixtures).toHaveLength(3);
    expect(fixtures.every((post) => post.authorId === "demo")).toBe(true);
    expect(fixtures.map((post) => post.postId)).toEqual(["1001", "1002", "1003"]);
  });

  it("forces signal extraction through the documented deterministic fallback", async () => {
    await expect(new DeterministicOnlySignalAdapter().extract()).rejects.toThrow(
      "deterministic rule fallback",
    );
  });

  it("reports stable failure codes without leaking error messages", () => {
    expect(errorCode(new TypeError("secret token value"))).toBe("type_error");
    expect(errorCode("bad")).toBe("unknown_error");
  });

  it("defaults collector polling to 120 seconds", () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(120_000);
    expect(pollIntervalMs({})).toBe(120_000);
    expect(pollIntervalMs({ POLL_INTERVAL_MS: "60000" })).toBe(60_000);
  });
});
