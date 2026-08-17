import type { ReasoningMetadata, TrajectoryEvent } from "@trajpack/schema";

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
  sha256,
  usageFrom,
  type NormalizeOptions,
  type NormalizedBatch,
  type NormalizedCapture,
} from "./common.js";

export const DEEPSEEK_HARNESS_INTERFACE_VERSION = "deepseek-harness@0.1.0-rc.6/session-event/0";
export const DEEPSEEK_HARNESS_SESSION_FORMAT_VERSION = 0;

type JsonObject = Record<string, unknown>;

interface Capsule {
  payload: JsonObject;
  event: JsonObject;
  data: JsonObject;
  header: JsonObject;
  route: JsonObject | null;
  sessionId: string;
  turnId: string | null;
  stepId: string | null;
  sourceEventId: string;
  type: string;
}

export const DEEPSEEK_HARNESS_DURABLE_EVENT_TYPES = [
  "turn/start", "turn/end", "step/start", "step/end", "user/message",
  "assistant/chunk", "assistant/message", "tool/call", "tool/result",
  "request/header", "request/context", "session/end-seed", "todo/write",
  "agent-preset/selected", "agent/inbox/spliced", "approval/asked", "approval/decided",
  "approval/policy", "command/done", "command/run", "compaction/end", "compaction/prune",
  "compaction/start", "compaction/summary", "feedback/record", "goal/change", "hook/invoked",
  "hook/result", "llm/retry", "llm/retry-started", "permission/preset", "plan/mode",
  "sandbox/mode", "schedule/change", "session/title", "session/title-llm-request",
  "subagent/descriptor", "tool-workflow/agent-end", "tool-workflow/agent-start",
  "tool-workflow/run-end", "tool-workflow/run-start", "tool/code-dispatch",
  "tool/code-dispatch-start", "web/deepseek-search-llm-request",
] as const;

const DURABLE_EVENTS = new Set<string>(DEEPSEEK_HARNESS_DURABLE_EVENT_TYPES);

function validNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function capsule(payload: unknown): Capsule | null {
  if (!isRecord(payload)) return null;
  const header = nestedRecord(payload, "session_header");
  const event = nestedRecord(payload, "event");
  const data = event === null ? null : nestedRecord(event, "data");
  const sessionId = firstString(payload, ["session_id"]);
  const headerId = header === null ? null : firstString(header, ["id"]);
  const type = event === null ? null : firstString(event, ["type"]);
  if (
    header === null || event === null || data === null || sessionId === null || headerId !== sessionId ||
    header.version !== DEEPSEEK_HARNESS_SESSION_FORMAT_VERSION || type === null ||
    !Number.isSafeInteger(event.seq) || (event.seq as number) < 0 || !validNumber(event.time) ||
    (event.ignorable !== undefined && event.ignorable !== true)
  ) return null;

  const route = nestedRecord(payload, "route");
  const turnId = firstString(data, ["turn"]);
  const stepId = firstString(data, ["step"]);
  return {
    payload,
    event,
    data,
    header,
    route,
    sessionId,
    turnId,
    stepId,
    sourceEventId: firstString(payload, ["event_id"]) ?? `${sessionId}:${String(event.seq)}`,
    type,
  };
}

function routeFromMessage(message: JsonObject, fallback: JsonObject | null): JsonObject | null {
  const source = nestedRecord(message, "source");
  return source?.kind === "model" ? source : fallback;
}

function routeMetadata(route: JsonObject | null): Record<string, unknown> {
  return {
    provider_route: route === null ? null : firstString(route, ["provider"]),
    model: route === null ? null : firstString(route, ["model"]),
  };
}

function surfaceMetadata(event: JsonObject): Record<string, unknown> {
  const sourceEventSeqs = Array.isArray(event.sourceEventSeqs)
    ? event.sourceEventSeqs.filter((value): value is number => Number.isSafeInteger(value) && value >= 0)
    : null;
  return {
    surface_op: event.surfaceOp ?? null,
    source_event_seqs: sourceEventSeqs,
  };
}

function reasoningMetadata(route: JsonObject | null, sourceField: string): ReasoningMetadata {
  const provider = route === null ? null : firstString(route, ["provider"]);
  const normalizedProvider = provider?.toLowerCase() ?? null;
  // Provider labels are a closed routing contract, not a fuzzy brand search.
  // A proxy name such as `openai-deepseek-proxy` must not upgrade opaque
  // reasoning into DeepSeek provider-exposed supervision.
  if (normalizedProvider === "deepseek" || normalizedProvider?.startsWith("deepseek-") === true) {
    return { ...PROVIDER_EXPOSED_REASONING, source_field: sourceField };
  }
  return {
    representation: "opaque_reasoning_state",
    provider_claim: "none",
    source_field: sourceField,
    visibility: "api_only",
    include_in_loss: false,
  };
}

function statusFromReason(value: unknown): TrajectoryEvent["status"] {
  const reason = isRecord(value) ? firstString(value, ["kind"]) : firstString({ value }, ["value"]);
  if (reason === "aborted" || reason === "interrupted") return "cancelled";
  if (reason === "error" || reason === "blocked" || reason === "max-tokens") return "error";
  return "ok";
}

function tool(callId: string | null, name: string | null, args: unknown, result: unknown) {
  return { call_id: callId, name, arguments: args ?? null, result: result ?? null, exit_code: null };
}

function messageContentEvents(
  info: Capsule,
  message: JsonObject,
  raw: NormalizedCapture["raw"],
  options: NormalizeOptions,
  usage: unknown,
): TrajectoryEvent[] {
  const blocks = Array.isArray(message.content) ? message.content : [];
  const route = routeFromMessage(message, info.route);
  const events: TrajectoryEvent[] = [];
  for (const [index, value] of blocks.entries()) {
    if (!isRecord(value)) continue;
    const blockType = firstString(value, ["type"]);
    const common = {
      ...routeMetadata(route),
      ...surfaceMetadata(info.event),
      durable_event_type: info.type,
      harness_seq: info.event.seq,
      block_type: blockType,
      message_id: firstString(message, ["id"]),
      dedupe_key: dedupeKey("dsh", info.sessionId, info.event.seq, index),
    };
    const base = {
      sourceEventId: info.sourceEventId,
      sourceSessionId: info.sessionId,
      sourceTurnId: info.turnId,
      sourceStepId: info.stepId,
      usage: index === 0 ? usageFrom(usage) : {},
      metadata: common,
    };
    if (blockType === "reasoning") {
      const text = firstString(value, ["text"]);
      events.push(createEvent(raw, index, {
        ...base,
        eventType: "reasoning",
        actor: "assistant",
        content: text === null ? [] : [contentPart(text, 0, {
          type: "reasoning",
          reasoning: reasoningMetadata(route, "message.content[].reasoning"),
        })],
      }, options));
    } else if (blockType === "tool-call") {
      const callId = firstString(value, ["id"]);
      const name = firstString(value, ["name"]);
      const args = value.arguments ?? null;
      events.push(createEvent(raw, index, {
        ...base,
        eventType: "tool.call",
        actor: "assistant",
        status: "partial",
        content: [contentPart(args, 0, { type: "tool_call" })],
        tool: tool(callId, name, args, null),
      }, options));
    } else if (blockType === "tool-result") {
      const callId = firstString(value, ["toolCallId"]);
      const result = value.content ?? null;
      events.push(createEvent(raw, index, {
        ...base,
        eventType: "tool.result",
        actor: "tool",
        status: value.isError === true ? "error" : "ok",
        content: [contentPart(result, 0, { type: "tool_result" })],
        tool: tool(callId, null, null, result),
      }, options));
    } else if (blockType === "image") {
      events.push(createEvent(raw, index, {
        ...base,
        eventType: "message",
        actor: message.role === "user" ? "user" : "assistant",
        content: [contentPart(value.attachment ?? value, 0, { type: "image_ref" })],
      }, options));
    } else if (blockType === "text") {
      const text = firstString(value, ["text"]);
      events.push(createEvent(raw, index, {
        ...base,
        eventType: "message",
        actor: message.role === "user" ? "user" : "assistant",
        content: text === null ? [] : [contentPart(text)],
      }, options));
    }
  }
  return events;
}

function chunkEvents(
  info: Capsule,
  raw: NormalizedCapture["raw"],
  options: NormalizeOptions,
): TrajectoryEvent[] {
  const chunk = nestedRecord(info.data, "chunk");
  if (chunk === null) return [];
  const type = firstString(chunk, ["type"]);
  const common = {
    ...routeMetadata(info.route),
    durable_event_type: info.type,
    harness_seq: info.event.seq,
    chunk_type: type,
    chunk_index: chunk.index ?? null,
  };
  const base = {
    sourceEventId: info.sourceEventId,
    sourceSessionId: info.sessionId,
    sourceTurnId: info.turnId,
    sourceStepId: info.stepId,
    status: "partial" as const,
    metadata: common,
  };
  if (type === "reasoning-delta") {
    const text = firstString(chunk, ["text"]);
    return [createEvent(raw, 0, {
      ...base,
      eventType: "reasoning",
      actor: "assistant",
      content: text === null ? [] : [contentPart(text, 0, {
        type: "reasoning",
        reasoning: reasoningMetadata(info.route, "chunk.reasoning-delta"),
      })],
    }, options)];
  }
  if (type === "text-delta") {
    const text = firstString(chunk, ["text"]);
    return [createEvent(raw, 0, {
      ...base,
      eventType: "message",
      actor: "assistant",
      content: text === null ? [] : [contentPart(text)],
    }, options)];
  }
  if (type === "tool-call-delta") {
    const callId = firstString(chunk, ["id"]);
    const name = firstString(chunk, ["name"]);
    const args = chunk.argumentsDelta ?? null;
    return [createEvent(raw, 0, {
      ...base,
      eventType: "tool.call",
      actor: "assistant",
      content: [contentPart(args, 0, { type: "tool_call" })],
      tool: tool(callId, name, args, null),
    }, options)];
  }
  if (type === "usage") {
    return [createEvent(raw, 0, {
      ...base,
      eventType: "model.inference",
      actor: "assistant",
      usage: usageFrom(chunk.usage),
    }, options)];
  }
  if (type === "finish") {
    const reason = nestedRecord(chunk, "reason");
    return [createEvent(raw, 0, {
      ...base,
      eventType: "evaluation",
      actor: "environment",
      status: statusFromReason(reason),
      content: reason === null ? [] : [contentPart(reason)],
    }, options)];
  }
  // block-start/end are already represented by deltas and assistant/message.
  return [];
}

export function normalizeDeepSeekSessionEvent(payload: unknown, options: NormalizeOptions = {}): NormalizedCapture {
  const raw = createRawEnvelope(
    "deepseek_harness",
    payload,
    options,
    DEEPSEEK_HARNESS_INTERFACE_VERSION,
  );
  if (options.interfaceVersion !== undefined && options.interfaceVersion !== DEEPSEEK_HARNESS_INTERFACE_VERSION) {
    return { raw, events: [] };
  }
  const info = capsule(payload);
  if (info === null) return { raw, events: [] };

  const metadata = {
    ...routeMetadata(info.route),
    ...surfaceMetadata(info.event),
    durable_event_type: info.type,
    session_format_version: info.header.version,
    harness_seq: info.event.seq,
    source_event_ignorable: info.event.ignorable === true,
    parent_session_id: firstString(info.header, ["parent_session"]),
    session_origin: firstString(info.header, ["origin"]),
    delegation_depth: info.header.delegation_depth ?? null,
    agent_preset: firstString(info.header, ["agent_preset"]),
    dedupe_key: dedupeKey("dsh", info.sessionId, info.event.seq),
  };
  const make = (index: number, input: Parameters<typeof createEvent>[2]) => createEvent(raw, index, {
    ...input,
    sourceEventId: info.sourceEventId,
    sourceSessionId: info.sessionId,
    sourceTurnId: info.turnId,
    sourceStepId: input.sourceStepId ?? info.stepId,
    metadata: { ...metadata, ...input.metadata },
  }, options);
  const opaqueDurableEvent = () => make(0, {
    eventType: "evaluation",
    actor: "environment",
    status: "partial",
    metadata: {
      opaque_durable_event: true,
      training_semantics_available: false,
    },
  });

  // The rc.6 SessionEventMap is merge-extensible. An extension may add a
  // durable informational record only when it explicitly marks it ignorable;
  // retain that record as opaque canonical evidence so a valid capture is not
  // destroyed. Unknown required records still return no projection and make
  // CaptureSession fail closed at finalization.
  if (!DURABLE_EVENTS.has(info.type)) {
    return { raw, events: info.event.ignorable === true ? [opaqueDurableEvent()] : [] };
  }

  if (info.type === "assistant/chunk") {
    const events = chunkEvents(info, raw, options);
    return { raw, events: events.length > 0 ? events : [opaqueDurableEvent()] };
  }
  if (info.type === "assistant/message") {
    const message = nestedRecord(info.data, "message");
    if (message === null) return { raw, events: [] };
    const events = messageContentEvents(info, message, raw, options, info.data.usage);
    return { raw, events: events.length > 0 ? events : [opaqueDurableEvent()] };
  }
  if (info.type === "user/message") {
    const events = messageContentEvents(info, info.data, raw, options, null);
    return { raw, events: events.length > 0 ? events : [opaqueDurableEvent()] };
  }
  if (info.type === "tool/call") {
    const callId = firstString(info.data, ["callId"]);
    const name = firstString(info.data, ["name"]);
    const args = info.data.arguments ?? null;
    return { raw, events: [make(0, {
      eventType: "tool.call", actor: "assistant", status: "partial",
      content: [contentPart(args, 0, { type: "tool_call" })],
      tool: tool(callId, name, args, null),
      metadata: { dedupe_key: dedupeKey("dsh-tool", info.sessionId, callId, "call") },
    })] };
  }
  if (info.type === "tool/result") {
    const message = nestedRecord(info.data, "message");
    const blocks = message !== null && Array.isArray(message.content) ? message.content : [];
    const resultBlock = blocks.find((value) => isRecord(value) && value.type === "tool-result");
    const block = isRecord(resultBlock) ? resultBlock : null;
    const callId = block === null
      ? (message === null ? null : firstString(nestedRecord(message, "source") ?? {}, ["callId"]))
      : firstString(block, ["toolCallId"]);
    const result = block?.content ?? null;
    const failed = info.data.error !== undefined || block?.isError === true;
    return { raw, events: [make(0, {
      eventType: "tool.result", actor: "tool", status: failed ? "error" : "ok",
      content: [contentPart(result, 0, { type: "tool_result" })],
      tool: tool(callId, null, null, result),
      metadata: { error: info.data.error ?? null, tool_meta: info.data.meta ?? null,
        dedupe_key: dedupeKey("dsh-tool", info.sessionId, callId, "result") },
    })] };
  }
  if (info.type === "turn/start" || info.type === "step/start") {
    return { raw, events: [make(0, {
      eventType: info.type === "turn/start" ? "agent.invoke" : "model.inference",
      actor: info.type === "turn/start" ? "agent" : "assistant",
      status: "partial",
    })] };
  }
  if (info.type === "turn/end") {
    return { raw, events: [make(0, {
      eventType: "evaluation", actor: "environment", status: statusFromReason(info.data.reason),
      content: info.data.reason === undefined ? [] : [contentPart(info.data.reason)],
      metadata: { turn_end_kind: isRecord(info.data.reason) ? firstString(info.data.reason, ["kind"]) : null },
    })] };
  }
  if (info.type === "step/end") {
    return { raw, events: [make(0, { eventType: "evaluation", actor: "environment" })] };
  }
  if (info.type === "approval/asked") {
    return { raw, events: [make(0, {
      eventType: "approval.request", actor: "environment",
      content: [contentPart({ tool_name: info.data.toolName ?? null, reason: info.data.reason ?? null })],
      metadata: { approval_id: info.data.id ?? null, call_id: info.data.callId ?? null },
    })] };
  }
  if (info.type === "approval/decided") {
    const outcome = info.data.outcome;
    const outcomeKind = isRecord(outcome) ? firstString(outcome, ["kind", "decision"]) : firstString({ outcome }, ["outcome"]);
    const denied = outcomeKind !== null && ["deny", "denied", "reject", "rejected", "abort", "cancel"].includes(outcomeKind.toLowerCase());
    return { raw, events: [make(0, {
      eventType: "approval.decision", actor: "user", status: denied ? "cancelled" : "ok",
      content: [contentPart(outcome ?? null)],
      metadata: { approval_id: info.data.id ?? null, approval_decision: outcomeKind ?? outcome ?? null },
    })] };
  }
  if (info.type.startsWith("compaction/")) {
    return { raw, events: [make(0, {
      eventType: "compaction", actor: "system",
      status: info.type === "compaction/start" ? "partial" : "ok",
      content: info.type === "compaction/summary" ? [contentPart(info.data)] : [],
      metadata: { phase: info.type.slice("compaction/".length) },
    })] };
  }
  if (info.type === "llm/retry" || info.type === "llm/retry-started") {
    return { raw, events: [make(0, {
      eventType: "model.inference", actor: "assistant", status: "partial",
      content: info.data.reason === undefined ? [] : [contentPart(info.data.reason)],
      metadata: {
        ...info.data,
        retry: true,
        retry_attempt: info.data.retry ?? null,
        retry_phase: info.type.slice("llm/".length),
      },
    })] };
  }
  if (info.type === "request/header") {
    const header = nestedRecord(info.data, "header");
    const config = header === null ? null : nestedRecord(header, "config");
    const tools = header !== null && Array.isArray(header.tools) ? header.tools : [];
    const requestContent: TrajectoryEvent["content"] = [];
    const contentRoles: Array<{ ordinal: number; role: "system" | "tool_schema" }> = [];
    if (typeof header?.system === "string") {
      requestContent.push(contentPart(header.system, requestContent.length, {
        type: "text",
        mimeType: "text/plain; role=system",
      }));
      contentRoles.push({ ordinal: requestContent.length - 1, role: "system" });
    }
    for (const toolSchema of tools) {
      if (!isRecord(toolSchema)) continue;
      requestContent.push(contentPart(toolSchema, requestContent.length, {
        type: "file_ref",
        mimeType: "application/vnd.trajpack.tool-schema+json",
      }));
      contentRoles.push({ ordinal: requestContent.length - 1, role: "tool_schema" });
    }
    return { raw, events: [make(0, {
      eventType: "model.inference", actor: "assistant", status: "partial",
      content: requestContent,
      metadata: {
        request_header_reason: info.data.reason ?? null,
        provider_route: config === null ? null : firstString(config, ["provider"]),
        model: config === null ? null : firstString(config, ["model"]),
        reasoning_effort: config?.reasoningEffort ?? null,
        tool_schema_count: tools.length,
        request_config: config,
        adapter_defaults: header === null ? null : nestedRecord(header, "adapterDefaults"),
        request_content_roles: contentRoles,
        request_header_sha256: header === null ? null : sha256(header),
      },
    })] };
  }
  if (info.type === "request/context") {
    return { raw, events: [make(0, {
      eventType: "model.inference", actor: "environment", status: "partial",
      metadata: { provider_route: info.data.provider ?? null, model: info.data.model ?? null,
        context_window: info.data.contextWindow ?? null },
    })] };
  }
  if (info.type === "subagent/descriptor") {
    if (info.data.version !== 2) return { raw, events: [] };
    return { raw, events: [make(0, {
      eventType: "agent.invoke", actor: "agent", status: "partial",
      sourceStepId: info.sessionId,
      content: info.data.label === undefined ? [] : [contentPart(info.data.label)],
      metadata: { descriptor_version: 2, subagent_mode: info.data.mode ?? null,
        subagent_provider: info.data.provider ?? null, agent_provider: info.data.agentProvider ?? null,
        agent_model: info.data.agentModel ?? null },
    })] };
  }
  if (info.type === "tool-workflow/agent-start" || info.type === "tool-workflow/agent-end") {
    return { raw, events: [make(0, {
      eventType: info.type.endsWith("start") ? "agent.invoke" : "handoff", actor: "agent",
      status: info.type.endsWith("start") ? "partial" : "ok",
      sourceStepId: firstString(info.data, ["agentId", "id"]) ?? info.stepId,
      content: info.data.result === undefined ? [] : [contentPart(info.data.result)],
    })] };
  }
  if (info.type === "feedback/record") {
    return { raw, events: [make(0, { eventType: "feedback", actor: "user", content: [contentPart(info.data)] })] };
  }
  if (info.type === "todo/write" || info.type === "plan/mode" || info.type === "goal/change") {
    return { raw, events: [make(0, { eventType: "plan", actor: "agent", content: [contentPart(info.data)] })] };
  }

  // A known rc.6 durable record with no faithful typed projection still needs
  // a canonical marker so capture can retain its topology without inventing
  // content or training semantics. Unknown required records were rejected
  // before this point; the live capture publisher treats that empty projection
  // as a hard compatibility failure instead of publishing a partial trace.
  return { raw, events: [opaqueDurableEvent()] };
}

export function normalizeDeepSeekSessionJsonl(input: string, options: NormalizeOptions = {}): NormalizedBatch {
  const parsed = parseJsonLines(input);
  const raw: NormalizedBatch["raw"] = [];
  const events: TrajectoryEvent[] = [];
  const lastSeqBySession = new Map<string, number>();
  const discontinuousSessions = new Set<string>();
  for (const [sequence, value] of parsed.values.entries()) {
    const info = capsule(value);
    let refuseProjection = false;
    if (info !== null) {
      const sourceSeq = info.event.seq as number;
      const previous = lastSeqBySession.get(info.sessionId);
      // Session persistence v0 guarantees contiguous sequences. Refuse this and
      // all later records from a discontinuous branch instead of reconstructing
      // a misleading partial trajectory. Raw preservation remains lossless.
      if (discontinuousSessions.has(info.sessionId) ||
        (previous === undefined ? sourceSeq !== 0 : sourceSeq !== previous + 1)) {
        discontinuousSessions.add(info.sessionId);
        refuseProjection = true;
      }
      lastSeqBySession.set(info.sessionId, sourceSeq);
    }
    const normalized = normalizeDeepSeekSessionEvent(value, { ...options, sequence });
    raw.push(normalized.raw);
    if (!refuseProjection) events.push(...normalized.events);
  }
  return { raw, events: renumberEvents(events), diagnostics: parsed.diagnostics };
}
