import type { ContentPart, TrajectoryEvent } from "@trajpack/schema";

import {
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
  type NormalizeOptions,
  type NormalizedBatch,
  type NormalizedCapture,
} from "./common.js";

export const GEMINI_CLI_HOOK_INTERFACE_VERSION = "gemini-cli-hook/1";

type JsonObject = Record<string, unknown>;

function geminiUsage(value: unknown): Partial<TrajectoryEvent["usage"]> {
  if (!isRecord(value)) return {};
  const number = (...keys: string[]): number | null => {
    for (const key of keys) {
      const candidate = value[key];
      if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) return candidate;
    }
    return null;
  };
  return {
    input_tokens: number("promptTokenCount", "prompt_token_count", "inputTokens", "input_tokens"),
    output_tokens: number("candidatesTokenCount", "candidates_token_count", "outputTokens", "output_tokens"),
    reasoning_tokens: number("thoughtsTokenCount", "thoughts_token_count", "reasoningTokens", "reasoning_tokens"),
    cache_read_tokens: number("cachedContentTokenCount", "cached_content_token_count", "cacheReadTokens"),
  };
}

function responseText(response: JsonObject): Array<{ index: number; text: string }> {
  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  const rendered: Array<{ index: number; text: string }> = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) continue;
    const content = nestedRecord(candidate, "content");
    const parts = content !== null && Array.isArray(content.parts) ? content.parts : [];
    const text = parts.flatMap((part): string[] => {
      if (typeof part === "string") return [part];
      if (!isRecord(part)) return [];
      const value = firstString(part, ["text"]);
      return value === null ? [] : [value];
    }).join("");
    if (text.length > 0) {
      const index = typeof candidate.index === "number" && Number.isInteger(candidate.index)
        ? candidate.index
        : rendered.length;
      rendered.push({ index, text });
    }
  }
  return rendered;
}

function toolShape(callId: string, name: string | null, args: unknown, result: unknown) {
  return {
    call_id: callId,
    name,
    arguments: args ?? null,
    result: result ?? null,
    exit_code: null,
  };
}

function toolCallIdentity(payload: JsonObject, sessionId: string | null): { callId: string; synthetic: boolean } {
  const providerId = firstString(payload, ["tool_call_id", "toolCallId", "call_id", "callId"]);
  if (providerId !== null) return { callId: providerId, synthetic: false };
  // Gemini CLI's stable hook schema currently exposes the tool name and input,
  // but no call id. This deterministic fallback pairs the usual Before/After
  // records without claiming provider identity. Identical concurrent calls are
  // an explicitly documented fidelity limit.
  return {
    callId: `gemini-hook-${sha256([sessionId, payload.tool_name, payload.tool_input]).slice(0, 24)}`,
    synthetic: true,
  };
}

function endStatus(reason: unknown): TrajectoryEvent["status"] {
  return reason === "error" || reason === "failed" ? "error" : "ok";
}

/**
 * Normalize one official Gemini CLI hook stdin object. The hook API exposes
 * visible prompts, stable model request/response projections, tool I/O, and
 * lifecycle facts. It does not expose hidden reasoning or a subagent topology.
 */
export function normalizeGeminiCliHook(payload: unknown, options: NormalizeOptions = {}): NormalizedCapture {
  const hookOptions: NormalizeOptions = {
    ...options,
    interfaceVersion: options.interfaceVersion ?? GEMINI_CLI_HOOK_INTERFACE_VERSION,
  };
  const raw = createRawEnvelope("gemini_cli", payload, hookOptions, GEMINI_CLI_HOOK_INTERFACE_VERSION);
  if (raw.interface_version !== GEMINI_CLI_HOOK_INTERFACE_VERSION || !isRecord(payload)) return { raw, events: [] };

  const hook = firstString(payload, ["hook_event_name"]);
  const sessionId = firstString(payload, ["session_id"]) ?? raw.session_id;
  const sourceTurnId = firstString(payload, ["turn_id", "turnId"]);
  const commonMetadata = {
    hook_event_name: hook,
    dedupe_key: dedupeKey("gemini-hook", sessionId, hook, raw.payload_sha256),
  };
  const make = (index: number, input: Parameters<typeof createEvent>[2]) => createEvent(raw, index, {
    ...input,
    sourceSessionId: sessionId,
    sourceTurnId,
    metadata: { ...commonMetadata, ...input.metadata },
  }, hookOptions);

  if (hook === "SessionStart") {
    return { raw, events: [make(0, {
      eventType: "agent.invoke",
      actor: "agent",
      status: "partial",
      metadata: { source: payload.source ?? null },
    })] };
  }
  if (hook === "SessionEnd") {
    return { raw, events: [make(0, {
      eventType: "evaluation",
      actor: "environment",
      status: endStatus(payload.reason),
      metadata: { reason: payload.reason ?? null, best_effort_hook: true },
    })] };
  }
  if (hook === "BeforeAgent") {
    const prompt = typeof payload.prompt === "string" ? payload.prompt : null;
    return { raw, events: [make(0, {
      eventType: "message",
      actor: "user",
      status: "ok",
      content: prompt === null ? [] : [contentPart(prompt)],
      metadata: { authoritative_user_prompt: true },
    })] };
  }
  if (hook === "AfterAgent") {
    const response = typeof payload.prompt_response === "string" ? payload.prompt_response : null;
    return { raw, events: [make(0, {
      eventType: "message",
      actor: "assistant",
      status: "ok",
      content: response === null ? [] : [contentPart(response)],
      metadata: {
        authoritative_final: true,
        stop_hook_active: payload.stop_hook_active === true,
        reasoning_representation: "unavailable",
      },
    })] };
  }
  if (hook === "BeforeModel" || hook === "BeforeToolSelection") {
    const request = nestedRecord(payload, "llm_request");
    const model = request === null ? null : firstString(request, ["model"]);
    const messages = request !== null && Array.isArray(request.messages) ? request.messages : [];
    return { raw, events: [make(0, {
      eventType: "model.inference",
      actor: "assistant",
      status: "partial",
      content: request === null ? [] : [contentPart(request)],
      metadata: {
        model,
        request_message_count: messages.length,
        tool_selection_only: hook === "BeforeToolSelection",
        reasoning_representation: "unavailable",
      },
    })] };
  }
  if (hook === "AfterModel") {
    const request = nestedRecord(payload, "llm_request");
    const response = nestedRecord(payload, "llm_response");
    if (response === null) return { raw, events: [] };
    const texts = responseText(response);
    const usage = geminiUsage(response.usageMetadata ?? response.usage_metadata);
    const model = request === null ? null : firstString(request, ["model"]);
    if (texts.length === 0) {
      return { raw, events: [make(0, {
        eventType: "model.inference",
        actor: "assistant",
        status: "partial",
        usage,
        metadata: { model, streaming_chunk: true, reasoning_representation: "unavailable" },
      })] };
    }
    return { raw, events: texts.map(({ text, index }, position) => make(position, {
      eventType: "message",
      actor: "assistant",
      status: "partial",
      content: [contentPart(text)],
      usage: position === 0 ? usage : {},
      metadata: {
        model,
        candidate_index: index,
        streaming_chunk: true,
        authoritative_final: false,
        reasoning_representation: "unavailable",
      },
    })) };
  }
  if (hook === "BeforeTool" || hook === "AfterTool") {
    const name = firstString(payload, ["tool_name"]);
    const identity = toolCallIdentity(payload, sessionId);
    const result = hook === "AfterTool" ? payload.tool_response ?? null : null;
    const response = isRecord(result) ? result : null;
    const failed = response !== null && response.error !== undefined && response.error !== null;
    const content: ContentPart[] = [contentPart(
      hook === "BeforeTool" ? payload.tool_input ?? null : result,
      0,
      { type: hook === "BeforeTool" ? "tool_call" : "tool_result" },
    )];
    return { raw, events: [make(0, {
      eventType: hook === "BeforeTool" ? "tool.call" : "tool.result",
      actor: hook === "BeforeTool" ? "assistant" : "tool",
      status: hook === "BeforeTool" ? "partial" : failed ? "error" : "ok",
      content,
      tool: toolShape(identity.callId, name, payload.tool_input, result),
      metadata: {
        synthetic_call_id: identity.synthetic,
        original_request_name: payload.original_request_name ?? null,
        mcp_context_present: isRecord(payload.mcp_context),
        dedupe_key: dedupeKey("gemini-tool", sessionId, identity.callId, hook),
      },
    })] };
  }
  if (hook === "Notification") {
    const notificationType = firstString(payload, ["notification_type"]);
    if (notificationType !== "ToolPermission") {
      // Notification is itself a documented hook. New notification variants
      // must not silently invalidate an otherwise valid capture, but they also
      // must not be promoted to approval decisions or training targets. Keep a
      // typed environment marker and leave the provider payload in encrypted
      // raw storage for a future, versioned projection.
      return { raw, events: [make(0, {
        eventType: "evaluation",
        actor: "environment",
        status: "partial",
        metadata: {
          notification_type: notificationType,
          opaque_notification: true,
          decision_observed: false,
        },
      })] };
    }
    return { raw, events: [make(0, {
      eventType: "approval.request",
      actor: "environment",
      status: "partial",
      content: [contentPart({ message: payload.message ?? null, details: payload.details ?? null })],
      metadata: {
        notification_type: notificationType,
        decision_observed: false,
      },
    })] };
  }
  if (hook === "PreCompress") {
    return { raw, events: [make(0, {
      eventType: "compaction",
      actor: "system",
      status: "partial",
      metadata: { trigger: payload.trigger ?? null, advisory_only: true },
    })] };
  }

  // Hook vocabulary drift has no invented projection. The live capture
  // publisher treats this empty result as a hard compatibility failure rather
  // than publishing a partial trace.
  return { raw, events: [] };
}

export function normalizeGeminiCliHookJsonl(input: string, options: NormalizeOptions = {}): NormalizedBatch {
  const parsed = parseJsonLines(input);
  const raw: NormalizedBatch["raw"] = [];
  const events: TrajectoryEvent[] = [];
  let sessionId = options.sessionId ?? null;
  for (const [sequence, value] of parsed.values.entries()) {
    sessionId = firstString(value, ["session_id"]) ?? sessionId;
    const nextOptions: NormalizeOptions = { ...options, sequence };
    if (sessionId !== null) nextOptions.sessionId = sessionId;
    const normalized = normalizeGeminiCliHook(value, nextOptions);
    raw.push(normalized.raw);
    events.push(...normalized.events);
  }
  return { raw, events: renumberEvents(events), diagnostics: parsed.diagnostics };
}
