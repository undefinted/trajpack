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
  stableJson,
  stringValue,
  toIso,
  usageFrom,
  type NormalizeOptions,
  type NormalizedCapture,
} from "./common.js";

type JsonObject = Record<string, unknown>;

function toolShape(callId: string | null, name: string | null, args: unknown) {
  return {
    call_id: callId,
    name,
    arguments: args ?? null,
    result: null,
    exit_code: null,
  };
}

function deepSeekApiUsage(value: unknown): Partial<TrajectoryEvent["usage"]> {
  const usage = usageFrom(value);
  if (!isRecord(value)) return usage;
  const details = nestedRecord(value, "completion_tokens_details");
  const reasoningTokens = details?.reasoning_tokens;
  const cacheHitTokens = value.prompt_cache_hit_tokens;
  return {
    ...usage,
    reasoning_tokens: typeof reasoningTokens === "number" && Number.isInteger(reasoningTokens) && reasoningTokens >= 0
      ? reasoningTokens
      : usage.reasoning_tokens ?? null,
    cache_read_tokens: typeof cacheHitTokens === "number" && Number.isInteger(cacheHitTokens) && cacheHitTokens >= 0
      ? cacheHitTokens
      : usage.cache_read_tokens ?? null,
  };
}

function deepSeekApiEvents(
  record: JsonObject,
  raw: NormalizedCapture["raw"],
  options: NormalizeOptions,
  metadata: Record<string, unknown>,
): TrajectoryEvent[] {
  const responseId = firstString(record, ["id"]);
  const model = firstString(record, ["model"]);
  const object = firstString(record, ["object"]);
  if (
    responseId === null || model === null ||
    (object !== "chat.completion" && object !== "chat.completion.chunk") ||
    !Array.isArray(record.choices)
  ) return [];

  const responseUsage = deepSeekApiUsage(record.usage);
  const hasUsage = Object.values(responseUsage).some((value) => value !== null && value !== undefined);
  let usageAssigned = false;
  const nextUsage = (): Partial<TrajectoryEvent["usage"]> => {
    if (!hasUsage || usageAssigned) return {};
    usageAssigned = true;
    return responseUsage;
  };
  const events: TrajectoryEvent[] = [];
  const startedAt = toIso(record.created, raw.captured_at);
  const responseMetadata = {
    ...metadata,
    api_response_id: responseId,
    api_object: object,
    api_model: model,
    source_created: record.created ?? null,
    source_usage: record.usage ?? null,
  };

  for (const [choicePosition, candidate] of record.choices.entries()) {
    if (!isRecord(candidate) || !Number.isInteger(candidate.index) || (candidate.index as number) < 0) continue;
    const choiceIndex = candidate.index as number;
    const isDelta = object === "chat.completion.chunk";
    const body = isDelta ? nestedRecord(candidate, "delta") : nestedRecord(candidate, "message");
    if (body === null) continue;
    const finishReason = typeof candidate.finish_reason === "string" ? candidate.finish_reason : null;
    const status: TrajectoryEvent["status"] = isDelta && finishReason === null ? "partial" : "ok";
    const choiceMetadata = {
      ...responseMetadata,
      choice_index: choiceIndex,
      choice_position: choicePosition,
      finish_reason: finishReason,
      choice_payload_field: isDelta ? "delta" : "message",
      source_role: body.role ?? null,
    };
    const sourcePrefix = `${responseId}:choice:${choiceIndex}`;
    const stepId = `choice:${choiceIndex}`;
    const beforeChoice = events.length;

    if (typeof body.reasoning_content === "string" && body.reasoning_content.length > 0) {
      events.push(createEvent(raw, events.length, {
        eventType: "reasoning",
        actor: "assistant",
        status,
        content: [contentPart(body.reasoning_content, 0, {
          type: "reasoning",
          reasoning: { ...PROVIDER_EXPOSED_REASONING, source_field: "reasoning_content" },
        })],
        sourceEventId: `${sourcePrefix}:reasoning`,
        sourceSessionId: responseId,
        sourceStepId: stepId,
        startedAt,
        usage: nextUsage(),
        metadata: {
          ...choiceMetadata,
          provider_exposed_field: "reasoning_content",
          dedupe_key: dedupeKey("deepseek-api", responseId, choiceIndex, "reasoning", body.reasoning_content),
        },
      }, options));
    }

    if (typeof body.content === "string" && body.content.length > 0) {
      events.push(createEvent(raw, events.length, {
        eventType: "message",
        actor: "assistant",
        status,
        content: [contentPart(body.content)],
        sourceEventId: `${sourcePrefix}:message`,
        sourceSessionId: responseId,
        sourceStepId: stepId,
        startedAt,
        usage: nextUsage(),
        metadata: {
          ...choiceMetadata,
          dedupe_key: dedupeKey("deepseek-api", responseId, choiceIndex, "message", body.content),
        },
      }, options));
    }

    if (Array.isArray(body.tool_calls)) {
      for (const [toolPosition, toolCall] of body.tool_calls.entries()) {
        if (!isRecord(toolCall)) continue;
        const fn = nestedRecord(toolCall, "function");
        const callId = firstString(toolCall, ["id"]);
        const toolIndex = typeof toolCall.index === "number" && Number.isInteger(toolCall.index)
          ? toolCall.index
          : toolPosition;
        const name = fn ? firstString(fn, ["name"]) : null;
        const args = fn?.arguments ?? null;
        events.push(createEvent(raw, events.length, {
          eventType: "tool.call",
          actor: "assistant",
          status,
          content: [contentPart(args, 0, { type: "tool_call" })],
          sourceEventId: `${sourcePrefix}:tool:${toolIndex}:${callId ?? "partial"}`,
          sourceSessionId: responseId,
          sourceStepId: stepId,
          startedAt,
          tool: toolShape(callId, name, args),
          usage: nextUsage(),
          metadata: {
            ...choiceMetadata,
            tool_call_index: toolIndex,
            tool_call_position: toolPosition,
            source_tool_type: toolCall.type ?? null,
            dedupe_key: dedupeKey("deepseek-api", responseId, choiceIndex, "tool", toolIndex, callId, name, args),
          },
        }, options));
      }
    }

    if (events.length === beforeChoice) {
      events.push(createEvent(raw, events.length, {
        eventType: "model.inference",
        actor: "assistant",
        status,
        sourceEventId: `${sourcePrefix}:state`,
        sourceSessionId: responseId,
        sourceStepId: stepId,
        startedAt,
        usage: nextUsage(),
        metadata: {
          ...choiceMetadata,
          empty_api_delta: true,
          dedupe_key: dedupeKey("deepseek-api", responseId, choiceIndex, "state", finishReason),
        },
      }, options));
    }
  }

  if (events.length === 0 && hasUsage) {
    events.push(createEvent(raw, 0, {
      eventType: "model.inference",
      actor: "assistant",
      status: "ok",
      sourceEventId: `${responseId}:usage`,
      sourceSessionId: responseId,
      startedAt,
      usage: nextUsage(),
      metadata: {
        ...responseMetadata,
        usage_only_api_chunk: true,
        dedupe_key: dedupeKey("deepseek-api", responseId, "usage", record.usage),
      },
    }, options));
  }

  return events;
}

function actorFromRole(value: unknown): TrajectoryEvent["actor"] {
  switch (value) {
    case "human":
      return "user";
    case "user":
    case "assistant":
    case "system":
    case "developer":
    case "tool":
      return value;
    case "agent":
      return "agent";
    default:
      return "environment";
  }
}

function messageText(message: JsonObject): string | null {
  const direct = firstString(message, ["text", "content", "message"]);
  if (direct !== null) return direct;
  const content = message.content;
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap((candidate) => {
    if (typeof candidate === "string") return [candidate];
    if (!isRecord(candidate)) return [];
    const text = firstString(candidate, ["text", "content"]);
    return text === null ? [] : [text];
  });
  return parts.length > 0 ? parts.join("\n") : null;
}

function messageEvents(
  messages: unknown[],
  raw: NormalizedCapture["raw"],
  options: NormalizeOptions,
  sessionId: string | null,
  metadata: Record<string, unknown>,
): TrajectoryEvent[] {
  const ordered = messages
    .map((message, inputIndex) => ({ message, inputIndex }))
    .sort((left, right) => {
      const leftSequence = isRecord(left.message) && typeof left.message.sequence === "number" ? left.message.sequence : left.inputIndex;
      const rightSequence = isRecord(right.message) && typeof right.message.sequence === "number" ? right.message.sequence : right.inputIndex;
      return leftSequence - rightSequence;
    });

  const events = ordered.flatMap(({ message, inputIndex }, index) => {
    if (!isRecord(message)) return [];
    const text = messageText(message);
    if (text === null) return [];
    const role = stringValue(message.role) ?? "unknown";
    const messageId = firstString(message, ["id", "message_id", "messageId"]) ?? `${inputIndex}`;
    return [createEvent(raw, index, {
      eventType: "message",
      actor: actorFromRole(role),
      content: [contentPart(text)],
      sourceEventId: messageId,
      sourceSessionId: sessionId,
      startedAt: toIso(message.timestamp ?? message.created_at ?? message.createdAt, raw.captured_at),
      metadata: {
        ...metadata,
        source_role: role,
        source_sequence: message.sequence ?? inputIndex,
        source_parent_message_id: firstString(message, ["parent_id", "parentId", "parent_message_id", "parentMessageId"]),
        dedupe_key: dedupeKey(raw.adapter, sessionId, messageId, role, text),
      },
    }, options)];
  });
  const spans = new Map(events.flatMap((event) => event.source_event_id ? [[event.source_event_id, event.span_id] as const] : []));
  return events.map((event) => {
    const parent = event.metadata.source_parent_message_id;
    return typeof parent === "string" && spans.has(parent)
      ? { ...event, parent_span_id: spans.get(parent)! }
      : event;
  });
}

function chatGptMessages(record: JsonObject): JsonObject[] {
  if (!isRecord(record.mapping)) return [];
  return Object.entries(record.mapping).flatMap(([nodeId, candidate]) => {
    if (!isRecord(candidate) || !isRecord(candidate.message)) return [];
    const message = candidate.message;
    const author = nestedRecord(message, "author");
    const content = nestedRecord(message, "content");
    const parts = content && Array.isArray(content.parts) ? content.parts : [];
    return [{
      id: firstString(message, ["id"]) ?? nodeId,
      role: author ? firstString(author, ["role"]) ?? "unknown" : "unknown",
      content: parts,
      timestamp: message.create_time ?? message.created_at ?? null,
      parent_id: firstString(candidate, ["parent"]),
      sequence: typeof message.create_time === "number" ? message.create_time : undefined,
    }];
  });
}

function claudeMessages(record: JsonObject): JsonObject[] {
  if (!Array.isArray(record.chat_messages)) return [];
  return record.chat_messages.flatMap((candidate, index) => {
    if (!isRecord(candidate)) return [];
    return [{
      ...candidate,
      id: firstString(candidate, ["uuid", "id", "message_id"]) ?? `${index}`,
      role: firstString(candidate, ["sender", "role"]) ?? "unknown",
      timestamp: candidate.created_at ?? candidate.updated_at ?? null,
      sequence: index,
    }];
  });
}

export function normalizeAuthorizedDomCapture(payload: unknown, options: NormalizeOptions = {}): NormalizedCapture {
  const raw = createRawEnvelope("browser", payload, options, "authorized-dom-capture/1");
  if (!isRecord(payload) || payload.record_kind !== "authorized_dom_capture") return { raw, events: [] };
  const capture = nestedRecord(payload, "capture");
  if (capture === null || !Array.isArray(capture.messages)) return { raw, events: [] };
  const provenance = nestedRecord(payload, "provenance") ?? {};
  const page = nestedRecord(capture, "page") ?? {};
  const recipe = nestedRecord(capture, "recipe") ?? {};
  const authorization = nestedRecord(recipe, "authorization")
    ?? nestedRecord(provenance, "authorization")
    ?? {};
  const sessionId = firstString(capture, ["session_id", "sessionId", "conversation_id", "conversationId"]) ?? raw.session_id;
  return {
    raw,
    events: messageEvents(capture.messages, raw, options, sessionId, {
      record_kind: "authorized_dom_capture",
      origin: page.origin ?? recipe.origin ?? provenance.source_origin ?? null,
      recipe_id: recipe.recipe_id ?? provenance.selector_recipe_id ?? null,
      recipe_version: recipe.version ?? provenance.selector_recipe_version ?? null,
      recipe_sha256: recipe.recipe_sha256 ?? provenance.selector_recipe_sha256 ?? null,
      authorization_basis: authorization.basis ?? null,
      authorization_ref: authorization.evidence_ref ?? null,
      authorization_attested_by: authorization.attested_by ?? null,
      authorization_expires_at: authorization.expires_at ?? null,
    }),
  };
}

export function normalizeManualImport(payload: unknown, options: NormalizeOptions = {}): NormalizedCapture {
  const raw = createRawEnvelope("manual_import", payload, options, "manual-import/1");
  if (!isRecord(payload) || payload.record_kind !== "imported_record") return { raw, events: [] };
  const record = nestedRecord(payload, "record");
  if (record === null) return { raw, events: [] };
  const provenance = nestedRecord(payload, "provenance") ?? {};
  const importMetadata = {
    record_kind: "imported_record",
    import_format: provenance.detected_format ?? provenance.format ?? provenance.source_format ?? null,
    import_source: provenance.source_product ?? provenance.source ?? provenance.product ?? null,
    source_authenticity: provenance.source_authenticity ?? null,
    provenance_sha256: dedupeKey(stableJson(provenance)),
  };
  if (
    importMetadata.import_format === "deepseek_api_response" &&
    importMetadata.import_source === "deepseek_api"
  ) {
    return { raw, events: deepSeekApiEvents(record, raw, options, importMetadata) };
  }
  const sessionId =
    firstString(record, ["session_id", "sessionId", "conversation_id", "conversationId", "id"]) ??
    firstString(provenance, ["session_id", "sessionId"]) ??
    raw.session_id;
  const officialChatGpt = chatGptMessages(record);
  const officialClaude = claudeMessages(record);
  const messages = officialChatGpt.length > 0
    ? officialChatGpt
    : officialClaude.length > 0
      ? officialClaude
      : Array.isArray(record.messages)
    ? record.messages
    : isRecord(record.message)
      ? [record.message]
      : record.role !== undefined
        ? [record]
        : typeof record.non_executing_text_preview === "string"
          ? [{
            id: "html-text-preview",
            role: "environment",
            text: record.non_executing_text_preview,
            sequence: 0,
          }]
          : [];

  return {
    raw,
    events: messageEvents(messages, raw, options, sessionId, importMetadata),
  };
}
