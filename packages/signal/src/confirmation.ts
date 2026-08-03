import {
  type ResetEvent,
  ResetEventSchema,
  type SignalExtraction,
  type SourcePostObserved,
} from "@tibo-radar/contracts";

export interface ConfirmationInput {
  post: SourcePostObserved;
  extraction: SignalExtraction;
  authoritativeUserIds: readonly string[];
  bankedResetPolicy: "confirm" | "forecast_only" | "ignore";
}

export interface ConfirmationDecision {
  state: "forecasting" | "candidate_confirmation" | "confirmed_reset" | "retracted";
  reasonCode: string;
  event: ResetEvent | null;
  evidenceSpans: SignalExtraction["evidenceSpans"];
}

const CONFIRMED_PATTERNS = [
  /\b(?:reset\s+(?:is\s+)?(?:complete|completed|done|live)|has\s+(?:now\s+)?reset|successfully\s+reset)\b/i,
  /\b(?:reset\s+is\s+(?:rolling\s+out|underway|in\s+progress)|reset\s+starts?\s+now|starting\s+the\s+reset)\b/i,
  /(?:重置已完成|已经重置|已完成重置|现已重置|重置成功|正在重置|开始重置|重置进行中)/,
];
const RETRACTED_PATTERNS = [
  /\b(?:reset\s+)?(?:is\s+)?(?:cancelled|canceled|retracted|rolled\s+back|not\s+happening)\b/i,
  /(?:取消|撤回|回滚|不会进行)(?:本次)?重置|重置(?:已)?(?:取消|撤回|回滚)/,
];
const FUTURE_OR_UNCERTAIN_PATTERNS = [
  /\b(?:will|might|may|could|hopefully|plan(?:ning)?\s+to|going\s+to)\b.{0,30}\breset\b/i,
  /\b(?:joke|kidding|rumou?r|someone\s+said|they\s+say)\b/i,
  /(?:将会?|可能|希望|计划|预计|听说|传闻|开玩笑).{0,20}重置/,
];
const BANKED_PATTERNS = [/\bbanked\s+reset\b/i, /(?:储备|预存|banked)\s*重置/i];

export function evaluateConfirmation(input: ConfirmationInput): ConfirmationDecision {
  const { post, extraction } = input;
  if (!input.authoritativeUserIds.includes(post.authorId)) {
    return decision("forecasting", "source_not_authoritative", null, extraction);
  }
  if (post.sourceKind === "quote" || post.sourceKind === "repost") {
    return decision("forecasting", "source_not_first_party_statement", null, extraction);
  }

  const banked = matchesAny(post.text, BANKED_PATTERNS);
  if (banked && input.bankedResetPolicy !== "confirm") {
    return decision(
      "forecasting",
      input.bankedResetPolicy === "ignore" ? "banked_reset_ignored" : "banked_reset_forecast_only",
      null,
      extraction,
    );
  }

  if (extraction.explicitResetState === "retracted") {
    if (!matchesAny(post.text, RETRACTED_PATTERNS)) {
      return candidate(post, extraction, "retraction_requires_deterministic_evidence");
    }
    return decision(
      "retracted",
      "authoritative_retraction",
      makeEvent(post, extraction, "retracted", post.createdAt),
      extraction,
    );
  }

  if (
    extraction.explicitResetState !== "completed" &&
    extraction.explicitResetState !== "rolling_out_now"
  ) {
    return decision("forecasting", "no_completed_reset_claim", null, extraction);
  }
  if (matchesAny(post.text, FUTURE_OR_UNCERTAIN_PATTERNS)) {
    return candidate(post, extraction, "future_or_uncertain_language");
  }
  if (!matchesAny(post.text, CONFIRMED_PATTERNS)) {
    return candidate(post, extraction, "completion_requires_deterministic_evidence");
  }

  return decision(
    "confirmed_reset",
    "authoritative_completed_reset",
    makeEvent(post, extraction, "confirmed_reset", post.createdAt),
    extraction,
  );
}

function candidate(
  post: SourcePostObserved,
  extraction: SignalExtraction,
  reasonCode: string,
): ConfirmationDecision {
  return decision(
    "candidate_confirmation",
    reasonCode,
    makeEvent(post, extraction, "candidate_confirmation", null),
    extraction,
  );
}

function makeEvent(
  post: SourcePostObserved,
  extraction: SignalExtraction,
  status: "candidate_confirmation" | "confirmed_reset" | "retracted",
  occurredAt: string | null,
): ResetEvent {
  return ResetEventSchema.parse({
    eventId: `reset-${post.postId}`,
    status,
    occurredAt,
    scope: extraction.scope,
    evidencePostIds: [post.postId],
  });
}

function decision(
  state: ConfirmationDecision["state"],
  reasonCode: string,
  event: ResetEvent | null,
  extraction: SignalExtraction,
): ConfirmationDecision {
  return { state, reasonCode, event, evidenceSpans: extraction.evidenceSpans };
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}
