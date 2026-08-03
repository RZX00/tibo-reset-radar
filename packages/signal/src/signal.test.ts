import {
  SignalExtractionSchema,
  type SourcePostObserved,
  SourcePostObservedSchema,
} from "@tibo-radar/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  evaluateConfirmation,
  extractSignal,
  extractSignalWithRules,
  OpenAICompatibleSignalAdapter,
  type SignalModelAdapter,
} from "./index.js";

const REFERENCE_TIME = "2026-08-03T00:00:00.000Z";

describe("extractSignal", () => {
  it("retries once when the model returns an out-of-range evidence span", async () => {
    const post = makePost("The reset is complete.");
    const valid = makeExtraction({
      explicitResetState: "completed",
      evidenceSpans: [{ start: 4, end: 9, label: "reset_reference" }],
    });
    const adapter = sequenceAdapter([
      { ...valid, evidenceSpans: [{ start: 4, end: 999, label: "bad" }] },
      valid,
    ]);

    const result = await extractSignal(
      { post, resetDefinition: "A public Reset event", referenceTime: REFERENCE_TIME },
      adapter,
    );

    expect(result.provenance.method).toBe("llm");
    expect(result.provenance.attempts).toBe(2);
    expect(result.provenance.errors).toHaveLength(1);
    expect(result.extraction.explicitResetState).toBe("completed");
  });

  it("uses deterministic rules after exactly two failed model attempts", async () => {
    const post = makePost("We will reset in 12 hours for all users.");
    const adapter: SignalModelAdapter = {
      model: "test-model",
      extract: vi.fn().mockRejectedValue(new Error("provider unavailable")),
    };

    const result = await extractSignal(
      { post, resetDefinition: "A public Reset event", referenceTime: REFERENCE_TIME },
      adapter,
    );

    expect(adapter.extract).toHaveBeenCalledTimes(2);
    expect(result.provenance.method).toBe("deterministic_rules");
    expect(result.provenance.errors).toEqual(["provider unavailable", "provider unavailable"]);
    expect(result.extraction).toMatchObject({
      explicitResetState: "future",
      futureCommitment: "explicit",
      scope: "all",
      timeHint: { kind: "relative", startAt: "2026-08-03T12:00:00.000Z" },
    });
  });

  it("sends a strict schema request to an OpenAI-compatible endpoint", async () => {
    const extraction = makeExtraction({ evidenceSpans: [] });
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify(extraction) } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const adapter = new OpenAICompatibleSignalAdapter({
      baseUrl: "https://llm.example/v1/",
      apiKey: "secret-value",
      model: "model-a",
      fetch,
    });

    await adapter.extract({
      post: makePost("Routine update."),
      resetDefinition: "A public Reset event",
      referenceTime: REFERENCE_TIME,
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://llm.example/v1/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: "model-a",
      temperature: 0,
      response_format: { type: "json_schema", json_schema: { strict: true } },
    });
    expect(JSON.stringify(body)).not.toContain("secret-value");
  });
});

describe("deterministic signal rules", () => {
  it.each([
    ["Reset is rolling out now.", "rolling_out_now"],
    ["The reset is complete.", "completed"],
    ["Reset has been cancelled.", "retracted"],
    ["A partial reset for the pilot cohort.", "limited"],
    ["We will reset tomorrow.", "future"],
    ["Someone said the reset is complete, just a rumour.", "ambiguous"],
  ] as const)("classifies %s", (text, expected) => {
    expect(extractSignalWithRules(text, REFERENCE_TIME).explicitResetState).toBe(expected);
  });

  it("does not turn a negated statement into confirmation evidence", () => {
    const result = extractSignalWithRules("We are not going to reset.", REFERENCE_TIME);
    expect(result.explicitResetState).toBe("ambiguous");
    expect(result.confidence).toBeLessThanOrEqual(0.5);
  });
});

describe("confirmation engine", () => {
  it("confirms only an authoritative first-party completed statement", () => {
    const post = makePost("The reset is complete.");
    const extraction = extractSignalWithRules(post.text, REFERENCE_TIME);
    const decision = evaluateConfirmation({
      post,
      extraction,
      authoritativeUserIds: [post.authorId],
      bankedResetPolicy: "confirm",
    });

    expect(decision.state).toBe("confirmed_reset");
    expect(decision.event).toMatchObject({
      status: "confirmed_reset",
      evidencePostIds: [post.postId],
    });
  });

  it("does not let a non-authoritative source confirm", () => {
    const post = makePost("The reset is complete.");
    const decision = evaluateConfirmation({
      post,
      extraction: extractSignalWithRules(post.text, REFERENCE_TIME),
      authoritativeUserIds: ["someone-else"],
      bankedResetPolicy: "confirm",
    });

    expect(decision).toMatchObject({
      state: "forecasting",
      event: null,
      reasonCode: "source_not_authoritative",
    });
  });

  it("keeps model-only completion as a candidate", () => {
    const post = makePost("Everything is ready for customers.");
    const decision = evaluateConfirmation({
      post,
      extraction: makeExtraction({ explicitResetState: "completed", resetRelevance: 0.95 }),
      authoritativeUserIds: [post.authorId],
      bankedResetPolicy: "confirm",
    });

    expect(decision.state).toBe("candidate_confirmation");
    expect(decision.event?.occurredAt).toBeNull();
  });

  it("honors the banked Reset forecast-only policy", () => {
    const post = makePost("The banked reset is complete.");
    const decision = evaluateConfirmation({
      post,
      extraction: extractSignalWithRules(post.text, REFERENCE_TIME),
      authoritativeUserIds: [post.authorId],
      bankedResetPolicy: "forecast_only",
    });

    expect(decision).toMatchObject({
      state: "forecasting",
      reasonCode: "banked_reset_forecast_only",
    });
  });
});

function makePost(text: string): SourcePostObserved {
  return SourcePostObservedSchema.parse({
    postId: "post-1",
    authorId: "tibo-1",
    authorDisplayName: "Tibo",
    authorHandle: "tibo",
    authorAvatarUrl: null,
    sourceKind: "post",
    conversationId: null,
    referencedPostIds: [],
    language: "en",
    sourceUrl: "https://x.com/tibo/status/post-1",
    text,
    contentHash: `hash-${text}`,
    createdAt: REFERENCE_TIME,
    observedAt: REFERENCE_TIME,
    editedAt: null,
    deletedAt: null,
  });
}

function makeExtraction(overrides: Partial<ReturnType<typeof SignalExtractionSchema.parse>> = {}) {
  return SignalExtractionSchema.parse({
    explicitResetState: "none",
    futureCommitment: "none",
    timeHint: { kind: "none", startAt: null, endAt: null, rawPhrase: null },
    scope: "unknown",
    incidentSignal: 0,
    milestoneSignal: 0,
    resetRelevance: 0,
    sentiment: "neutral",
    confidence: 0.5,
    evidenceSpans: [],
    reasonCode: "test_signal",
    ...overrides,
  });
}

function sequenceAdapter(values: unknown[]): SignalModelAdapter {
  let index = 0;
  return {
    model: "test-model",
    async extract() {
      const value = values[index];
      index += 1;
      return value;
    },
  };
}
