import { createHash } from "node:crypto";

import type {
  ContentPart,
  EventType,
  Host,
  RawEnvelope,
  ReasoningMetadata,
  TrajectoryEvent,
} from "@trajpack/schema";

export const ADAPTER_VERSION = "0.1.0";

export interface NormalizeOptions {
  traceId?: string;
  sequence?: number;
  capturedAt?: string;
  adapterVersion?: string;
  interfaceVersion?: string;
  sessionId?: string;
  turnId?: string;
  parentSpanId?: string | null;
}

export interface NormalizedCapture {
  raw: RawEnvelope;
  events: TrajectoryEvent[];
}

export interface ParseDiagnostic {
  line: number;
  code: "empty_line" | "invalid_json" | "non_object";
}

export interface NormalizedBatch {
  raw: RawEnvelope[];
  events: TrajectoryEvent[];
  diagnostics: ParseDiagnostic[];
}

type JsonObject = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;

  const entries = Object.entries(value as JsonObject)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
}

export function sha256(value: unknown): string {
  const input = typeof value === "string" ? value : stableJson(value);
  return createHash("sha256").update(input).digest("hex");
}

function deterministicHex(length: number, ...parts: unknown[]): string {
  return sha256(parts).slice(0, length);
}

export function asTraceId(value: string): string {
  return /^[a-f0-9]{32}$/.test(value) ? value : deterministicHex(32, "trace", value);
}

function asSpanId(value: string): string {
  return /^[a-f0-9]{16}$/.test(value) ? value : deterministicHex(16, "span", value);
}

export function stringValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

export function firstString(object: JsonObject, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = stringValue(object[key]);
    if (value !== null && value.length > 0) return value;
  }
  return null;
}

export function nestedRecord(object: JsonObject, key: string): JsonObject | null {
  const value = object[key];
  return isRecord(value) ? value : null;
}

export function toIso(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(millis);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return fallback;
}

export function createRawEnvelope(
  adapter: Host,
  payload: unknown,
  options: NormalizeOptions,
  defaultInterfaceVersion: string,
): RawEnvelope {
  const object = isRecord(payload) ? payload : {};
  const capturedAt = toIso(
    object.timestamp ?? object.created_at ?? object.createdAt,
    options.capturedAt ?? new Date().toISOString(),
  );
  const sessionId =
    firstString(object, ["session_id", "sessionId", "thread_id", "threadId"]) ?? options.sessionId ?? null;
  const turnId = firstString(object, ["turn_id", "turnId"]) ?? options.turnId ?? null;
  const sourceEventId = firstString(object, ["event_id", "eventId", "id"]);

  return {
    envelope_version: "raw/0.1",
    adapter,
    adapter_version: options.adapterVersion ?? ADAPTER_VERSION,
    interface_version: options.interfaceVersion ?? defaultInterfaceVersion,
    captured_at: capturedAt,
    sequence: options.sequence ?? 0,
    source_event_id: sourceEventId,
    session_id: sessionId,
    turn_id: turnId,
    payload_sha256: sha256(payload),
    payload,
  };
}

export interface ContentOptions {
  type?: ContentPart["type"];
  mimeType?: string;
  sensitivity?: ContentPart["sensitivity"];
  reasoning?: ReasoningMetadata | null;
}

export function contentPart(value: unknown, ordinal = 0, options: ContentOptions = {}): ContentPart {
  const rendered = typeof value === "string" ? value : stableJson(value);
  return {
    ordinal,
    type: options.type ?? "text",
    mime_type: options.mimeType ?? (typeof value === "string" ? "text/plain" : "application/json"),
    value: rendered,
    blob_ref: null,
    sha256: sha256(rendered),
    sensitivity: options.sensitivity ?? "internal",
    redaction_status: "not_scanned",
    review_disposition: "include",
    reasoning: options.reasoning ?? null,
    rights_override: null,
  };
}

export const PROVIDER_SUMMARY: ReasoningMetadata = {
  representation: "provider_summary",
  provider_claim: "reasoning_summary",
  source_field: "summary",
  visibility: "user_visible",
  include_in_loss: false,
};

export const PROVIDER_EXPOSED_REASONING: ReasoningMetadata = {
  representation: "provider_exposed_reasoning",
  provider_claim: "chain_of_thought",
  source_field: "reasoning_content",
  visibility: "api_only",
  include_in_loss: false,
};

export const OPAQUE_REASONING: ReasoningMetadata = {
  representation: "opaque_reasoning_state",
  provider_claim: "none",
  source_field: "redacted_thinking",
  visibility: "not_returned",
  include_in_loss: false,
};

export interface EventInput {
  eventType: EventType;
  actor: TrajectoryEvent["actor"];
  status?: TrajectoryEvent["status"];
  content?: ContentPart[];
  sourceEventId?: string | null;
  sourceSessionId?: string | null;
  sourceTurnId?: string | null;
  sourceStepId?: string | null;
  parentSpanId?: string | null;
  startedAt?: string;
  endedAt?: string | null;
  tool?: TrajectoryEvent["tool"];
  usage?: Partial<TrajectoryEvent["usage"]>;
  metadata?: Record<string, unknown>;
}

export function createEvent(raw: RawEnvelope, index: number, input: EventInput, options: NormalizeOptions): TrajectoryEvent {
  const sessionKey = input.sourceSessionId ?? raw.session_id ?? raw.payload_sha256;
  const traceId = asTraceId(options.traceId ?? sessionKey);
  const sourceEventId = input.sourceEventId ?? raw.source_event_id;
  const eventKey = sourceEventId ?? raw.payload_sha256;
  const spanId = asSpanId(deterministicHex(16, raw.adapter, eventKey, input.eventType, index));
  const parentSpanId = input.parentSpanId ?? options.parentSpanId ?? null;
  const startedAt = input.startedAt ?? raw.captured_at;

  return {
    record_type: "event",
    event_id: `${raw.adapter}:${eventKey}:${input.eventType}:${index}`,
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: parentSpanId === null ? null : asSpanId(parentSpanId),
    links: [],
    sequence: raw.sequence + index,
    started_at: startedAt,
    ended_at: input.endedAt ?? (input.status === "partial" ? null : startedAt),
    event_type: input.eventType,
    actor: input.actor,
    status: input.status ?? "ok",
    source_event_id: sourceEventId,
    source_session_id: input.sourceSessionId ?? raw.session_id,
    source_turn_id: input.sourceTurnId ?? raw.turn_id,
    source_step_id: input.sourceStepId ?? null,
    content: input.content ?? [],
    tool: input.tool ?? null,
    usage: {
      input_tokens: input.usage?.input_tokens ?? null,
      output_tokens: input.usage?.output_tokens ?? null,
      reasoning_tokens: input.usage?.reasoning_tokens ?? null,
      cache_read_tokens: input.usage?.cache_read_tokens ?? null,
      latency_ms: input.usage?.latency_ms ?? null,
      cost_usd: input.usage?.cost_usd ?? null,
    },
    metadata: {
      capture_channel: raw.interface_version,
      raw_payload_sha256: raw.payload_sha256,
      ...input.metadata,
    },
    review_disposition: "include",
  };
}

export function usageFrom(value: unknown): Partial<TrajectoryEvent["usage"]> {
  if (!isRecord(value)) return {};
  const number = (...keys: string[]): number | null => {
    for (const key of keys) {
      const candidate = value[key];
      if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) return candidate;
    }
    return null;
  };
  return {
    input_tokens: number("input_tokens", "inputTokens", "prompt_tokens"),
    output_tokens: number("output_tokens", "outputTokens", "completion_tokens"),
    reasoning_tokens: number("reasoning_tokens", "reasoningTokens"),
    cache_read_tokens: number("cache_read_input_tokens", "cache_read_tokens", "cacheReadTokens"),
    latency_ms: number("latency_ms", "duration_ms", "durationMs"),
    cost_usd: number("cost_usd", "total_cost_usd", "costUsd"),
  };
}

export function parseJsonLines(input: string): { values: JsonObject[]; diagnostics: ParseDiagnostic[] } {
  const values: JsonObject[] = [];
  const diagnostics: ParseDiagnostic[] = [];
  const lines = input.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) {
      if (index < lines.length - 1) diagnostics.push({ line: index + 1, code: "empty_line" });
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) values.push(parsed);
      else diagnostics.push({ line: index + 1, code: "non_object" });
    } catch {
      diagnostics.push({ line: index + 1, code: "invalid_json" });
    }
  }
  return { values, diagnostics };
}

export function renumberEvents(events: TrajectoryEvent[]): TrajectoryEvent[] {
  return events.map((event, sequence) => ({ ...event, sequence }));
}

export function dedupeKey(...parts: unknown[]): string {
  return sha256(parts);
}
