import { createHash } from "node:crypto";
import {
  type SignalExtraction,
  SignalExtractionSchema,
  type SourcePostObserved,
} from "@tibo-radar/contracts";

import { extractSignalWithRules } from "./rules.js";

export const SIGNAL_PROMPT_VERSION = "signal-v1";
export const SIGNAL_INPUT_SCHEMA_VERSION = "source-post-v1";

export interface SignalExtractionInput {
  post: SourcePostObserved;
  resetDefinition: string;
  referenceTime: string;
}

export interface SignalModelAdapter {
  readonly model: string;
  extract(input: SignalExtractionInput): Promise<unknown>;
}

export interface SignalExtractionResult {
  extraction: SignalExtraction;
  provenance: {
    method: "llm" | "deterministic_rules";
    model: string;
    promptVersion: typeof SIGNAL_PROMPT_VERSION;
    inputSchemaVersion: typeof SIGNAL_INPUT_SCHEMA_VERSION;
    inputHash: string;
    attempts: number;
    errors: string[];
  };
}

export interface OpenAICompatibleAdapterOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

const nullableDateTime = {
  anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
} as const;

const SIGNAL_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "explicitResetState",
    "futureCommitment",
    "timeHint",
    "scope",
    "incidentSignal",
    "milestoneSignal",
    "resetRelevance",
    "sentiment",
    "confidence",
    "evidenceSpans",
    "reasonCode",
  ],
  properties: {
    explicitResetState: {
      type: "string",
      enum: ["none", "future", "rolling_out_now", "completed", "limited", "retracted", "ambiguous"],
    },
    futureCommitment: { type: "string", enum: ["none", "weak", "explicit"] },
    timeHint: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "startAt", "endAt", "rawPhrase"],
      properties: {
        kind: { type: "string", enum: ["none", "relative", "absolute", "range"] },
        startAt: nullableDateTime,
        endAt: nullableDateTime,
        rawPhrase: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    },
    scope: { type: "string", enum: ["unknown", "all", "plan", "region", "cohort"] },
    incidentSignal: { type: "number", minimum: 0, maximum: 1 },
    milestoneSignal: { type: "number", minimum: 0, maximum: 1 },
    resetRelevance: { type: "number", minimum: 0, maximum: 1 },
    sentiment: { type: "string", enum: ["negative", "neutral", "positive", "mixed"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    evidenceSpans: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end", "label"],
        properties: {
          start: { type: "integer", minimum: 0 },
          end: { type: "integer", minimum: 0 },
          label: { type: "string", minLength: 1 },
        },
      },
    },
    reasonCode: { type: "string", pattern: "^[a-z0-9_]+$" },
  },
} as const;

export class OpenAICompatibleSignalAdapter implements SignalModelAdapter {
  readonly model: string;
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: OpenAICompatibleAdapterOptions) {
    this.model = options.model;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async extract(input: SignalExtractionInput): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          messages: [
            {
              role: "system",
              content: buildSystemPrompt(input.resetDefinition),
            },
            {
              role: "user",
              content: JSON.stringify({
                referenceTime: input.referenceTime,
                sourceKind: input.post.sourceKind,
                authorId: input.post.authorId,
                text: input.post.text,
              }),
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "signal_extraction",
              strict: true,
              schema: SIGNAL_JSON_SCHEMA,
            },
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`LLM request failed with HTTP ${response.status}`);
      }

      const payload: unknown = await response.json();
      return parseAssistantJson(payload);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function extractSignal(
  input: SignalExtractionInput,
  adapter: SignalModelAdapter,
): Promise<SignalExtractionResult> {
  const errors: string[] = [];
  const inputHash = createHash("sha256")
    .update(
      `${SIGNAL_PROMPT_VERSION}\0${input.resetDefinition}\0${input.referenceTime}\0${input.post.contentHash}`,
    )
    .digest("hex");

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const candidate = SignalExtractionSchema.parse(await adapter.extract(input));
      validateEvidenceSpans(candidate, input.post.text);
      return {
        extraction: candidate,
        provenance: {
          method: "llm",
          model: adapter.model,
          promptVersion: SIGNAL_PROMPT_VERSION,
          inputSchemaVersion: SIGNAL_INPUT_SCHEMA_VERSION,
          inputHash,
          attempts: attempt,
          errors,
        },
      };
    } catch (error) {
      errors.push(safeErrorMessage(error));
    }
  }

  return {
    extraction: extractSignalWithRules(input.post.text, input.referenceTime),
    provenance: {
      method: "deterministic_rules",
      model: adapter.model,
      promptVersion: SIGNAL_PROMPT_VERSION,
      inputSchemaVersion: SIGNAL_INPUT_SCHEMA_VERSION,
      inputHash,
      attempts: 2,
      errors,
    },
  };
}

export function validateEvidenceSpans(extraction: SignalExtraction, text: string): void {
  for (const span of extraction.evidenceSpans) {
    if (
      span.end <= span.start ||
      span.end > text.length ||
      text.slice(span.start, span.end).trim() === ""
    ) {
      throw new Error(
        `Invalid evidence span ${span.start}:${span.end} for text length ${text.length}`,
      );
    }
  }
}

function buildSystemPrompt(resetDefinition: string): string {
  return [
    `You extract evidence about this event: ${resetDefinition}`,
    "Return only the strict JSON object requested by the response schema.",
    "Evidence offsets are zero-based UTF-16 string offsets into the supplied text; end is exclusive.",
    "Never infer completion from a prediction, wish, question, quotation, joke, negation, or third-party claim.",
    "Use completed only for an event stated as already completed, rolling_out_now only for an event underway now, and future only for a future commitment.",
    "Use conservative confidence and resetRelevance when context is ambiguous.",
  ].join("\n");
}

function parseAssistantJson(payload: unknown): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
    throw new Error("LLM response has no choices");
  }
  const first = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) {
    throw new Error("LLM response has no assistant message");
  }
  const { content } = first.message;
  if (typeof content === "string") {
    return JSON.parse(content);
  }
  if (Array.isArray(content)) {
    const text = content
      .filter((part): part is { text: string } => isRecord(part) && typeof part.text === "string")
      .map((part) => part.text)
      .join("");
    return JSON.parse(text);
  }
  throw new Error("LLM assistant content is not JSON text");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message.slice(0, 300);
  }
  return "Unknown signal extraction failure";
}
