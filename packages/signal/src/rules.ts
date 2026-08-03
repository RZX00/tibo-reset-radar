import { type SignalExtraction, SignalExtractionSchema } from "@tibo-radar/contracts";

interface MatchedEvidence {
  start: number;
  end: number;
  label: string;
  text: string;
}

const RETRACTED_PATTERNS = [
  /\b(?:reset\s+)?(?:is\s+)?(?:cancelled|canceled|retracted|rolled\s+back|not\s+happening)\b/i,
  /(?:取消|撤回|回滚|不会进行)(?:本次)?重置|重置(?:已)?(?:取消|撤回|回滚)/,
];
const COMPLETED_PATTERNS = [
  /\b(?:reset\s+(?:is\s+)?(?:complete|completed|done|live)|has\s+(?:now\s+)?reset|successfully\s+reset)\b/i,
  /(?:重置已完成|已经重置|已完成重置|现已重置|重置成功)/,
];
const ROLLING_PATTERNS = [
  /\b(?:reset\s+is\s+(?:rolling\s+out|underway|in\s+progress)|reset\s+starts?\s+now|starting\s+the\s+reset)\b/i,
  /(?:正在重置|开始重置|重置进行中|正在进行重置)/,
];
const FUTURE_PATTERNS = [
  /\b(?:will|going\s+to|plan(?:ning)?\s+to|scheduled\s+to)\s+(?:perform\s+(?:a\s+)?)?reset\b/i,
  /\breset\s+(?:is\s+)?(?:coming|scheduled|planned)\b/i,
  /(?:将会?|计划|预计|准备|安排)(?:进行)?重置|重置(?:即将|计划于|预计于)/,
];
const LIMITED_PATTERNS = [
  /\b(?:limited|partial|selected|some|pilot|cohort|region|plan)\b.{0,40}\breset\b/i,
  /\breset\b.{0,40}\b(?:limited|partial|selected|some|pilot|cohort|region|plan)\b/i,
  /(?:部分|小范围|指定|试点|特定)(?:用户|地区|套餐|群组)?.{0,20}重置|重置.{0,20}(?:部分|小范围|指定|试点|特定)/,
];
const RESET_PATTERNS = [/\breset(?:s|ting)?\b/i, /重置/];
const INCIDENT_PATTERNS = [
  /\b(?:incident|outage|degraded|failure|broken|overload|capacity)\b/i,
  /(?:故障|事故|宕机|降级|异常|过载|容量)/,
];
const MILESTONE_PATTERNS = [
  /\b(?:milestone|launched|shipped|release(?:d)?|rollout|migration|completed)\b/i,
  /(?:里程碑|发布|上线|交付|迁移完成|完成)/,
];
const NEGATION_PATTERNS = [
  /\b(?:not|never|no)\s+(?:going\s+to\s+|planning\s+to\s+|doing\s+)?reset\b/i,
  /(?:不会|不再|没有|并未|无需)(?:进行)?重置/,
];
const JOKE_OR_REPORT_PATTERNS = [
  /\b(?:joke|kidding|hypothetically|rumou?r|someone\s+said|they\s+say)\b/i,
  /(?:开玩笑|假设|传闻|听说|有人说)/,
];

export function extractSignalWithRules(text: string, referenceTime: string): SignalExtraction {
  const reset = findFirst(text, RESET_PATTERNS, "reset_reference");
  const negated = findFirst(text, NEGATION_PATTERNS, "negated_reset");
  const uncertain = findFirst(text, JOKE_OR_REPORT_PATTERNS, "uncertain_context");
  const retracted = findFirst(text, RETRACTED_PATTERNS, "retracted_reset");
  const completed = findFirst(text, COMPLETED_PATTERNS, "completed_reset");
  const rolling = findFirst(text, ROLLING_PATTERNS, "rolling_reset");
  const future = findFirst(text, FUTURE_PATTERNS, "future_reset");
  const limited = findFirst(text, LIMITED_PATTERNS, "limited_scope");
  const incident = findFirst(text, INCIDENT_PATTERNS, "incident");
  const milestone = findFirst(text, MILESTONE_PATTERNS, "milestone");

  let explicitResetState: SignalExtraction["explicitResetState"] = "none";
  let primary: MatchedEvidence | null = reset;
  if (negated || uncertain) {
    explicitResetState = reset ? "ambiguous" : "none";
    primary = negated ?? uncertain ?? primary;
  } else if (retracted) {
    explicitResetState = "retracted";
    primary = retracted;
  } else if (limited) {
    explicitResetState = "limited";
    primary = limited;
  } else if (completed) {
    explicitResetState = "completed";
    primary = completed;
  } else if (rolling) {
    explicitResetState = "rolling_out_now";
    primary = rolling;
  } else if (future) {
    explicitResetState = "future";
    primary = future;
  }

  const futureCommitment = future
    ? /\b(?:will|scheduled|going\s+to)\b|(?:将|安排)/i.test(future.text)
      ? "explicit"
      : "weak"
    : "none";
  const timeHint = extractTimeHint(text, referenceTime);
  const scope = detectScope(text, limited !== null);
  const resetRelevance = reset
    ? uncertain || negated
      ? 0.45
      : explicitResetState === "none"
        ? 0.55
        : 0.9
    : 0.05;
  const incidentSignal = incident ? 0.78 : 0;
  const milestoneSignal = milestone ? 0.72 : 0;
  const evidence = uniqueEvidence([primary, incident, milestone, timeHint.evidence]);

  return SignalExtractionSchema.parse({
    explicitResetState,
    futureCommitment,
    timeHint: timeHint.value,
    scope,
    incidentSignal,
    milestoneSignal,
    resetRelevance,
    sentiment: incident ? (milestone ? "mixed" : "negative") : milestone ? "positive" : "neutral",
    confidence: primary ? (uncertain || negated ? 0.5 : 0.82) : incident || milestone ? 0.6 : 0.35,
    evidenceSpans: evidence.map(({ start, end, label }) => ({ start, end, label })),
    reasonCode: reasonCodeFor(explicitResetState, incident !== null, milestone !== null),
  });
}

function extractTimeHint(
  text: string,
  referenceTime: string,
): {
  value: SignalExtraction["timeHint"];
  evidence: MatchedEvidence | null;
} {
  const reference = new Date(referenceTime);
  if (Number.isNaN(reference.getTime())) {
    throw new Error("referenceTime must be a valid ISO date-time");
  }

  const hours = findFirst(
    text,
    [/(?:\bin\s+|未来|接下来)(\d{1,3})\s*(?:hours?|小时)/i],
    "relative_time",
  );
  if (hours) {
    const amount = Number.parseInt(hours.text.match(/\d{1,3}/)?.[0] ?? "0", 10);
    const at = new Date(reference.getTime() + amount * 3_600_000).toISOString();
    return {
      value: { kind: "relative", startAt: at, endAt: at, rawPhrase: hours.text },
      evidence: hours,
    };
  }

  const tomorrow = findFirst(text, [/\btomorrow\b/i, /明天/], "relative_time");
  if (tomorrow) {
    const start = new Date(reference.getTime() + 24 * 3_600_000).toISOString();
    return {
      value: { kind: "relative", startAt: start, endAt: start, rawPhrase: tomorrow.text },
      evidence: tomorrow,
    };
  }

  const isoDate = findFirst(
    text,
    [/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2}))?\b/],
    "absolute_time",
  );
  if (isoDate) {
    const parsed = new Date(
      isoDate.text.length === 10 ? `${isoDate.text}T00:00:00.000Z` : isoDate.text,
    );
    if (!Number.isNaN(parsed.getTime())) {
      return {
        value: {
          kind: "absolute",
          startAt: parsed.toISOString(),
          endAt: parsed.toISOString(),
          rawPhrase: isoDate.text,
        },
        evidence: isoDate,
      };
    }
  }

  return {
    value: { kind: "none", startAt: null, endAt: null, rawPhrase: null },
    evidence: null,
  };
}

function detectScope(text: string, limited: boolean): SignalExtraction["scope"] {
  if (
    /\b(?:everyone|all\s+(?:users|plans|accounts))\b|(?:全部|所有)(?:用户|套餐|账户)?/i.test(text)
  ) {
    return "all";
  }
  if (/\b(?:region|country|geo)\b|(?:地区|区域|国家)/i.test(text)) return "region";
  if (/\b(?:cohort|selected\s+users|pilot)\b|(?:群组|指定用户|试点用户)/i.test(text))
    return "cohort";
  if (/\b(?:plan|tier|subscription)\b|(?:套餐|订阅层级)/i.test(text)) return "plan";
  return limited ? "cohort" : "unknown";
}

function reasonCodeFor(
  state: SignalExtraction["explicitResetState"],
  incident: boolean,
  milestone: boolean,
): string {
  if (state !== "none") return `rules_${state}`;
  if (incident && milestone) return "rules_incident_and_milestone";
  if (incident) return "rules_incident";
  if (milestone) return "rules_milestone";
  return "rules_no_signal";
}

function findFirst(text: string, patterns: RegExp[], label: string): MatchedEvidence | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.index !== undefined && match[0].length > 0) {
      return { start: match.index, end: match.index + match[0].length, label, text: match[0] };
    }
  }
  return null;
}

function uniqueEvidence(values: Array<MatchedEvidence | null>): MatchedEvidence[] {
  const seen = new Set<string>();
  return values.filter((value): value is MatchedEvidence => {
    if (!value) return false;
    const key = `${value.start}:${value.end}:${value.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
