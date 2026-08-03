import { type ExternalEvent, ExternalEventSchema } from "@tibo-radar/contracts";

export const OPENAI_STATUS_SOURCE_ID = "openai-status";
export const OPENAI_STATUS_INCIDENTS_URL = "https://status.openai.com/api/v2/incidents.json";

export interface ExternalEventCollectionOptions {
  observedAt: string;
  signal?: AbortSignal;
}

export interface ExternalEventSource {
  readonly sourceId: string;
  collect(options: ExternalEventCollectionOptions): Promise<ExternalEvent[]>;
}

export interface OpenAIStatusSourceOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Reads the public OpenAI status feed. The first local observation is the event's as-of boundary. */
export class OpenAIStatusSource implements ExternalEventSource {
  readonly sourceId = OPENAI_STATUS_SOURCE_ID;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: OpenAIStatusSourceOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async collect(options: ExternalEventCollectionOptions): Promise<ExternalEvent[]> {
    const observedMs = Date.parse(options.observedAt);
    if (!Number.isFinite(observedMs)) throw new TypeError("observedAt must be an ISO date-time");
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await this.#fetch(OPENAI_STATUS_INCIDENTS_URL, {
      headers: { accept: "application/json" },
      signal,
    });
    if (!response.ok) {
      const error = new Error(`OpenAI status returned HTTP ${response.status}`);
      error.name = "OpenAIStatusHttpError";
      throw error;
    }
    const payload: unknown = await response.json();
    if (!isRecord(payload) || !Array.isArray(payload.incidents)) {
      throw new TypeError("OpenAI status response must contain an incidents array");
    }
    return payload.incidents.flatMap((incident) => {
      const mapped = mapIncident(incident, options.observedAt);
      return mapped ? [mapped] : [];
    });
  }
}

function mapIncident(value: unknown, observedAt: string): ExternalEvent | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  const title = stringValue(value.name);
  const occurredAt = dateTimeValue(value.created_at);
  if (!id || !title || !occurredAt) return null;
  const updates = Array.isArray(value.incident_updates) ? value.incident_updates : [];
  const updateText = updates
    .flatMap((update) =>
      isRecord(update) && stringValue(update.body) ? [String(update.body)] : [],
    )
    .join(" ");
  const searchable = `${title} ${updateText}`.toLowerCase();
  const classification = classifyIncident(searchable);
  if (!classification) return null;
  const impact = stringValue(value.impact)?.toLowerCase() ?? "unknown";
  return ExternalEventSchema.parse({
    eventId: `openai-status:${id}`,
    sourceType: "official_status",
    provider: "OpenAI",
    eventType: classification.eventType,
    title,
    sourceUrl: `https://status.openai.com/incidents/${encodeURIComponent(id)}`,
    occurredAt,
    knownAt: observedAt,
    endedAt: dateTimeValue(value.resolved_at),
    relevance: classification.relevance,
    severity: impactSeverity(impact),
    metadata: {
      status: stringValue(value.status) ?? "unknown",
      impact,
      officialUpdatedAt: dateTimeValue(value.updated_at),
    },
  });
}

function classifyIncident(text: string): { eventType: string; relevance: number } | null {
  if (/\bcodex\b/.test(text)) return { eventType: "codex_incident", relevance: 1 };
  if (/\b(?:usage|rate)[ -]?limits?\b|\bquota\b|\bcapacity\b|\b429\b/.test(text))
    return { eventType: "usage_limit_incident", relevance: 0.9 };
  if (/\bchatgpt\b|\bconversations?\b/.test(text))
    return { eventType: "chatgpt_incident", relevance: 0.55 };
  if (/\bapi\b|\bresponses?\b|\bmodels?\b|\bstream(?:ing)?\b/.test(text))
    return { eventType: "api_incident", relevance: 0.5 };
  return null;
}

function impactSeverity(impact: string): number {
  if (impact === "critical") return 1;
  if (impact === "major") return 0.75;
  if (impact === "minor") return 0.45;
  if (impact === "none") return 0.2;
  return 0.3;
}

function dateTimeValue(value: unknown): string | null {
  const text = stringValue(value);
  return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
