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
    // Announcements are written in the first person or the passive, never as "the reset is complete".
    ["I've reset usage limits for all paid users.", "completed"],
    ["I have reset everyone's usage limits.", "completed"],
    ["The usage limits have been reset for all paid users.", "completed"],
    ["Usage limits will be fully reset again in the next hour.", "future"],
    ["I have not reset anything yet.", "ambiguous"],
  ] as const)("classifies %s", (text, expected) => {
    expect(extractSignalWithRules(text, REFERENCE_TIME).explicitResetState).toBe(expected);
  });

  it.each([
    ["Reset button pressed, should see it in a bit.", "completed"],
    ["I have allowed Codex to reset its own rate limits across all plans.", "completed"],
    ["We did a sneaky double reset. You also get one banked reset.", "completed"],
    ["We are once again resetting the usage limits for all.", "rolling_out_now"],
    [
      "Introducing another usage limit reset. Should land over the next 30 minutes.",
      "rolling_out_now",
    ],
    ["Enjoy a full reset of your usage limits. Propagating in the next hour.", "rolling_out_now"],
    ["New day, new usage reset for paid users. Lands in the next hour.", "rolling_out_now"],
    ["Rate limit reset incoming.", "future"],
    ["We will be reseting rate limits in a bit.", "future"],
    ["And yet, I don't see a reset button there.", "ambiguous"],
    ["One day we created the reset button and the rest is history.", "none"],
  ] as const)("classifies a historical Tibo phrasing: %s", (text, expected) => {
    expect(extractSignalWithRules(text, REFERENCE_TIME).explicitResetState).toBe(expected);
  });

  it("does not mistake all paid plans for a limited rollout", () => {
    expect(
      extractSignalWithRules(
        "Codex usage limits have now been reset across all paid plans.",
        REFERENCE_TIME,
      ),
    ).toMatchObject({ explicitResetState: "completed", scope: "all" });
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

  it("confirms an authoritative quote post when its own commentary announces a completed reset", () => {
    const post = makePost(
      `That's right, GPT-5.6 Sol is awesome and can be used pretty much anywhere, including in the CC harness.

To celebrate this, together with the fact that I'm not going anywhere... I have reset usage limits for all paid users of ChatGPT Work and Codex.

Have fun out there!`,
      "quote",
    );
    const decision = evaluateConfirmation({
      post,
      extraction: extractSignalWithRules(post.text, REFERENCE_TIME),
      authoritativeUserIds: [post.authorId],
      bankedResetPolicy: "forecast_only",
    });

    expect(decision).toMatchObject({
      state: "confirmed_reset",
      reasonCode: "authoritative_completed_reset",
      event: {
        status: "confirmed_reset",
        occurredAt: post.createdAt,
        evidencePostIds: [post.postId],
      },
    });
  });

  it("still rejects reposts because their text is not an original first-party statement", () => {
    const post = makePost("I have reset usage limits for all paid users.", "repost");
    const decision = evaluateConfirmation({
      post,
      extraction: extractSignalWithRules(post.text, REFERENCE_TIME),
      authoritativeUserIds: [post.authorId],
      bankedResetPolicy: "forecast_only",
    });

    expect(decision).toMatchObject({
      state: "forecasting",
      event: null,
      reasonCode: "source_not_first_party_statement",
    });
  });

  it("does not confirm an authoritative quote without a completed reset claim", () => {
    const post = makePost("This is worth reading.", "quote");
    const decision = evaluateConfirmation({
      post,
      extraction: extractSignalWithRules(post.text, REFERENCE_TIME),
      authoritativeUserIds: [post.authorId],
      bankedResetPolicy: "forecast_only",
    });

    expect(decision).toMatchObject({
      state: "forecasting",
      event: null,
      reasonCode: "no_completed_reset_claim",
    });
  });

  it("keeps uncertain quoted commentary out of confirmation", () => {
    const post = makePost("Someone said the reset is complete, just a rumour.", "quote");
    const decision = evaluateConfirmation({
      post,
      extraction: extractSignalWithRules(post.text, REFERENCE_TIME),
      authoritativeUserIds: [post.authorId],
      bankedResetPolicy: "forecast_only",
    });

    expect(decision.state).not.toBe("confirmed_reset");
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

  it.each([
    "I've reset usage limits for all paid users.",
    "The usage limits have been reset for all paid users.",
  ])("confirms the way an announcement is actually written: %s", (text) => {
    const post = makePost(text);
    const decision = evaluateConfirmation({
      post,
      extraction: extractSignalWithRules(post.text, REFERENCE_TIME),
      authoritativeUserIds: [post.authorId],
      bankedResetPolicy: "forecast_only",
    });

    expect(decision.state).toBe("confirmed_reset");
    expect(decision.event?.occurredAt).toBe(post.createdAt);
  });

  it("keeps an emphatic promise out of confirmation", () => {
    const post = makePost("Usage limits will be fully reset again in the next hour.");
    const decision = evaluateConfirmation({
      post,
      extraction: extractSignalWithRules(post.text, REFERENCE_TIME),
      authoritativeUserIds: [post.authorId],
      bankedResetPolicy: "forecast_only",
    });

    expect(decision.state).not.toBe("confirmed_reset");
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

  it("confirms an immediate reset even when the same announcement also grants a banked reset", () => {
    const post = makePost(
      "We did a sneaky double reset. You get a full reset now and one banked reset for later.",
    );
    const decision = evaluateConfirmation({
      post,
      extraction: extractSignalWithRules(post.text, REFERENCE_TIME),
      authoritativeUserIds: [post.authorId],
      bankedResetPolicy: "forecast_only",
    });

    expect(decision.state).toBe("confirmed_reset");
    expect(decision.event?.occurredAt).toBe(post.createdAt);
  });

  it("confirms an active reset while preserving a later reset promise as future context", () => {
    const post = makePost(
      "We are resetting rate limits so you can keep building, and we'll reset them again tomorrow.",
    );
    const decision = evaluateConfirmation({
      post,
      extraction: extractSignalWithRules(post.text, REFERENCE_TIME),
      authoritativeUserIds: [post.authorId],
      bankedResetPolicy: "forecast_only",
    });

    expect(decision.state).toBe("confirmed_reset");
  });
});

function makePost(
  text: string,
  sourceKind: SourcePostObserved["sourceKind"] = "post",
): SourcePostObserved {
  return SourcePostObservedSchema.parse({
    postId: "post-1",
    authorId: "tibo-1",
    authorDisplayName: "Tibo",
    authorHandle: "tibo",
    authorAvatarUrl: null,
    sourceKind,
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
