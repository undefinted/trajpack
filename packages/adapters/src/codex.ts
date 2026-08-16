import type { ContentPart, RawEnvelope, ReasoningMetadata, TrajectoryEvent } from "@trajpack/schema";

import {
  PROVIDER_SUMMARY,
  OPAQUE_REASONING,
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
  stringValue,
  usageFrom,
  type NormalizeOptions,
  type NormalizedBatch,
  type NormalizedCapture,
} from "./common.js";

export const CODEX_JSONL_INTERFACE_VERSION = "codex-exec-jsonl/1";
export const CODEX_HOOK_INTERFACE_VERSION = "codex-hook/1";
export const CODEX_APP_SERVER_INTERFACE_VERSION = "codex-app-server-v2-jsonrpc/1";

type JsonObject = Record<string, unknown>;

function textFrom(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (isRecord(entry)) return firstString(entry, ["text", "summary", "content"]);
        return null;
      })
      .filter((entry): entry is string => entry !== null);
    return parts.length > 0 ? parts.join("\n") : null;
  }
  if (isRecord(value)) return firstString(value, ["text", "summary", "content"]);
  return null;
}

function codexStatus(value: unknown, exitCode: unknown): TrajectoryEvent["status"] {
  if (typeof exitCode === "number" && exitCode !== 0) return "error";
  if (value === "failed" || value === "error") return "error";
  if (
    value === "cancelled" || value === "canceled" || value === "aborted" || value === "interrupted" ||
    value === "declined"
  ) return "cancelled";
  if (
    value === "in_progress" || value === "inProgress" || value === "running" || value === "started"
  ) return "partial";
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

function itemEvents(payload: JsonObject, raw: NormalizedCapture["raw"], options: NormalizeOptions): TrajectoryEvent[] {
  const item = nestedRecord(payload, "item");
  if (item === null) return [];

  const sourceType = firstString(item, ["type"]) ?? "unknown";
  const lifecycle = firstString(payload, ["type"]) ?? "item.unknown";
  const itemId = firstString(item, ["id", "item_id", "call_id"]);
  const sourceEventId = firstString(payload, ["event_id", "id"]) ?? itemId;
  const sessionId = firstString(payload, ["thread_id", "session_id"]) ?? raw.session_id;
  const turnId = firstString(payload, ["turn_id"]) ?? raw.turn_id;
  const commonMetadata = {
    source_type: sourceType,
    lifecycle,
    dedupe_key: dedupeKey("codex", sessionId, turnId, itemId, lifecycle),
  };

  if (sourceType === "agent_message") {
    const text = textFrom(item.text ?? item.content ?? item.message);
    return [
      createEvent(raw, 0, {
        eventType: "message",
        actor: "assistant",
        status: codexStatus(item.status, null),
        content: text === null ? [] : [contentPart(text)],
        sourceEventId,
        sourceSessionId: sessionId,
        sourceTurnId: turnId,
        metadata: commonMetadata,
      }, options),
    ];
  }

  if (sourceType === "reasoning") {
    const summary = textFrom(item.summary ?? item.text ?? item.content);
    const reasoning = {
      ...PROVIDER_SUMMARY,
      source_field: item.summary === undefined ? "text" : "summary",
    };
    return [
      createEvent(raw, 0, {
        eventType: "reasoning",
        actor: "assistant",
        status: codexStatus(item.status, null),
        content: summary === null ? [] : [contentPart(summary, 0, { type: "reasoning", reasoning })],
        sourceEventId,
        sourceSessionId: sessionId,
        sourceTurnId: turnId,
        metadata: commonMetadata,
      }, options),
    ];
  }

  if (sourceType === "command_execution") {
    const command = item.command ?? item.commands ?? null;
    const output = item.aggregated_output ?? item.output ?? item.stderr ?? null;
    const exitCode = item.exit_code ?? item.exitCode;
    const completed = lifecycle === "item.completed" || lifecycle === "item.failed";
    const callId = itemId;
    const content: ContentPart[] = [];
    if (completed && output !== null && output !== undefined) {
      content.push(contentPart(output, 0, { type: item.stderr !== undefined ? "stderr" : "stdout" }));
    } else if (command !== null) {
      content.push(contentPart(command, 0, { type: "tool_call" }));
    }
    return [
      createEvent(raw, 0, {
        eventType: completed ? "tool.result" : "tool.call",
        actor: completed ? "tool" : "assistant",
        status: codexStatus(item.status, exitCode),
        content,
        sourceEventId,
        sourceSessionId: sessionId,
        sourceTurnId: turnId,
        tool: toolShape(callId, "Bash", { command }, completed ? output : null, exitCode),
        metadata: commonMetadata,
      }, options),
    ];
  }

  if (sourceType === "mcp_tool_call" || sourceType === "function_call" || sourceType === "tool_call") {
    const callId = firstString(item, ["call_id", "id"]);
    const name = firstString(item, ["tool", "name", "tool_name"]);
    const args = item.arguments ?? item.input ?? null;
    const result = item.result ?? item.output ?? item.error ?? null;
    const completed = lifecycle === "item.completed" || lifecycle === "item.failed";
    return [
      createEvent(raw, 0, {
        eventType: completed ? "tool.result" : "tool.call",
        actor: completed ? "tool" : "assistant",
        status: codexStatus(item.status, item.exit_code),
        content: [contentPart(completed ? result : args, 0, { type: completed ? "tool_result" : "tool_call" })],
        sourceEventId,
        sourceSessionId: sessionId,
        sourceTurnId: turnId,
        tool: toolShape(callId, name, args, completed ? result : null, item.exit_code),
        metadata: commonMetadata,
      }, options),
    ];
  }

  if (sourceType === "file_change" || sourceType === "file_changes") {
    const patch = item.patch ?? item.changes ?? item.diff ?? item;
    return [
      createEvent(raw, 0, {
        eventType: "artifact.patch",
        actor: "assistant",
        status: codexStatus(item.status, null),
        content: [contentPart(patch, 0, { type: "patch", mimeType: "text/x-diff" })],
        sourceEventId,
        sourceSessionId: sessionId,
        sourceTurnId: turnId,
        metadata: commonMetadata,
      }, options),
    ];
  }

  if (sourceType === "web_search") {
    return [
      createEvent(raw, 0, {
        eventType: "retrieval",
        actor: "assistant",
        status: codexStatus(item.status, null),
        content: [contentPart(item.query ?? item.results ?? item)],
        sourceEventId,
        sourceSessionId: sessionId,
        sourceTurnId: turnId,
        metadata: commonMetadata,
      }, options),
    ];
  }

  if (sourceType === "todo_list" || sourceType === "plan") {
    return [
      createEvent(raw, 0, {
        eventType: "plan",
        actor: "assistant",
        status: codexStatus(item.status, null),
        content: [contentPart(item.items ?? item.text ?? item)],
        sourceEventId,
        sourceSessionId: sessionId,
        sourceTurnId: turnId,
        metadata: commonMetadata,
      }, options),
    ];
  }

  return [
    createEvent(raw, 0, {
      eventType: lifecycle === "item.failed" ? "error" : "model.inference",
      actor: "assistant",
      status: lifecycle === "item.failed" ? "error" : codexStatus(item.status, null),
      content: [contentPart(item)],
      sourceEventId,
      sourceSessionId: sessionId,
      sourceTurnId: turnId,
      metadata: { ...commonMetadata, unsupported_item_shape: true },
    }, options),
  ];
}

export function normalizeCodexJsonEvent(payload: unknown, options: NormalizeOptions = {}): NormalizedCapture {
  const raw = createRawEnvelope("codex", payload, options, CODEX_JSONL_INTERFACE_VERSION);
  if (!isRecord(payload)) return { raw, events: [] };
  const type = firstString(payload, ["type"]) ?? "unknown";

  if (type.startsWith("item.")) return { raw, events: itemEvents(payload, raw, options) };

  if (type === "thread.started") {
    const sessionId = firstString(payload, ["thread_id", "session_id"]);
    return {
      raw,
      events: [createEvent(raw, 0, {
        eventType: "agent.invoke",
        actor: "agent",
        sourceSessionId: sessionId,
        metadata: { lifecycle: type, dedupe_key: dedupeKey("codex", sessionId, type) },
      }, options)],
    };
  }

  if (type === "turn.started" || type === "turn.completed" || type === "turn.failed") {
    const completed = type !== "turn.started";
    return {
      raw,
      events: [createEvent(raw, 0, {
        eventType: completed ? (type === "turn.failed" ? "error" : "evaluation") : "model.inference",
        actor: completed ? "environment" : "assistant",
        status: type === "turn.started" ? "partial" : type === "turn.failed" ? "error" : "ok",
        sourceTurnId: firstString(payload, ["turn_id"]),
        usage: usageFrom(payload.usage),
        metadata: { lifecycle: type, dedupe_key: dedupeKey("codex", raw.session_id, raw.turn_id, type) },
      }, options)],
    };
  }

  if (type === "error") {
    const message = payload.message ?? payload.error ?? "Codex event error";
    return {
      raw,
      events: [createEvent(raw, 0, {
        eventType: "error",
        actor: "environment",
        status: "error",
        content: [contentPart(message, 0, { type: "stderr" })],
        metadata: { lifecycle: type },
      }, options)],
    };
  }

  return {
    raw,
    events: [createEvent(raw, 0, {
      eventType: "model.inference",
      actor: "assistant",
      status: "partial",
      content: [],
      metadata: { lifecycle: type, unsupported_event_shape: true, payload_preview_hash: raw.payload_sha256 },
    }, options)],
  };
}

export function normalizeCodexJsonl(input: string, options: NormalizeOptions = {}): NormalizedBatch {
  const parsed = parseJsonLines(input);
  const raw = [] as NormalizedBatch["raw"];
  const events = [] as TrajectoryEvent[];
  let sessionId = options.sessionId ?? null;
  let turnId = options.turnId ?? null;

  for (const [sequence, value] of parsed.values.entries()) {
    sessionId = firstString(value, ["thread_id", "session_id"]) ?? sessionId;
    turnId = firstString(value, ["turn_id"]) ?? turnId;
    const nextOptions: NormalizeOptions = { ...options, sequence };
    if (sessionId !== null) nextOptions.sessionId = sessionId;
    if (turnId !== null) nextOptions.turnId = turnId;
    const normalized = normalizeCodexJsonEvent(value, nextOptions);
    raw.push(normalized.raw);
    events.push(...normalized.events);
  }

  return { raw, events: renumberEvents(events), diagnostics: parsed.diagnostics };
}

const APP_SERVER_APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
]);

const APP_SERVER_OPAQUE_REASONING: ReasoningMetadata = {
  ...OPAQUE_REASONING,
  source_field: "content",
  visibility: "api_only",
};

interface AppServerIds {
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  requestId: string | null;
}

interface AppServerTopology extends AppServerIds {
  spanKind?: "thread" | "turn" | "item" | "request";
}

function appServerParams(payload: JsonObject): JsonObject {
  return nestedRecord(payload, "params") ?? {};
}

function appServerIds(payload: JsonObject): AppServerIds {
  const params = appServerParams(payload);
  const thread = nestedRecord(params, "thread");
  const turn = nestedRecord(params, "turn");
  const item = nestedRecord(params, "item");
  return {
    threadId: firstString(params, ["threadId", "thread_id"]) ??
      (thread === null ? null : firstString(thread, ["id", "threadId", "thread_id"])),
    turnId: firstString(params, ["turnId", "turn_id"]) ??
      (turn === null ? null : firstString(turn, ["id", "turnId", "turn_id"])),
    itemId: firstString(params, ["itemId", "item_id"]) ??
      (item === null ? null : firstString(item, ["id", "itemId", "item_id"])),
    requestId: firstString(params, ["requestId", "request_id"]) ?? firstString(payload, ["id"]),
  };
}

/**
 * Recognizes the documented Codex App Server v2 JSON-RPC wire shape without
 * connecting to an App Server or inspecting any local rollout/transcript.
 */
export function isCodexAppServerMessage(payload: unknown): payload is JsonObject {
  if (!isRecord(payload)) return false;
  if (firstString(payload, ["method"]) !== null) return true;
  return firstString(payload, ["id"]) !== null && ("result" in payload || "error" in payload) && !("type" in payload);
}

function appServerSourceEventId(payload: JsonObject): string {
  const method = firstString(payload, ["method"]) ?? ("error" in payload ? "response/error" : "response/result");
  const ids = appServerIds(payload);
  const rpcId = firstString(payload, ["id"]);
  const identity = [method, rpcId, ids.threadId, ids.turnId, ids.itemId, ids.requestId]
    .filter((part): part is string => part !== null)
    .join(":");
  return `codex-app-server:${identity}:${sha256(payload)}`;
}

export function createCodexAppServerRawEnvelope(
  payload: unknown,
  options: NormalizeOptions = {},
): RawEnvelope {
  const appOptions: NormalizeOptions = {
    ...options,
    interfaceVersion: options.interfaceVersion ?? CODEX_APP_SERVER_INTERFACE_VERSION,
  };
  const raw = createRawEnvelope("codex", payload, appOptions, CODEX_APP_SERVER_INTERFACE_VERSION);
  if (!isRecord(payload)) return raw;
  const ids = appServerIds(payload);
  return {
    ...raw,
    source_event_id: appServerSourceEventId(payload),
    session_id: ids.threadId ?? raw.session_id,
    turn_id: ids.turnId ?? raw.turn_id,
  };
}

function logicalAppServerSpan(kind: "thread" | "turn" | "item" | "request", ids: AppServerIds): string {
  const identity = kind === "thread"
    ? ids.threadId
    : kind === "turn"
      ? `${ids.threadId ?? "unknown"}:${ids.turnId ?? "unknown"}`
      : kind === "item"
        ? `${ids.threadId ?? "unknown"}:${ids.turnId ?? "unknown"}:${ids.itemId ?? "unknown"}`
        : `${ids.threadId ?? "unknown"}:${ids.turnId ?? "unknown"}:${ids.requestId ?? ids.itemId ?? "unknown"}`;
  return dedupeKey("codex-app-server-v2", kind, identity).slice(0, 16);
}

function appServerEvent(
  raw: RawEnvelope,
  index: number,
  input: Parameters<typeof createEvent>[2],
  options: NormalizeOptions,
  topology: AppServerTopology,
): TrajectoryEvent {
  const effectiveTopology: AppServerTopology = {
    ...topology,
    threadId: topology.threadId ?? raw.session_id,
    turnId: topology.turnId ?? raw.turn_id,
  };
  const spanKind = effectiveTopology.spanKind ??
    (effectiveTopology.itemId !== null ? "item" : effectiveTopology.turnId !== null ? "turn" : "thread");
  const parentSpanId = spanKind === "item" || spanKind === "request"
    ? effectiveTopology.turnId === null
      ? (effectiveTopology.threadId === null ? null : logicalAppServerSpan("thread", effectiveTopology))
      : logicalAppServerSpan("turn", effectiveTopology)
    : spanKind === "turn" && effectiveTopology.threadId !== null
      ? logicalAppServerSpan("thread", effectiveTopology)
      : null;
  const event = createEvent(raw, index, {
    ...input,
    sourceEventId: input.sourceEventId ?? raw.source_event_id,
    sourceSessionId: input.sourceSessionId ?? effectiveTopology.threadId,
    sourceTurnId: input.sourceTurnId ?? effectiveTopology.turnId,
    sourceStepId: input.sourceStepId ?? effectiveTopology.itemId,
    parentSpanId: input.parentSpanId ?? parentSpanId,
  }, options);
  return {
    ...event,
    span_id: logicalAppServerSpan(spanKind, effectiveTopology),
  };
}

function appServerContent(value: unknown): ContentPart[] {
  const entries = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  return entries.map((entry, ordinal) => {
    if (!isRecord(entry)) return contentPart(entry, ordinal);
    const type = firstString(entry, ["type"]);
    if (type === "text") return contentPart(entry.text ?? "", ordinal);
    if (type === "image" || type === "localImage") {
      return contentPart(entry, ordinal, { type: "image_ref", mimeType: "application/json" });
    }
    return contentPart(entry, ordinal);
  });
}

function officialItemType(value: string): string {
  const aliases: Record<string, string> = {
    agent_message: "agentMessage",
    command_execution: "commandExecution",
    context_compaction: "contextCompaction",
    dynamic_tool_call: "dynamicToolCall",
    file_change: "fileChange",
    image_view: "imageView",
    mcp_tool_call: "mcpToolCall",
    user_message: "userMessage",
    web_search: "webSearch",
    collab_tool_call: "collabToolCall",
  };
  return aliases[value] ?? value;
}

function appServerItemEvents(
  payload: JsonObject,
  raw: RawEnvelope,
  options: NormalizeOptions,
  method: string,
): TrajectoryEvent[] {
  const params = appServerParams(payload);
  const item = nestedRecord(params, "item");
  if (item === null) return [];
  const ids = appServerIds(payload);
  const itemType = officialItemType(firstString(item, ["type"]) ?? "unknown");
  const completed = method === "item/completed";
  const status = completed ? codexStatus(item.status, item.exitCode ?? item.exit_code) : "partial";
  const metadata = {
    jsonrpc_method: method,
    lifecycle: method,
    source_type: itemType,
    authoritative_final: completed,
    dedupe_key: dedupeKey(raw.source_event_id, method),
  };
  const make = (index: number, input: Parameters<typeof createEvent>[2]): TrajectoryEvent =>
    appServerEvent(raw, index, {
      ...input,
      status: input.status ?? status,
      metadata: { ...metadata, ...input.metadata },
    }, options, { ...ids, spanKind: "item" });

  if (itemType === "userMessage") {
    return [make(0, {
      eventType: "message",
      actor: "user",
      content: appServerContent(item.content),
    })];
  }

  if (itemType === "agentMessage") {
    const text = textFrom(item.text);
    return [make(0, {
      eventType: "message",
      actor: "assistant",
      content: text === null ? [] : [contentPart(text)],
      metadata: { phase: item.phase ?? null },
    })];
  }

  if (itemType === "plan") {
    const text = textFrom(item.text);
    return [make(0, {
      eventType: "plan",
      actor: "assistant",
      content: text === null ? [] : [contentPart(text)],
    })];
  }

  if (itemType === "reasoning") {
    const summary = textFrom(item.summary);
    const exposed = textFrom(item.content);
    const events: TrajectoryEvent[] = [];
    if (summary !== null) {
      events.push(make(events.length, {
        eventType: "reasoning",
        actor: "assistant",
        content: [contentPart(summary, 0, {
          type: "reasoning",
          reasoning: { ...PROVIDER_SUMMARY, source_field: "summary" },
        })],
        metadata: { reasoning_channel: "summary" },
      }));
    }
    if (exposed !== null) {
      events.push(make(events.length, {
        eventType: "reasoning",
        actor: "assistant",
        content: [contentPart(exposed, 0, {
          type: "reasoning",
          reasoning: APP_SERVER_OPAQUE_REASONING,
        })],
        metadata: {
          reasoning_channel: "raw_block_without_provider_cot_claim",
          source_field: "content",
        },
      }));
    }
    if (events.length === 0) {
      events.push(make(0, {
        eventType: "reasoning",
        actor: "assistant",
        content: [],
        metadata: { reasoning_channel: "unavailable" },
      }));
    }
    return events;
  }

  if (itemType === "commandExecution") {
    const exitCode = item.exitCode ?? item.exit_code;
    const args = {
      command: item.command ?? null,
      cwd: item.cwd ?? null,
      command_actions: item.commandActions ?? item.command_actions ?? null,
    };
    const output = item.aggregatedOutput ?? item.aggregated_output ?? null;
    return [make(0, {
      eventType: completed ? "tool.result" : "tool.call",
      actor: completed ? "tool" : "assistant",
      status: completed ? codexStatus(item.status, exitCode) : "partial",
      content: completed
        ? output === null ? [] : [contentPart(output, 0, { type: "stdout" })]
        : [contentPart(args, 0, { type: "tool_call" })],
      tool: toolShape(ids.itemId, "commandExecution", args, completed ? output : null, exitCode),
      metadata: { duration_ms: item.durationMs ?? item.duration_ms ?? null },
    })];
  }

  if (itemType === "mcpToolCall" || itemType === "dynamicToolCall") {
    const server = firstString(item, ["server"]);
    const tool = firstString(item, ["tool", "name"]);
    const name = server === null ? tool : tool === null ? server : `${server}/${tool}`;
    const args = item.arguments ?? null;
    const result = item.result ?? item.contentItems ?? item.error ?? null;
    return [make(0, {
      eventType: completed ? "tool.result" : "tool.call",
      actor: completed ? "tool" : "assistant",
      content: [contentPart(completed ? result : args, 0, { type: completed ? "tool_result" : "tool_call" })],
      tool: toolShape(ids.itemId, name, args, completed ? result : null, null),
      metadata: {
        app_context: item.appContext ?? null,
        plugin_id: item.pluginId ?? null,
        success: item.success ?? null,
        duration_ms: item.durationMs ?? null,
      },
    })];
  }

  if (itemType === "fileChange") {
    const changes = item.changes ?? [];
    return [make(0, {
      eventType: "artifact.patch",
      actor: "assistant",
      content: [contentPart(changes, 0, { type: "patch", mimeType: "application/json" })],
    })];
  }

  if (itemType === "collabToolCall") {
    const collab = make(0, {
      eventType: completed ? "handoff" : "agent.invoke",
      actor: "agent",
      content: item.prompt === undefined ? [] : [contentPart(item.prompt)],
      metadata: {
        collab_tool: item.tool ?? null,
        sender_thread_id: item.senderThreadId ?? null,
        receiver_thread_id: item.receiverThreadId ?? null,
        new_thread_id: item.newThreadId ?? null,
        agent_status: item.agentStatus ?? null,
      },
    });
    const threadLinks = [
      [stringValue(item.senderThreadId), "collab.sender"],
      [stringValue(item.receiverThreadId), "collab.receiver"],
      [stringValue(item.newThreadId), "collab.child"],
    ] as const;
    collab.links = threadLinks.flatMap(([threadId, relation]) => {
      if (threadId === null || threadId === ids.threadId) return [];
      return [{ trace_id: collab.trace_id, span_id: logicalAppServerSpan("thread", { ...ids, threadId }), relation }];
    });
    return [collab];
  }

  if (itemType === "webSearch") {
    return [make(0, {
      eventType: "retrieval",
      actor: "assistant",
      content: [contentPart({ query: item.query ?? null, action: item.action ?? null })],
    })];
  }

  if (itemType === "imageView") {
    return [make(0, {
      eventType: "artifact.read",
      actor: "assistant",
      content: [contentPart({ path: item.path ?? null }, 0, { type: "file_ref" })],
    })];
  }

  if (itemType === "contextCompaction") {
    return [make(0, {
      eventType: "compaction",
      actor: "system",
      status: completed ? "ok" : "partial",
      content: [],
    })];
  }

  if (itemType === "enteredReviewMode" || itemType === "exitedReviewMode") {
    return [make(0, {
      eventType: itemType === "enteredReviewMode" ? "evaluation" : "feedback",
      actor: "agent",
      content: item.review === undefined ? [] : [contentPart(item.review)],
      metadata: { review_mode: itemType },
    })];
  }

  return [make(0, {
    eventType: "model.inference",
    actor: "assistant",
    content: [contentPart(item)],
    metadata: { unsupported_item_shape: true },
  })];
}

function appServerDeltaEvents(
  payload: JsonObject,
  raw: RawEnvelope,
  options: NormalizeOptions,
  method: string,
): TrajectoryEvent[] {
  const params = appServerParams(payload);
  const ids = appServerIds(payload);
  const delta = params.delta ?? params.text ?? "";
  const metadata = {
    jsonrpc_method: method,
    lifecycle: "delta",
    authoritative_final: false,
    summary_index: params.summaryIndex ?? null,
    stream: params.stream ?? null,
    dedupe_key: dedupeKey(raw.source_event_id, method),
  };
  const make = (input: Parameters<typeof createEvent>[2]) => appServerEvent(raw, 0, {
    ...input,
    status: "partial",
    metadata: { ...metadata, ...input.metadata },
  }, options, { ...ids, spanKind: "item" });

  if (method === "item/agentMessage/delta") {
    return [make({ eventType: "message", actor: "assistant", content: [contentPart(delta)] })];
  }
  if (method === "item/plan/delta") {
    return [make({ eventType: "plan", actor: "assistant", content: [contentPart(delta)] })];
  }
  if (method === "item/reasoning/summaryTextDelta") {
    return [make({
      eventType: "reasoning",
      actor: "assistant",
      content: [contentPart(delta, 0, {
        type: "reasoning",
        reasoning: { ...PROVIDER_SUMMARY, source_field: "delta" },
      })],
      metadata: { reasoning_channel: "summary_delta" },
    })];
  }
  if (method === "item/reasoning/summaryPartAdded") {
    return [make({
      eventType: "reasoning",
      actor: "assistant",
      content: [],
      metadata: { reasoning_channel: "summary_boundary" },
    })];
  }
  if (method === "item/reasoning/textDelta") {
    return [make({
      eventType: "reasoning",
      actor: "assistant",
      content: [contentPart(delta, 0, { type: "reasoning", reasoning: {
        ...APP_SERVER_OPAQUE_REASONING,
        source_field: "delta",
      } })],
      metadata: { reasoning_channel: "raw_delta_without_provider_cot_claim" },
    })];
  }
  if (method === "item/commandExecution/outputDelta") {
    const stream = params.stream === "stderr" ? "stderr" : "stdout";
    return [make({
      eventType: "tool.result",
      actor: "tool",
      content: [contentPart(delta, 0, { type: stream })],
      tool: toolShape(ids.itemId, "commandExecution", null, delta, null),
    })];
  }
  if (method === "item/fileChange/outputDelta") {
    return [make({
      eventType: "artifact.patch",
      actor: "assistant",
      content: [contentPart(delta, 0, { type: "patch", mimeType: "text/x-diff" })],
      metadata: { deprecated_compatibility_event: true },
    })];
  }
  return [];
}

function approvalToolName(method: string): string {
  if (method.includes("commandExecution")) return "commandExecution";
  if (method.includes("fileChange")) return "fileChange";
  if (method.includes("permissions")) return "request_permissions";
  if (method.includes("elicitation")) return "mcpServer/elicitation";
  return "requestUserInput";
}

function appServerApprovalRequest(
  payload: JsonObject,
  raw: RawEnvelope,
  options: NormalizeOptions,
  method: string,
): TrajectoryEvent[] {
  const params = appServerParams(payload);
  const ids = appServerIds(payload);
  const args = params.command ?? params.commandActions ?? params.additionalPermissions ?? params.requestedSchema ?? params;
  return [appServerEvent(raw, 0, {
    eventType: "approval.request",
    actor: "environment",
    status: "partial",
    content: [contentPart(params)],
    tool: toolShape(ids.itemId ?? ids.requestId, approvalToolName(method), args, null, null),
    metadata: {
      jsonrpc_method: method,
      rpc_request_id: firstString(payload, ["id"]),
      approval_scope: method,
      dedupe_key: dedupeKey(raw.source_event_id, method),
    },
  }, options, { ...ids, spanKind: "request" })];
}

function decisionValue(result: unknown): unknown {
  if (typeof result === "string") return result;
  if (!isRecord(result)) return null;
  return result.decision ?? result.action ?? result.permissions ?? null;
}

function isApprovalDecision(value: unknown): boolean {
  if (Array.isArray(value)) return true;
  if (isRecord(value)) return "acceptWithExecpolicyAmendment" in value;
  return value === "accept" || value === "acceptForSession" || value === "decline" || value === "cancel";
}

function appServerResponseEvent(payload: JsonObject, raw: RawEnvelope, options: NormalizeOptions): TrajectoryEvent[] {
  if ("error" in payload) {
    return [appServerEvent(raw, 0, {
      eventType: "error",
      actor: "environment",
      status: "error",
      content: [contentPart(payload.error, 0, { type: "stderr" })],
      metadata: { jsonrpc_response: true, rpc_request_id: firstString(payload, ["id"]) },
    }, options, { ...appServerIds(payload), spanKind: "request" })];
  }
  const decision = decisionValue(payload.result);
  if (!isApprovalDecision(decision)) return [];
  const status = decision === "decline" || decision === "cancel" ? "cancelled" : "ok";
  return [appServerEvent(raw, 0, {
    eventType: "approval.decision",
    actor: "user",
    status,
    content: [contentPart(payload.result)],
    metadata: {
      jsonrpc_response: true,
      rpc_request_id: firstString(payload, ["id"]),
      decision,
      dedupe_key: dedupeKey(raw.source_event_id, "approval.decision"),
    },
  }, options, { ...appServerIds(payload), spanKind: "request" })];
}

/**
 * Maps one official Codex App Server v2 JSON-RPC message. It consumes only the
 * supplied visible wire record and never opens a socket or local transcript.
 */
export function normalizeCodexAppServerEvent(
  payload: unknown,
  options: NormalizeOptions = {},
): NormalizedCapture {
  const raw = createCodexAppServerRawEnvelope(payload, options);
  if (raw.interface_version !== CODEX_APP_SERVER_INTERFACE_VERSION || !isCodexAppServerMessage(payload)) {
    return { raw, events: [] };
  }

  const method = firstString(payload, ["method"]);
  if (method === null) return { raw, events: appServerResponseEvent(payload, raw, options) };
  const params = appServerParams(payload);
  const ids = appServerIds(payload);

  if (method === "item/started" || method === "item/completed") {
    return { raw, events: appServerItemEvents(payload, raw, options, method) };
  }
  if (
    method === "item/agentMessage/delta" || method === "item/plan/delta" ||
    method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/summaryPartAdded" ||
    method === "item/reasoning/textDelta" || method === "item/commandExecution/outputDelta" ||
    method === "item/fileChange/outputDelta"
  ) {
    return { raw, events: appServerDeltaEvents(payload, raw, options, method) };
  }
  if (APP_SERVER_APPROVAL_METHODS.has(method)) {
    return { raw, events: appServerApprovalRequest(payload, raw, options, method) };
  }
  if (method === "serverRequest/resolved") {
    return { raw, events: [appServerEvent(raw, 0, {
      eventType: "approval.decision",
      actor: "environment",
      status: "ok",
      content: [contentPart({ requestId: ids.requestId })],
      metadata: {
        jsonrpc_method: method,
        resolution_only: true,
        decision_observed: false,
        dedupe_key: dedupeKey(raw.source_event_id, method),
      },
    }, options, { ...ids, spanKind: "request" })] };
  }

  if (method === "thread/started") {
    const thread = nestedRecord(params, "thread") ?? {};
    const event = appServerEvent(raw, 0, {
      eventType: "agent.invoke",
      actor: "agent",
      status: "partial",
      metadata: {
        jsonrpc_method: method,
        forked_from_id: thread.forkedFromId ?? null,
        parent_thread_id: thread.parentThreadId ?? null,
        model_provider: thread.modelProvider ?? null,
        cwd: thread.cwd ?? null,
        dedupe_key: dedupeKey(raw.source_event_id, method),
      },
    }, options, { ...ids, spanKind: "thread" });
    const parentThreadId = stringValue(thread.parentThreadId ?? thread.forkedFromId);
    if (parentThreadId !== null) {
      event.links = [{
        trace_id: event.trace_id,
        span_id: logicalAppServerSpan("thread", { ...ids, threadId: parentThreadId }),
        relation: thread.parentThreadId === undefined ? "forked_from" : "parent_thread",
      }];
    }
    return { raw, events: [event] };
  }

  if (
    method === "thread/archived" || method === "thread/unarchived" || method === "thread/closed" ||
    method === "thread/status/changed" || method === "thread/name/updated" || method === "thread/goal/updated"
  ) {
    return { raw, events: [appServerEvent(raw, 0, {
      eventType: "evaluation",
      actor: "environment",
      status: "ok",
      content: [],
      metadata: {
        jsonrpc_method: method,
        thread_status: params.status ?? null,
        dedupe_key: dedupeKey(raw.source_event_id, method),
      },
    }, options, { ...ids, spanKind: "thread" })] };
  }

  if (method === "turn/started") {
    const turn = nestedRecord(params, "turn") ?? {};
    return { raw, events: [appServerEvent(raw, 0, {
      eventType: "model.inference",
      actor: "assistant",
      status: "partial",
      metadata: {
        jsonrpc_method: method,
        turn_status: turn.status ?? "inProgress",
        dedupe_key: dedupeKey(raw.source_event_id, method),
      },
    }, options, { ...ids, spanKind: "turn" })] };
  }

  if (method === "turn/completed") {
    const turn = nestedRecord(params, "turn") ?? {};
    const status = codexStatus(turn.status, null);
    const error = turn.error ?? null;
    return { raw, events: [appServerEvent(raw, 0, {
      eventType: status === "error" ? "error" : "evaluation",
      actor: "environment",
      status,
      content: error === null ? [] : [contentPart(error, 0, { type: "stderr" })],
      usage: usageFrom(turn.usage ?? params.usage),
      metadata: {
        jsonrpc_method: method,
        turn_status: turn.status ?? null,
        error,
        dedupe_key: dedupeKey(raw.source_event_id, method),
      },
    }, options, { ...ids, spanKind: "turn" })] };
  }

  if (method === "turn/diff/updated") {
    return { raw, events: [appServerEvent(raw, 0, {
      eventType: "artifact.patch",
      actor: "assistant",
      status: "partial",
      content: [contentPart(params.diff ?? "", 0, { type: "patch", mimeType: "text/x-diff" })],
      metadata: { jsonrpc_method: method, aggregated_turn_diff: true },
    }, options, { ...ids, spanKind: "turn" })] };
  }

  if (method === "turn/plan/updated") {
    return { raw, events: [appServerEvent(raw, 0, {
      eventType: "plan",
      actor: "assistant",
      status: "partial",
      content: [contentPart({ explanation: params.explanation ?? null, plan: params.plan ?? [] })],
      metadata: { jsonrpc_method: method, structured_plan: true },
    }, options, { ...ids, spanKind: "turn" })] };
  }

  if (method === "thread/tokenUsage/updated") {
    const usageValue = params.usage ?? params.tokenUsage ?? params;
    return { raw, events: [appServerEvent(raw, 0, {
      eventType: "model.inference",
      actor: "environment",
      status: "partial",
      usage: usageFrom(usageValue),
      content: [contentPart(usageValue)],
      metadata: { jsonrpc_method: method, usage_update: true },
    }, options, { ...ids, spanKind: "turn" })] };
  }

  if (method === "hook/started" || method === "hook/completed") {
    const run = nestedRecord(params, "run") ?? {};
    const completed = method === "hook/completed";
    return { raw, events: [appServerEvent(raw, 0, {
      eventType: completed ? "tool.result" : "tool.call",
      actor: completed ? "tool" : "system",
      status: completed ? codexStatus(run.status, run.exitCode) : "partial",
      content: [contentPart(run, 0, { type: completed ? "tool_result" : "tool_call" })],
      tool: toolShape(firstString(run, ["id", "runId"]), "codex.lifecycleHook", run, completed ? run : null, run.exitCode),
      metadata: { jsonrpc_method: method, hook_lifecycle: true },
    }, options, { ...ids, itemId: firstString(run, ["id", "runId"]), spanKind: "item" })] };
  }

  if (method === "item/tool/call") {
    return { raw, events: [appServerEvent(raw, 0, {
      eventType: "tool.call",
      actor: "assistant",
      status: "partial",
      content: [contentPart(params.arguments ?? params, 0, { type: "tool_call" })],
      tool: toolShape(ids.itemId, firstString(params, ["tool", "name"]), params.arguments ?? null, null, null),
      metadata: { jsonrpc_method: method, client_dispatched_tool: true },
    }, options, { ...ids, spanKind: "item" })] };
  }

  if (method === "error") {
    const error = nestedRecord(params, "error") ?? params;
    const additional = isRecord(error.additionalDetails) ? error.additionalDetails : {};
    return { raw, events: [appServerEvent(raw, 0, {
      eventType: "error",
      actor: "environment",
      status: "error",
      content: [contentPart(error, 0, { type: "stderr" })],
      metadata: {
        jsonrpc_method: method,
        codex_error_info: error.codexErrorInfo ?? null,
        retry_attempt: additional.retryAttempt ?? additional.retry_attempt ?? null,
        retryable: additional.retryable ?? null,
      },
    }, options, { ...ids, spanKind: ids.turnId === null ? "thread" : "turn" })] };
  }

  if (method === "model/rerouted" || method === "model/safetyBuffering/updated" || method === "model/verification") {
    return { raw, events: [appServerEvent(raw, 0, {
      eventType: "evaluation",
      actor: "environment",
      status: "partial",
      content: [contentPart(params)],
      metadata: { jsonrpc_method: method, model_lifecycle: true },
    }, options, { ...ids, spanKind: ids.turnId === null ? "thread" : "turn" })] };
  }

  if (method === "warning" || method === "configWarning") {
    return { raw, events: [appServerEvent(raw, 0, {
      eventType: "error",
      actor: "environment",
      status: "partial",
      content: [contentPart(params.message ?? params.summary ?? params, 0, { type: "stderr" })],
      metadata: { jsonrpc_method: method, warning: true },
    }, options, { ...ids, spanKind: ids.turnId === null ? "thread" : "turn" })] };
  }

  return { raw, events: [appServerEvent(raw, 0, {
    eventType: "model.inference",
    actor: "environment",
    status: "partial",
    content: [],
    metadata: {
      jsonrpc_method: method,
      unsupported_app_server_method: true,
      payload_preview_hash: raw.payload_sha256,
    },
  }, options, { ...ids, spanKind: ids.itemId !== null ? "item" : ids.turnId !== null ? "turn" : "thread" })] };
}

export function normalizeCodexAppServerJsonl(input: string, options: NormalizeOptions = {}): NormalizedBatch {
  const parsed = parseJsonLines(input);
  const raw: RawEnvelope[] = [];
  const events: TrajectoryEvent[] = [];
  let sessionId = options.sessionId ?? null;
  let turnId = options.turnId ?? null;

  for (const [sequence, payload] of parsed.values.entries()) {
    const ids = appServerIds(payload);
    sessionId = ids.threadId ?? sessionId;
    turnId = ids.turnId ?? turnId;
    const nextOptions: NormalizeOptions = { ...options, sequence };
    if (sessionId !== null) nextOptions.sessionId = sessionId;
    if (turnId !== null) nextOptions.turnId = turnId;
    const normalized = normalizeCodexAppServerEvent(payload, nextOptions);
    raw.push(normalized.raw);
    events.push(...normalized.events);
  }
  return { raw, events: renumberEvents(events), diagnostics: parsed.diagnostics };
}

export function normalizeCodexHook(payload: unknown, options: NormalizeOptions = {}): NormalizedCapture {
  const hookOptions: NormalizeOptions = {
    ...options,
    interfaceVersion: options.interfaceVersion ?? CODEX_HOOK_INTERFACE_VERSION,
  };
  const raw = createRawEnvelope("codex", payload, hookOptions, CODEX_HOOK_INTERFACE_VERSION);
  if (!isRecord(payload)) return { raw, events: [] };

  const hook = firstString(payload, ["hook_event_name", "hookEventName"]) ?? "Unknown";
  const sessionId = firstString(payload, ["session_id", "sessionId"]) ?? raw.session_id;
  const turnId = firstString(payload, ["turn_id", "turnId"]) ?? raw.turn_id;
  const toolName = firstString(payload, ["tool_name", "toolName"]);
  const callId = firstString(payload, ["tool_use_id", "toolUseId", "call_id"]);
  const baseMetadata = {
    hook_event_name: hook,
    permission_mode: stringValue(payload.permission_mode),
    model: stringValue(payload.model),
    dedupe_key: dedupeKey("codex-hook", sessionId, turnId, hook, callId),
  };
  const make = (input: Parameters<typeof createEvent>[2]) => createEvent(raw, 0, {
    ...input,
    sourceSessionId: sessionId,
    sourceTurnId: turnId,
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
      tool: toolShape(callId, toolName, payload.tool_input, null, null),
    })] };
  }
  if (hook === "PostToolUse") {
    const response = payload.tool_response ?? payload.tool_result ?? payload.tool_output ?? null;
    const responseObject = isRecord(response) ? response : {};
    const exitCode = responseObject.exit_code ?? responseObject.exitCode;
    return { raw, events: [make({
      eventType: "tool.result",
      actor: "tool",
      status: codexStatus(responseObject.status, exitCode),
      content: [contentPart(response, 0, { type: "tool_result" })],
      tool: toolShape(callId, toolName, payload.tool_input, response, exitCode),
    })] };
  }
  if (hook === "PermissionRequest") {
    return { raw, events: [make({
      eventType: "approval.request",
      actor: "environment",
      content: [contentPart({ tool_name: toolName, tool_input: payload.tool_input })],
      tool: toolShape(callId, toolName, payload.tool_input, null, null),
    })] };
  }
  if (hook === "PreCompact" || hook === "PostCompact") {
    return { raw, events: [make({
      eventType: "compaction",
      actor: "system",
      status: hook === "PreCompact" ? "partial" : "ok",
      content: [],
      metadata: { phase: hook === "PreCompact" ? "before" : "after", trigger: payload.trigger ?? null },
    })] };
  }
  if (hook === "SubagentStart") {
    return { raw, events: [make({
      eventType: "agent.invoke",
      actor: "agent",
      status: "partial",
      sourceStepId: firstString(payload, ["agent_id", "agentId"]),
      metadata: { agent_type: payload.agent_type ?? payload.subagent_type ?? null },
    })] };
  }
  if (hook === "SubagentStop") {
    const message = textFrom(payload.last_assistant_message ?? payload.result);
    return { raw, events: [make({
      eventType: "handoff",
      actor: "agent",
      content: message === null ? [] : [contentPart(message)],
      sourceStepId: firstString(payload, ["agent_id", "agentId"]),
      metadata: { agent_type: payload.agent_type ?? payload.subagent_type ?? null },
    })] };
  }
  if (hook === "Stop") {
    const message = textFrom(payload.last_assistant_message);
    return { raw, events: [make({
      eventType: "message",
      actor: "assistant",
      content: message === null ? [] : [contentPart(message)],
    })] };
  }
  if (hook === "SessionStart" || hook === "SessionEnd") {
    return { raw, events: [make({
      eventType: hook === "SessionStart" ? "agent.invoke" : "evaluation",
      actor: hook === "SessionStart" ? "agent" : "environment",
      status: hook === "SessionStart" ? "partial" : "ok",
      metadata: { source: payload.source ?? null, reason: payload.reason ?? null },
    })] };
  }

  return { raw, events: [make({
    eventType: "model.inference",
    actor: "environment",
    status: "partial",
    metadata: { unsupported_hook_shape: true, payload_sha256: raw.payload_sha256 },
  })] };
}
