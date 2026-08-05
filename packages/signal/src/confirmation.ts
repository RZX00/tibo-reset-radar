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
  // The deterministic evidence gate has to recognise the same past-tense phrasings the extractor
  // classifies as completed, or every real announcement stalls at candidate forever.
  /\b(?:i|we)(?:'ve|’ve|\s+have|\s+just)\s+(?:just\s+|now\s+)?reset\b/i,
  /\b(?:have|has|had)\s+(?:now\s+)?been\s+reset\b/i,
  /\breset\s+button\s+(?:has\s+been\s+)?pressed\b/i,
  /\b(?:i|we)(?:'ve|’ve|\s+have)\s+allowed\b.{0,60}\breset\b/i,
  /\b(?:i|we)\s+did\b.{0,30}\b(?:full\s+|double\s+)?reset\b/i,
  /\benjoy\s+(?:a\s+)?(?:full\s+)?reset(?:\s+(?:of\s+)?(?:your\s+)?(?:usage\s+)?limits?)?\b/i,
  /\b(?:i|we)(?:'m|’m|'re|’re|\s+am|\s+are)\s+(?:once\s+again\s+)?resett?ing\b/i,
  /\b(?:we\s+are\s+giving|introducing)\b.{0,80}\b(?:usage\s+limits?\s+)?reset\b/i,
  /\b(?:another|new)\b.{0,40}\b(?:usage\s+)?reset\b.{0,100}\b(?:lands?|landing|should\s+(?:land|show|be\s+showing|have))\b/i,
  /\b(?:full\s+)?reset\b.{0,60}\bpropagat(?:e|ing)\b/i,
  /(?:重置已完成|已经重置|已完成重置|现已重置|重置成功|正在重置|开始重置|重置进行中)/,
];
const RETRACTED_PATTERNS = [
  /\b(?:reset\s+)?(?:is\s+)?(?:cancelled|canceled|retracted|rolled\s+back|not\s+happening)\b/i,
  /(?:取消|撤回|回滚|不会进行)(?:本次)?重置|重置(?:已)?(?:取消|撤回|回滚)/,
];
const FUTURE_PATTERNS = [
  /\b(?:will|might|may|could|hopefully|plan(?:ning)?\s+to|going\s+to)\b.{0,30}\breset\b/i,
  /\bwill\s+(?:be\s+)?(?:\w+\s+){0,3}resett?ing\b/i,
  /\breset\s+(?:is\s+)?incoming\b/i,
  /(?:将会?|可能|希望|计划|预计).{0,20}重置/,
];
const UNCERTAIN_PATTERNS = [
  /\b(?:joke|kidding|rumou?r|someone\s+said|they\s+say)\b/i,
  /(?:听说|传闻|开玩笑).{0,20}重置/,
];
const BANKED_PATTERNS = [/\bbanked\s+reset\b/i, /(?:储备|预存|banked)\s*重置/i];
const IMMEDIATE_RESET_PATTERNS = [
  /\b(?:i|we)(?:'ve|’ve|\s+have|\s+just)\s+(?:just\s+|now\s+)?reset\b/i,
  /\b(?:have|has|had)\s+(?:now\s+)?been\s+reset\b/i,
  /\breset\s+button\s+(?:has\s+been\s+)?pressed\b/i,
  /\b(?:i|we)(?:'ve|’ve|\s+have)\s+allowed\b.{0,60}\breset\b/i,
  /\b(?:i|we)\s+did\b.{0,30}\b(?:full\s+|double\s+)?reset\b/i,
];

export function evaluateConfirmation(input: ConfirmationInput): ConfirmationDecision {
  const { post, extraction } = input;
  if (!input.authoritativeUserIds.includes(post.authorId)) {
    return decision("forecasting", "source_not_authoritative", null, extraction);
  }
  if (post.sourceKind === "quote" || post.sourceKind === "repost") {
    return decision("forecasting", "source_not_first_party_statement", null, extraction);
  }

  const banked = matchesAny(post.text, BANKED_PATTERNS);
  if (
    banked &&
    input.bankedResetPolicy !== "confirm" &&
    !matchesAny(post.text, IMMEDIATE_RESET_PATTERNS)
  ) {
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
  if (matchesAny(post.text, UNCERTAIN_PATTERNS)) {
    return candidate(post, extraction, "future_or_uncertain_language");
  }
  if (
    matchesAny(post.text, FUTURE_PATTERNS) &&
    !matchesAny(post.text, IMMEDIATE_RESET_PATTERNS) &&
    extraction.explicitResetState !== "rolling_out_now"
  ) {
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
    supersedesEventId: null,
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
