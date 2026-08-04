import { describe, expect, it } from "vitest";

import { OpenAIStatusSource } from "./external-events.js";

const OBSERVED_AT = "2026-08-03T00:00:00.000Z";

describe("OpenAIStatusSource", () => {
  it("maps relevant official incidents and uses the local observation as knownAt", async () => {
    const source = new OpenAIStatusSource({
      fetchImpl: async () =>
        Response.json({
          incidents: [
            {
              id: "incident-1",
              name: "Codex requests are returning rate limit errors",
              status: "resolved",
              impact: "major",
              created_at: "2026-08-02T20:00:00Z",
              updated_at: "2026-08-02T22:00:00Z",
              resolved_at: "2026-08-02T22:00:00Z",
              incident_updates: [{ body: "Codex capacity has recovered." }],
            },
            {
              id: "incident-2",
              name: "Unrelated internal maintenance",
              status: "resolved",
              impact: "minor",
              created_at: "2026-08-02T18:00:00Z",
              updated_at: "2026-08-02T19:00:00Z",
              resolved_at: "2026-08-02T19:00:00Z",
              incident_updates: [],
            },
          ],
        }),
    });

    const events = await source.collect({ observedAt: OBSERVED_AT });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventId: "openai-status:incident-1",
      sourceType: "official_status",
      provider: "OpenAI",
      eventType: "codex_incident",
      occurredAt: "2026-08-02T20:00:00.000Z",
      knownAt: OBSERVED_AT,
      endedAt: "2026-08-02T22:00:00.000Z",
      relevance: 1,
      severity: 0.75,
    });
  });

  it("surfaces a stable error type for non-success responses", async () => {
    const source = new OpenAIStatusSource({
      fetchImpl: async () => new Response(null, { status: 503 }),
    });

    await expect(source.collect({ observedAt: OBSERVED_AT })).rejects.toMatchObject({
      name: "OpenAIStatusHttpError",
    });
  });
});
