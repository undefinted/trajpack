import type { ContentPart, TrajectoryEvent } from "@trajpack/schema";

import {
  OPAQUE_REASONING,
  PROVIDER_SUMMARY,
  contentPart,
  createEvent,
  createRawEnvelope,
  dedupeKey,
  firstString,
  isRecord,
  nestedRecord,
  parseJsonLines,
  renumberEvents,
  stringValue,
  usageFrom,
  type NormalizeOptions,
  type NormalizedBatch,
  type NormalizedCapture,
} from "./common.js";

export const CLAUDE_STREAM_INTERFACE = "claude-stream-json/1";
export const CLAUDE_HOOK_INTERFACE = "claude-hook/1";

type JsonObject = Record<string, unknown>;

function toolShape(callId: string | null, name: string | null, args: unknown, result: unknown) {
  return { call_id: callId, name, arguments: args ?? null, result: result ?? null, exit_code: null };
}

function claudeUsage(payload: JsonObject, message: JsonObject | null): Partial<TrajectoryEvent["usage"]> {
  const usage = usageFrom((message?.usage ?? payload.usage) as unknown);
  const cost = payload.total_cost_usd ?? payload.cost_usd;
  if (typeof cost === "number" && cost >= 0) usage.cost_usd = cost;
  const duration = payload.duration_ms;
  if (typeof duration === "number" && duration >= 0) usage.latency_ms = duration;
  return usage;
}

function messageBlocks(message: JsonObject): unknown[] {
  const content = message.content;
  if (Array.isArray(content)) return content;
  if (content === undefined || content === null) return [];
  return [{ type: "text", text: content }];
}

function normalizeAssistantBlocks(
  blocks: unknown[],
  raw: NormalizedCapture["raw"],
  options: NormalizeOptions,
  sourceEventId: string | null,
  sessionId: string | null,
  usage: Partial<TrajectoryEvent["usage"]>,
): TrajectoryEvent[] {
  const events: TrajectoryEvent[] = [];
  for (const [index, candidate] of blocks.entries()) {
    if (!isRecord(candidate)) continue;
    const type = firstString(candidate, ["type"]) ?? "unknown";
    const common = {
      block_type: type,
      dedupe_key: dedupeKey("claude", sessionId, sourceEventId, index, type),
    };
    const eventUsage = index === 0 ? usage : {};

    if (type === "text") {
      const text = firstString(candidate, ["text", "content"]);
      events.push(createEvent(raw, index, {
        eventType: "message",
        actor: "assistant",
        content: text === null ? [] : [contentPart(text)],
        sourceEventId,
        sourceSessionId: sessionId,
        usage: eventUsage,
        metadata: common,
      }, options));
      continue;
    }

    if (type === "thinking") {
      const thinking = firstString(candidate, ["thinking", "text", "summary"]);
      const reasoning = { ...PROVIDER_SUMMARY, source_field: candidate.summary === undefined ? "thinking" : "summary" };
      events.push(createEvent(raw, index, {
        eventType: "reasoning",
        actor: "assistant",
        content: thinking === null ? [] : [contentPart(thinking, 0, { type: "reasoning", reasoning })],
        sourceEventId,
        sourceSessionId: sessionId,
        usage: eventUsage,
        metadata: common,
      }, options));
      continue;
    }

    if (type === "redacted_thinking") {
      events.push(createEvent(raw, index, {
        eventType: "reasoning",
        actor: "assistant",
        content: [],
        sourceEventId,
        sourceSessionId: sessionId,
        usage: eventUsage,
        metadata: { ...common, reasoning: OPAQUE_REASONING, opaque_payload_sha256: raw.payload_sha256 },
      }, options));
      continue;
    }

    if (type === "tool_use") {
      const callId = firstString(candidate, ["id", "tool_use_id"]);
      const name = firstString(candidate, ["name", "tool_name"]);
      const input = candidate.input ?? null;
      events.push(createEvent(raw, index, {
        eventType: "tool.call",
        actor: "assistant",
        content: [contentPart(input, 0, { type: "tool_call" })],
        sourceEventId,
        sourceSessionId: sessionId,
        tool: toolShape(callId, name, input, null),
        usage: eventUsage,
        metadata: common,
      }, options));
      continue;
    }

    events.push(createEvent(raw, index, {
      eventType: "model.inference",
      actor: "assistant",
      status: "partial",
      content: [],
      sourceEventId,
      sourceSessionId: sessionId,
      usage: eventUsage,
      metadata: { ...common, unsupported_block_shape: true },
    }, options));
  }
  return events;
}

function normalizeUserBlocks(
  blocks: unknown[],
  raw: NormalizedCapture["raw"],
  options: NormalizeOptions,
  sourceEventId: string | null,
  sessionId: string | null,
): TrajectoryEvent[] {
  const events: TrajectoryEvent[] = [];
  for (const [index, candidate] of blocks.entries()) {
    if (typeof candidate === "string") {
      events.push(createEvent(raw, index, {
        eventType: "message",
        actor: "user",
        content: [contentPart(candidate)],
        sourceEventId,
        sourceSessionId: sessionId,
      }, options));
      continue;
    }
    if (!isRecord(candidate)) continue;
    const type = firstString(candidate, ["type"]) ?? "unknown";
    if (type === "tool_result") {
      const callId = firstString(candidate, ["tool_use_id", "call_id"]);
      const result = candidate.content ?? candidate.result ?? null;
      const isError = candidate.is_error === true;
      events.push(createEvent(raw, index, {
        eventType: "tool.result",
        actor: "tool",
        status: isError ? "error" : "ok",
        content: [contentPart(result, 0, { type: "tool_result" })],
        sourceEventId,
        sourceSessionId: sessionId,
        tool: toolShape(callId, null, null, result),
        metadata: { block_type: type, dedupe_key: dedupeKey("claude", sessionId, callId, "result") },
      }, options));
      continue;
    }
    const text = firstString(candidate, ["text", "content"]);
    if (text !== null) {
      events.push(createEvent(raw, index, {
        eventType: "message",
        actor: "user",
        content: [contentPart(text)],
        sourceEventId,
        sourceSessionId: sessionId,
        metadata: { block_type: type },
      }, options));
    }
  }
  return events;
}

function normalizeStreamDelta(
  payload: JsonObject,
  raw: NormalizedCapture["raw"],
  options: NormalizeOptions,
): TrajectoryEvent[] {
  const stream = nestedRecord(payload, "event");
  if (stream === null) return [];
  const streamType = firstString(stream, ["type"]) ?? "unknown";
  const delta = nestedRecord(stream, "delta") ?? {};
  const deltaType = firstString(delta, ["type"]) ?? "unknown";
  const sessionId = firstString(payload, ["session_id", "sessionId"]) ?? raw.session_id;
  const sourceEventId = firstString(stream, ["id", "event_id"]) ?? raw.source_event_id;
  const blockIndex = typeof stream.index === "number" ? stream.index : null;
  const metadata = { stream_type: streamType, delta_type: deltaType, block_index: blockIndex };

  if (streamType === "content_block_delta" && deltaType === "thinking_delta") {
    const thinking = firstString(delta, ["thinking", "text"]);
    const reasoning = { ...PROVIDER_SUMMARY, source_field: "thinking" };
    return [createEvent(raw, 0, {
      eventType: "reasoning",
      actor: "assistant",
      status: "partial",
      content: thinking === null ? [] : [contentPart(thinking, 0, { type: "reasoning", reasoning })],
      sourceEventId,
      sourceSessionId: sessionId,
      metadata,
    }, options)];
  }
  if (streamType === "content_block_delta" && deltaType === "text_delta") {
    const text = firstString(delta, ["text"]);
    return [createEvent(raw, 0, {
      eventType: "message",
      actor: "assistant",
      status: "partial",
      content: text === null ? [] : [contentPart(text)],
      sourceEventId,
      sourceSessionId: sessionId,
      metadata,
    }, options)];
  }
  if (streamType === "content_block_delta" && deltaType === "input_json_delta") {
    const partialJson = firstString(delta, ["partial_json"]);
    return [createEvent(raw, 0, {
      eventType: "tool.call",
      actor: "assistant",
      status: "partial",
      content: partialJson === null ? [] : [contentPart(partialJson, 0, { type: "tool_call", mimeType: "application/json" })],
      sourceEventId,
      sourceSessionId: sessionId,
      tool: toolShape(null, null, partialJson, null),
      metadata,
    }, options)];
  }

  return [createEvent(raw, 0, {
    eventType: "model.inference",
    actor: "assistant",
    status: "partial",
    sourceEventId,
    sourceSessionId: sessionId,
    usage: usageFrom(stream.usage ?? delta.usage),
    metadata: { ...metadata, unsupported_stream_event: true },
  }, options)];
}

export function normalizeClaudeStreamEvent(payload: unknown, options: NormalizeOptions = {}): NormalizedCapture {
  const raw = createRawEnvelope("claude_code", payload, options, CLAUDE_STREAM_INTERFACE);
  if (!isRecord(payload)) return { raw, events: [] };
  const type = firstString(payload, ["type"]) ?? "unknown";
  const sessionId = firstString(payload, ["session_id", "sessionId"]) ?? raw.session_id;

  if (type === "system") {
    return { raw, events: [createEvent(raw, 0, {
      eventType: "agent.invoke",
      actor: "agent",
      status: "partial",
      sourceSessionId: sessionId,
      metadata: {
        subtype: payload.subtype ?? null,
        model: payload.model ?? null,
        tools: Array.isArray(payload.tools) ? payload.tools : [],
        dedupe_key: dedupeKey("claude", sessionId, payload.subtype),
      },
    }, options)] };
  }

  if (type === "assistant" || type === "user") {
    const message = nestedRecord(payload, "message") ?? payload;
    const sourceEventId = firstString(message, ["id", "message_id"]) ?? raw.source_event_id;
    const blocks = messageBlocks(message);
    const events = type === "assistant"
      ? normalizeAssistantBlocks(blocks, raw, options, sourceEventId, sessionId, claudeUsage(payload, message))
      : normalizeUserBlocks(blocks, raw, options, sourceEventId, sessionId);
    return { raw, events };
  }

  if (type === "stream_event") return { raw, events: normalizeStreamDelta(payload, raw, options) };

  if (type === "result") {
    const subtype = firstString(payload, ["subtype", "status"]) ?? "unknown";
    const isCancelled = subtype === "cancelled" || subtype === "canceled" || subtype === "aborted";
    const isError = !isCancelled && (payload.is_error === true || subtype === "error" || subtype === "failed");
    const result = payload.result ?? payload.error ?? null;
    const retryCount = typeof payload.retry_count === "number" && Number.isInteger(payload.retry_count)
      ? payload.retry_count
      : null;
    return { raw, events: [createEvent(raw, 0, {
      eventType: isError ? "error" : "evaluation",
      actor: "environment",
      status: isCancelled ? "cancelled" : isError ? "error" : "ok",
      content: result === null ? [] : [contentPart(result, 0, { type: isError ? "stderr" : "text" })],
      sourceSessionId: sessionId,
      usage: claudeUsage(payload, null),
      metadata: {
        subtype: payload.subtype ?? null,
        retry: retryCount !== null && retryCount > 0,
        retry_count: retryCount,
        dedupe_key: dedupeKey("claude", sessionId, "result"),
      },
    }, options)] };
  }

  return { raw, events: [createEvent(raw, 0, {
    eventType: "model.inference",
    actor: "assistant",
    status: "partial",
    sourceSessionId: sessionId,
    metadata: { source_type: type, unsupported_event_shape: true },
  }, options)] };
}

export function normalizeClaudeStreamJson(input: string, options: NormalizeOptions = {}): NormalizedBatch {
  const parsed = parseJsonLines(input);
  const raw = [] as NormalizedBatch["raw"];
  const events = [] as TrajectoryEvent[];
  let sessionId = options.sessionId ?? null;
  for (const [sequence, value] of parsed.values.entries()) {
    sessionId = firstString(value, ["session_id", "sessionId"]) ?? sessionId;
    const nextOptions: NormalizeOptions = { ...options, sequence };
    if (sessionId !== null) nextOptions.sessionId = sessionId;
    const normalized = normalizeClaudeStreamEvent(value, nextOptions);
    raw.push(normalized.raw);
    events.push(...normalized.events);
  }
  return { raw, events: renumberEvents(events), diagnostics: parsed.diagnostics };
}

export function normalizeClaudeHook(payload: unknown, options: NormalizeOptions = {}): NormalizedCapture {
  const hookOptions: NormalizeOptions = { ...options, interfaceVersion: options.interfaceVersion ?? CLAUDE_HOOK_INTERFACE };
  const raw = createRawEnvelope("claude_code", payload, hookOptions, CLAUDE_HOOK_INTERFACE);
  if (!isRecord(payload)) return { raw, events: [] };
  const hook = firstString(payload, ["hook_event_name", "hookEventName"]) ?? "Unknown";
  const sessionId = firstString(payload, ["session_id", "sessionId"]) ?? raw.session_id;
  const toolName = firstString(payload, ["tool_name", "toolName"]);
  const callId = firstString(payload, ["tool_use_id", "toolUseId"]);
  const baseMetadata = {
    hook_event_name: hook,
    permission_mode: stringValue(payload.permission_mode),
    dedupe_key: dedupeKey("claude-hook", sessionId, hook, callId),
  };
  const make = (input: Parameters<typeof createEvent>[2]) => createEvent(raw, 0, {
    ...input,
    sourceSessionId: sessionId,
    sourceTurnId: firstString(payload, ["turn_id", "turnId"]),
    metadata: { ...baseMetadata, ...input.metadata },
  }, hookOptions);

  if (hook === "UserPromptSubmit") {
    return { raw, events: [make({ eventType: "message", actor: "user", content: [contentPart(payload.prompt ?? "")] })] };
  }
  if (hook === "PreToolUse") {
    return { raw, events: [make({
      eventType: "tool.call",
      actor: "assistant",
      status: "partial",
      content: [contentPart(payload.tool_input ?? null, 0, { type: "tool_call" })],
      tool: toolShape(callId, toolName, payload.tool_input, null),
    })] };
  }
  if (hook === "PostToolUse" || hook === "PostToolUseFailure") {
    const result = payload.tool_response ?? payload.tool_result ?? payload.error ?? null;
    return { raw, events: [make({
      eventType: "tool.result",
      actor: "tool",
      status: hook === "PostToolUseFailure" ? "error" : "ok",
      content: [contentPart(result, 0, { type: "tool_result" })],
      tool: toolShape(callId, toolName, payload.tool_input, result),
    })] };
  }
  if (hook === "PermissionRequest") {
    const decision = firstString(payload, ["decision", "permission_decision", "permissionDecision"]);
    const denied = decision === "deny" || decision === "denied" || decision === "reject" || decision === "rejected";
    if (decision !== null) {
      return { raw, events: [make({
        eventType: "approval.decision",
        actor: "user",
        status: denied ? "cancelled" : "ok",
        content: [contentPart({ decision, tool_name: toolName, tool_input: payload.tool_input })],
        tool: toolShape(callId, toolName, payload.tool_input, null),
        metadata: { approval_decision: decision },
      })] };
    }
    return { raw, events: [make({
      eventType: "approval.request",
      actor: "environment",
      content: [contentPart({ tool_name: toolName, tool_input: payload.tool_input })],
      tool: toolShape(callId, toolName, payload.tool_input, null),
    })] };
  }
  if (hook === "PreCompact") {
    return { raw, events: [make({
      eventType: "compaction",
      actor: "system",
      status: "partial",
      metadata: { trigger: payload.trigger ?? payload.source ?? null },
    })] };
  }
  if (hook === "SubagentStart") {
    return { raw, events: [make({
      eventType: "agent.invoke",
      actor: "agent",
      status: "partial",
      sourceStepId: firstString(payload, ["agent_id", "agentId"]),
      metadata: { agent_type: payload.agent_type ?? null },
    })] };
  }
  if (hook === "SubagentStop") {
    const result = payload.last_assistant_message ?? payload.result ?? null;
    const status = firstString(payload, ["status", "reason"]);
    return { raw, events: [make({
      eventType: "handoff",
      actor: "agent",
      status: status === "cancelled" || status === "canceled" || status === "aborted"
        ? "cancelled"
        : status === "failed" || status === "error"
          ? "error"
          : "ok",
      content: result === null ? [] : [contentPart(result)],
      sourceStepId: firstString(payload, ["agent_id", "agentId"]),
      metadata: { agent_type: payload.agent_type ?? null },
    })] };
  }
  if (hook === "Stop") {
    const result = payload.last_assistant_message ?? null;
    return { raw, events: [make({
      eventType: "message",
      actor: "assistant",
      content: result === null ? [] : [contentPart(result)],
    })] };
  }
  if (hook === "SessionStart" || hook === "SessionEnd" || hook === "TaskCompleted") {
    const completed = hook !== "SessionStart";
    return { raw, events: [make({
      eventType: completed ? "evaluation" : "agent.invoke",
      actor: completed ? "environment" : "agent",
      status: completed ? "ok" : "partial",
      metadata: { source: payload.source ?? null, reason: payload.reason ?? null },
    })] };
  }

  return { raw, events: [make({
    eventType: "model.inference",
    actor: "environment",
    status: "partial",
    metadata: { unsupported_hook_shape: true },
  })] };
}
