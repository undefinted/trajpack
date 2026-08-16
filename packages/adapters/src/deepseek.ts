import type { TrajectoryEvent } from "@trajpack/schema";

import {
  PROVIDER_EXPOSED_REASONING,
  contentPart,
  createEvent,
  createRawEnvelope,
  dedupeKey,
  firstString,
  isRecord,
  nestedRecord,
  parseJsonLines,
  renumberEvents,
  usageFrom,
  type NormalizeOptions,
  type NormalizedBatch,
  type NormalizedCapture,
} from "./common.js";

const DEEPSEEK_SESSION_INTERFACE = "deepseek-harness@0.1.0-rc.6/session-event/0";

type JsonObject = Record<string, unknown>;

function valueFrom(body: JsonObject, event: JsonObject, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (body[key] !== undefined) return body[key];
    if (event[key] !== undefined) return event[key];
  }
  return undefined;
}

function harnessStatus(value: unknown): TrajectoryEvent["status"] {
  if (value === "error" || value === "failed" || value === "failure") return "error";
  if (value === "cancelled" || value === "canceled" || value === "aborted") return "cancelled";
  if (value === "started" || value === "running" || value === "partial" || value === "delta") return "partial";
  return "ok";
}

function toolShape(callId: string | null, name: string | null, args: unknown, result: unknown, exitCode: unknown) {
  return {
    call_id: callId,
    name,
    arguments: args ?? null,
    result: result ?? null,
    exit_code: typeof exitCode === "number" && Number.isInteger(exitCode) ? exitCode : null,
  };
}

function unwrap(payload: JsonObject): { event: JsonObject; body: JsonObject } {
  const event = nestedRecord(payload, "event") ?? payload;
  const body = nestedRecord(event, "data") ?? event;
  return { event, body };
}

function assistantMessageEvents(
  event: JsonObject,
  body: JsonObject,
  raw: NormalizedCapture["raw"],
  options: NormalizeOptions,
  sessionId: string | null,
  turnId: string | null,
  stepId: string | null,
): TrajectoryEvent[] {
  const message = nestedRecord(body, "message") ?? body;
  const content = message.content;
  const blocks = Array.isArray(content) ? content : [{ type: "text", text: content ?? message.text ?? "" }];
  const events: TrajectoryEvent[] = [];
  const sourceEventId = firstString(event, ["id", "event_id", "eventId"]);

  for (const [index, candidate] of blocks.entries()) {
    if (!isRecord(candidate)) continue;
    const blockType = firstString(candidate, ["type"]) ?? "text";
    const common = {
      block_type: blockType,
      dedupe_key: dedupeKey("dsh", sessionId, turnId, stepId, sourceEventId, index),
    };
    if (blockType === "reasoning" || blockType === "reasoning_content" || blockType === "thinking") {
      const reasoning = firstString(candidate, ["reasoning_content", "reasoning", "text", "thinking"]);
      const reasoningMetadata = {
        ...PROVIDER_EXPOSED_REASONING,
        source_field: candidate.reasoning_content === undefined ? blockType : "reasoning_content",
      };
      events.push(createEvent(raw, index, {
        eventType: "reasoning",
        actor: "assistant",
        content: reasoning === null ? [] : [contentPart(reasoning, 0, { type: "reasoning", reasoning: reasoningMetadata })],
        sourceEventId,
        sourceSessionId: sessionId,
        sourceTurnId: turnId,
        sourceStepId: stepId,
        usage: index === 0 ? usageFrom(message.usage ?? body.usage) : {},
        metadata: common,
      }, options));
      continue;
    }
    if (blockType === "tool_call" || blockType === "tool-call") {
      const callId = firstString(candidate, ["id", "call_id", "tool_call_id"]);
      const name = firstString(candidate, ["name", "tool_name"]);
      const args = candidate.arguments ?? candidate.input ?? null;
      events.push(createEvent(raw, index, {
        eventType: "tool.call",
        actor: "assistant",
        content: [contentPart(args, 0, { type: "tool_call" })],
        sourceEventId,
        sourceSessionId: sessionId,
        sourceTurnId: turnId,
        sourceStepId: stepId,
        tool: toolShape(callId, name, args, null, null),
        usage: index === 0 ? usageFrom(message.usage ?? body.usage) : {},
        metadata: common,
      }, options));
      continue;
    }
    const text = firstString(candidate, ["text", "content"]);
    events.push(createEvent(raw, index, {
      eventType: "message",
      actor: "assistant",
      content: text === null ? [] : [contentPart(text)],
      sourceEventId,
      sourceSessionId: sessionId,
      sourceTurnId: turnId,
      sourceStepId: stepId,
      usage: index === 0 ? usageFrom(message.usage ?? body.usage) : {},
      metadata: common,
    }, options));
  }
  return events;
}

function chunkEvent(
  event: JsonObject,
  body: JsonObject,
  raw: NormalizedCapture["raw"],
  options: NormalizeOptions,
  sessionId: string | null,
  turnId: string | null,
  stepId: string | null,
): TrajectoryEvent {
  const chunk = nestedRecord(body, "chunk") ?? nestedRecord(event, "chunk") ?? body;
  const chunkType = firstString(chunk, ["type"]) ?? firstString(body, ["chunk_type", "chunkType"]) ?? "unknown";
  const sourceEventId = firstString(event, ["id", "event_id", "eventId"]);
  const common = {
    chunk_type: chunkType,
    dedupe_key: dedupeKey("dsh", sessionId, turnId, stepId, sourceEventId, chunkType, raw.sequence),
  };

  if (chunkType === "reasoning-delta" || chunkType === "reasoning_delta" || chunkType === "reasoning") {
    const reasoning = firstString(chunk, ["reasoning_content", "reasoning", "delta", "text", "content"]);
    const reasoningMetadata = {
      ...PROVIDER_EXPOSED_REASONING,
      source_field: chunk.reasoning_content === undefined ? "reasoning-delta" : "reasoning_content",
    };
    return createEvent(raw, 0, {
      eventType: "reasoning",
      actor: "assistant",
      status: "partial",
      content: reasoning === null ? [] : [contentPart(reasoning, 0, { type: "reasoning", reasoning: reasoningMetadata })],
      sourceEventId,
      sourceSessionId: sessionId,
      sourceTurnId: turnId,
      sourceStepId: stepId,
      metadata: common,
    }, options);
  }
  if (chunkType === "tool-call-delta" || chunkType === "tool_call_delta") {
    const callId = firstString(chunk, ["id", "call_id", "tool_call_id"]);
    const name = firstString(chunk, ["name", "tool_name"]);
    const args = chunk.arguments ?? chunk.input ?? chunk.delta ?? null;
    return createEvent(raw, 0, {
      eventType: "tool.call",
      actor: "assistant",
      status: "partial",
      content: [contentPart(args, 0, { type: "tool_call" })],
      sourceEventId,
      sourceSessionId: sessionId,
      sourceTurnId: turnId,
      sourceStepId: stepId,
      tool: toolShape(callId, name, args, null, null),
      metadata: common,
    }, options);
  }
  const text = firstString(chunk, ["text", "content", "delta"]);
  return createEvent(raw, 0, {
    eventType: "message",
    actor: "assistant",
    status: "partial",
    content: text === null ? [] : [contentPart(text)],
    sourceEventId,
    sourceSessionId: sessionId,
    sourceTurnId: turnId,
    sourceStepId: stepId,
    metadata: common,
  }, options);
}

export function normalizeDeepSeekSessionEvent(payload: unknown, options: NormalizeOptions = {}): NormalizedCapture {
  const raw = createRawEnvelope("deepseek_harness", payload, options, DEEPSEEK_SESSION_INTERFACE);
  if (!isRecord(payload)) return { raw, events: [] };
  const { event, body } = unwrap(payload);
  const type = firstString(event, ["type", "event_type", "eventType"]) ?? "unknown";
  const sessionId =
    firstString(body, ["session_id", "sessionId"]) ??
    firstString(event, ["session_id", "sessionId"]) ??
    firstString(payload, ["session_id", "sessionId"]) ??
    raw.session_id;
  const turnId = firstString(body, ["turn_id", "turnId"]) ?? firstString(event, ["turn_id", "turnId"]) ?? raw.turn_id;
  const stepId = firstString(body, ["step_id", "stepId"]) ?? firstString(event, ["step_id", "stepId"]);
  const sourceEventId = firstString(event, ["id", "event_id", "eventId"]);
  const metadata = {
    durable_event_type: type,
    format_version: valueFrom(body, event, ["version", "format_version", "formatVersion"]) ?? 0,
    dedupe_key: dedupeKey("dsh", sessionId, turnId, stepId, sourceEventId, type),
  };
  const make = (input: Parameters<typeof createEvent>[2]) => createEvent(raw, 0, {
    ...input,
    sourceEventId,
    sourceSessionId: sessionId,
    sourceTurnId: turnId,
    sourceStepId: input.sourceStepId ?? stepId,
    metadata: { ...metadata, ...input.metadata },
  }, options);

  if (type === "assistant/chunk") return { raw, events: [chunkEvent(event, body, raw, options, sessionId, turnId, stepId)] };
  if (type === "assistant/message") return { raw, events: assistantMessageEvents(event, body, raw, options, sessionId, turnId, stepId) };

  if (type === "user/message") {
    const message = nestedRecord(body, "message") ?? body;
    const content = message.content ?? message.text ?? body.prompt ?? "";
    return { raw, events: [make({ eventType: "message", actor: "user", content: [contentPart(content)] })] };
  }

  if (type === "tool/call") {
    const callId = firstString(body, ["call_id", "callId", "tool_call_id", "id"]);
    const name = firstString(body, ["name", "tool_name", "toolName"]);
    const args = valueFrom(body, event, ["arguments", "input", "params"]);
    return { raw, events: [make({
      eventType: "tool.call",
      actor: "assistant",
      status: harnessStatus(body.status ?? "partial"),
      content: [contentPart(args ?? null, 0, { type: "tool_call" })],
      tool: toolShape(callId, name, args, null, null),
      metadata: {
        retry: body.retry === true || body.is_retry === true ||
          (typeof body.retry_count === "number" && body.retry_count > 0) ||
          (typeof body.attempt === "number" && body.attempt > 1),
        retry_count: body.retry_count ?? null,
        attempt: body.attempt ?? null,
        retry_of: body.retry_of ?? null,
        dedupe_key: dedupeKey("dsh-tool", sessionId, callId, "call"),
      },
    })] };
  }

  if (type === "tool/result") {
    const callId = firstString(body, ["call_id", "callId", "tool_call_id", "id"]);
    const name = firstString(body, ["name", "tool_name", "toolName"]);
    const result = valueFrom(body, event, ["result", "output", "error"]);
    const exitCode = valueFrom(body, event, ["exit_code", "exitCode"]);
    return { raw, events: [make({
      eventType: "tool.result",
      actor: "tool",
      status: body.error !== undefined ? "error" : harnessStatus(body.status),
      content: [contentPart(result ?? null, 0, { type: "tool_result" })],
      tool: toolShape(callId, name, body.arguments ?? body.input, result, exitCode),
      metadata: { dedupe_key: dedupeKey("dsh-tool", sessionId, callId, "result") },
    })] };
  }

  if (type === "turn/start" || type === "step/start") {
    return { raw, events: [make({
      eventType: type === "turn/start" ? "agent.invoke" : "model.inference",
      actor: type === "turn/start" ? "agent" : "assistant",
      status: "partial",
    })] };
  }
  if (type === "turn/end" || type === "step/end") {
    return { raw, events: [make({
      eventType: "evaluation",
      actor: "environment",
      status: harnessStatus(body.status),
      usage: usageFrom(body.usage),
      content: body.result === undefined ? [] : [contentPart(body.result)],
    })] };
  }
  if (type === "step/error" || type === "turn/error" || type === "error") {
    const error = valueFrom(body, event, ["error", "message", "reason"]);
    return { raw, events: [make({
      eventType: "error",
      actor: "environment",
      status: "error",
      content: error === undefined ? [] : [contentPart(error, 0, { type: "stderr" })],
    })] };
  }
  if (type === "approval/request") {
    return { raw, events: [make({
      eventType: "approval.request",
      actor: "environment",
      content: [contentPart(body.request ?? body)],
    })] };
  }
  if (type === "approval/result" || type === "approval/decision") {
    const decision = valueFrom(body, event, ["decision", "result"]);
    const decisionText = typeof decision === "string" ? decision.toLowerCase() : null;
    const denied = decisionText === "deny" || decisionText === "denied" ||
      decisionText === "reject" || decisionText === "rejected" || decision === false;
    return { raw, events: [make({
      eventType: "approval.decision",
      actor: "user",
      status: denied ? "cancelled" : "ok",
      content: [contentPart(decision ?? body)],
      metadata: { approval_decision: decision ?? null },
    })] };
  }
  if (type === "request/retry" || type === "step/retry" || type === "turn/retry" || type === "retry") {
    return { raw, events: [make({
      eventType: "model.inference",
      actor: "assistant",
      status: "partial",
      content: body.reason === undefined ? [] : [contentPart(body.reason)],
      metadata: {
        retry: true,
        retry_count: body.retry_count ?? null,
        attempt: body.attempt ?? null,
        retry_of: body.retry_of ?? body.request_id ?? null,
      },
    })] };
  }
  if (type.startsWith("compaction/") || type === "compaction") {
    return { raw, events: [make({
      eventType: "compaction",
      actor: "system",
      status: type.endsWith("start") ? "partial" : harnessStatus(body.status),
      metadata: { phase: type.split("/")[1] ?? "unknown" },
    })] };
  }
  if (type === "subagent/start" || type === "agent/start") {
    return { raw, events: [make({
      eventType: "agent.invoke",
      actor: "agent",
      status: "partial",
      sourceStepId: firstString(body, ["agent_id", "agentId"]) ?? stepId,
      metadata: { agent_type: body.agent_type ?? body.agentType ?? null },
    })] };
  }
  if (type === "subagent/end" || type === "subagent/stop" || type === "agent/end") {
    return { raw, events: [make({
      eventType: "handoff",
      actor: "agent",
      status: harnessStatus(body.status),
      content: body.result === undefined ? [] : [contentPart(body.result)],
      sourceStepId: firstString(body, ["agent_id", "agentId"]) ?? stepId,
      metadata: { agent_type: body.agent_type ?? body.agentType ?? null },
    })] };
  }

  return { raw, events: [make({
    eventType: "model.inference",
    actor: "environment",
    status: "partial",
    metadata: { unsupported_event_shape: true },
  })] };
}

export function normalizeDeepSeekSessionJsonl(input: string, options: NormalizeOptions = {}): NormalizedBatch {
  const parsed = parseJsonLines(input);
  const raw = [] as NormalizedBatch["raw"];
  const events = [] as TrajectoryEvent[];
  let sessionId = options.sessionId ?? null;
  let turnId = options.turnId ?? null;
  for (const [sequence, value] of parsed.values.entries()) {
    const { event, body } = unwrap(value);
    sessionId = firstString(body, ["session_id", "sessionId"]) ?? firstString(event, ["session_id", "sessionId"]) ?? sessionId;
    turnId = firstString(body, ["turn_id", "turnId"]) ?? firstString(event, ["turn_id", "turnId"]) ?? turnId;
    const nextOptions: NormalizeOptions = { ...options, sequence };
    if (sessionId !== null) nextOptions.sessionId = sessionId;
    if (turnId !== null) nextOptions.turnId = turnId;
    const normalized = normalizeDeepSeekSessionEvent(value, nextOptions);
    raw.push(normalized.raw);
    events.push(...normalized.events);
  }
  return { raw, events: renumberEvents(events), diagnostics: parsed.diagnostics };
}
