import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { trajectoryEventSchema } from "@trajpack/schema";
import { describe, expect, it } from "vitest";

import {
  DEEPSEEK_HARNESS_INTERFACE_VERSION,
  DEEPSEEK_HARNESS_DURABLE_EVENT_TYPES,
  CLAUDE_TRANSCRIPT_OPAQUE_INTERFACE_VERSION,
  CODEX_APP_SERVER_INTERFACE_VERSION,
  classifyJsonLine,
  createRawEnvelope,
  normalizeClaudeHook,
  normalizeClaudeStreamJson,
  normalizeAuthorizedDomCapture,
  normalizeCodexAppServerEvent,
  normalizeCodexAppServerJsonl,
  normalizeCodexHook,
  normalizeCodexJsonl,
  normalizeDeepSeekSessionEvent,
  normalizeDeepSeekSessionJsonl,
  normalizeManualImport,
  normalizeRawEnvelope,
  parseJsonLines,
} from "./index.js";

const FIXED = "2026-08-16T00:00:00.000Z";
const TRACE_ID = "0123456789abcdef0123456789abcdef";

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}

function fixtureObjects(name: string): Record<string, unknown>[] {
  return parseJsonLines(fixture(name)).values;
}

function assertSchema(events: ReturnType<typeof normalizeCodexJsonl>["events"]): void {
  for (const event of events) trajectoryEventSchema.parse(event);
}

describe("Codex adapter", () => {
  it("normalizes JSONL reasoning and successful/failed command executions", () => {
    const normalized = normalizeCodexJsonl(fixture("codex.exec.jsonl"), { traceId: TRACE_ID, capturedAt: FIXED });
    assertSchema(normalized.events);
    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.events.map((event) => event.sequence)).toEqual(normalized.events.map((_, index) => index));

    const reasoning = normalized.events.find((event) => event.event_type === "reasoning");
    expect(reasoning?.content[0]?.reasoning?.representation).toBe("provider_summary");
    expect(reasoning?.content[0]?.reasoning?.include_in_loss).toBe(false);

    const results = normalized.events.filter((event) => event.event_type === "tool.result");
    expect(results.map((event) => [event.tool?.call_id, event.status, event.tool?.exit_code])).toEqual([
      ["call-ok", "ok", 0],
      ["call-fail", "error", 1],
    ]);
  });

  it("normalizes subagent and compaction hook events without reading transcript paths", () => {
    const events = fixtureObjects("codex.hooks.jsonl").flatMap((payload, sequence) =>
      normalizeCodexHook(payload, { traceId: TRACE_ID, sequence, capturedAt: FIXED }).events,
    );
    assertSchema(events);
    expect(events.map((event) => event.event_type)).toEqual(["agent.invoke", "handoff", "compaction", "compaction"]);
    expect(events.every((event) => !("transcript_path" in event.metadata))).toBe(true);
  });

  it("normalizes official App Server v2 JSON-RPC lifecycles with stable typed provenance", () => {
    const input = fixture("codex.app-server-v2.jsonl");
    const normalized = normalizeCodexAppServerJsonl(input, { traceId: TRACE_ID, capturedAt: FIXED });
    assertSchema(normalized.events);
    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.raw.every((raw) => raw.interface_version === CODEX_APP_SERVER_INTERFACE_VERSION)).toBe(true);
    expect(normalized.raw.every((raw) => raw.source_event_id?.startsWith("codex-app-server:") === true)).toBe(true);
    expect(new Set(normalized.raw.map((raw) => raw.source_event_id)).size).toBe(normalized.raw.length);

    const rerun = normalizeCodexAppServerJsonl(input, { traceId: TRACE_ID, capturedAt: FIXED });
    expect(rerun.raw.map((raw) => raw.source_event_id)).toEqual(normalized.raw.map((raw) => raw.source_event_id));
    expect(rerun.events.map((event) => event.event_id)).toEqual(normalized.events.map((event) => event.event_id));

    const reasoning = normalized.events.filter((event) => event.event_type === "reasoning");
    expect(reasoning.some((event) => event.content[0]?.reasoning?.representation === "provider_summary")).toBe(true);
    expect(reasoning.some((event) =>
      event.content[0]?.reasoning?.representation === "opaque_reasoning_state" &&
      event.content[0]?.reasoning?.provider_claim === "none"
    )).toBe(true);
    expect(reasoning.every((event) => event.content.every((part) => part.reasoning?.include_in_loss !== true))).toBe(true);

    const finalMessage = normalized.events.find((event) =>
      event.source_step_id === "app-message-1" && event.metadata.authoritative_final === true
    );
    expect(finalMessage).toMatchObject({ event_type: "message", status: "ok" });
    expect(finalMessage?.content[0]?.value).toBe("Adapter verified.");

    const denied = normalized.events.find((event) =>
      event.event_type === "approval.decision" && event.metadata.decision === "decline"
    );
    expect(denied).toMatchObject({ actor: "user", status: "cancelled" });
    expect(normalized.events.some((event) => event.event_type === "approval.request")).toBe(true);
    expect(normalized.events.some((event) =>
      event.event_type === "approval.decision" && event.metadata.resolution_only === true
    )).toBe(true);

    const retryError = normalized.events.find((event) => event.metadata.retry_attempt === 1);
    expect(retryError).toMatchObject({ event_type: "error", status: "error" });
    const retryResult = normalized.events.find((event) =>
      event.event_type === "tool.result" && event.tool?.call_id === "app-command-retry" &&
      event.metadata.authoritative_final === true
    );
    expect(retryResult).toMatchObject({ status: "ok", tool: { exit_code: 0 } });
    expect(normalized.events.some((event) =>
      event.event_type === "tool.result" && event.tool?.call_id === "app-command-retry" && event.status === "partial"
    )).toBe(true);
    expect(normalized.events.at(-1)).toMatchObject({ event_type: "evaluation", status: "cancelled" });
  });

  it("preserves App Server thread/turn/item parents and collab child links", () => {
    const events = normalizeCodexAppServerJsonl(fixture("codex.app-server-v2.jsonl"), {
      traceId: TRACE_ID,
      capturedAt: FIXED,
    }).events;
    const mainThread = events.find((event) =>
      event.source_session_id === "app-thread-main" && event.metadata.jsonrpc_method === "thread/started"
    );
    const turn = events.find((event) => event.metadata.jsonrpc_method === "turn/started");
    const item = events.find((event) =>
      event.source_step_id === "app-command-retry" && event.metadata.jsonrpc_method === "item/started"
    );
    expect(turn?.parent_span_id).toBe(mainThread?.span_id);
    expect(item?.parent_span_id).toBe(turn?.span_id);

    const childThread = events.find((event) =>
      event.source_session_id === "app-thread-child" && event.metadata.jsonrpc_method === "thread/started"
    );
    const handoff = events.find((event) =>
      event.event_type === "handoff" && event.source_step_id === "app-collab-1"
    );
    expect(childThread?.links).toContainEqual({
      trace_id: TRACE_ID,
      span_id: mainThread?.span_id,
      relation: "parent_thread",
    });
    expect(handoff?.links).toContainEqual({
      trace_id: TRACE_ID,
      span_id: childThread?.span_id,
      relation: "collab.receiver",
    });
  });

  it("classifies App Server JSONL separately and fails closed on an unknown Codex interface", () => {
    const line = fixture("codex.app-server-v2.jsonl").split(/\r?\n/)[0] ?? "";
    const envelope = classifyJsonLine("codex", line, 7);
    expect(envelope?.interface_version).toBe(CODEX_APP_SERVER_INTERFACE_VERSION);
    expect(normalizeRawEnvelope(envelope!, { traceId: TRACE_ID, nextSequence: 41 })[0]).toMatchObject({
      source_session_id: "app-thread-main",
      sequence: 41,
      event_type: "agent.invoke",
    });

    const payload = JSON.parse(line) as unknown;
    expect(normalizeCodexAppServerEvent(payload, {
      traceId: TRACE_ID,
      capturedAt: FIXED,
      interfaceVersion: "codex-app-server-v3-jsonrpc/1",
    }).events).toEqual([]);
    expect(normalizeRawEnvelope(
      { ...envelope!, interface_version: "codex-app-server-v3-jsonrpc/1" },
      { traceId: TRACE_ID, nextSequence: 0 },
    )).toEqual([]);
  });
});

describe("Claude Code adapter", () => {
  it("treats visible thinking as a provider summary and preserves tool outcomes", () => {
    const normalized = normalizeClaudeStreamJson(fixture("claude.stream.jsonl"), { traceId: TRACE_ID, capturedAt: FIXED });
    assertSchema(normalized.events);
    const reasoning = normalized.events.filter((event) => event.event_type === "reasoning");
    expect(reasoning.length).toBe(2);
    expect(reasoning.every((event) => event.content[0]?.reasoning?.representation === "provider_summary")).toBe(true);

    const results = normalized.events.filter((event) => event.event_type === "tool.result");
    expect(results.map((event) => [event.tool?.call_id, event.status])).toEqual([
      ["tool-ok", "ok"],
      ["tool-fail", "error"],
    ]);
  });

  it("normalizes subagents, compaction, and failed tool hooks", () => {
    const events = fixtureObjects("claude.hooks.jsonl").flatMap((payload, sequence) =>
      normalizeClaudeHook(payload, { traceId: TRACE_ID, sequence, capturedAt: FIXED }).events,
    );
    assertSchema(events);
    expect(events.map((event) => event.event_type)).toEqual(["agent.invoke", "handoff", "compaction", "tool.result"]);
    expect(events.at(-1)?.status).toBe("error");
  });

  it("keeps Claude thinking signatures opaque and out of canonical training content", () => {
    const signature = "opaque-provider-signature-must-not-be-exported";
    const redacted = "opaque-redacted-thinking-must-not-be-exported";
    const input = [
      JSON.stringify({
        type: "assistant",
        session_id: "claude-signature-session",
        message: {
          id: "signed-message",
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Provider-visible summary.", signature },
            { type: "redacted_thinking", data: redacted },
          ],
        },
      }),
      JSON.stringify({
        type: "stream_event",
        session_id: "claude-signature-session",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature },
        },
      }),
    ].join("\n");
    const normalized = normalizeClaudeStreamJson(input, { traceId: TRACE_ID, capturedAt: FIXED });
    assertSchema(normalized.events);
    const canonical = JSON.stringify(normalized.events);
    expect(canonical).toContain("Provider-visible summary.");
    expect(canonical).not.toContain(signature);
    expect(canonical).not.toContain(redacted);
    expect(normalized.events.filter((event) => event.event_type === "reasoning")).toHaveLength(2);
    expect(normalized.events.every((event) =>
      event.content.every((part) => part.reasoning?.include_in_loss !== true)
    )).toBe(true);
  });

  it("never normalizes or parses an opaque internal transcript artifact", () => {
    const payload = {
      bytes_base64: Buffer.from('{"type":"assistant","message":"must remain opaque"}\n').toString("base64"),
      path_hmac: "a".repeat(64),
      sha256: "b".repeat(64),
      size: 53,
      not_parsed: true,
    };
    const envelope = createRawEnvelope("claude_code", payload, {
      sequence: 9,
      capturedAt: FIXED,
      sessionId: "opaque-session",
    }, CLAUDE_TRANSCRIPT_OPAQUE_INTERFACE_VERSION);
    expect(normalizeRawEnvelope(envelope, { traceId: TRACE_ID, nextSequence: 40 })).toEqual([]);
  });
});

describe("DeepSeek Harness adapter", () => {
  it("preserves provider-exposed reasoning, durable topology, and tool outcomes", () => {
    const normalized = normalizeDeepSeekSessionJsonl(fixture("deepseek.session.jsonl"), {
      traceId: TRACE_ID,
      capturedAt: FIXED,
    });
    assertSchema(normalized.events);
    expect(normalized.events.find((event) => event.event_type === "reasoning")?.content[0]?.reasoning?.representation)
      .toBe("provider_exposed_reasoning");
    expect(normalized.events.filter((event) => event.event_type === "compaction")).toHaveLength(2);
    expect(normalized.events.filter((event) => event.event_type === "agent.invoke")).toHaveLength(2);
    expect(normalized.events.filter((event) => event.event_type === "handoff")).toHaveLength(0);
    const results = normalized.events.filter((event) => event.event_type === "tool.result");
    expect(results.map((event) => [event.tool?.call_id, event.status, event.tool?.exit_code])).toEqual([
      ["dsh-tool-ok", "ok", null],
      ["dsh-tool-fail", "error", null],
    ]);
  });

  it("fails closed at the collector boundary for every non-pinned session interface", () => {
    const line = fixture("deepseek.session.jsonl").split(/\r?\n/)[0] ?? "";
    const envelope = classifyJsonLine("deepseek_harness", line, 0);
    expect(envelope?.interface_version).toBe(DEEPSEEK_HARNESS_INTERFACE_VERSION);
    expect(normalizeRawEnvelope(envelope!, { traceId: TRACE_ID, nextSequence: 0 })).toHaveLength(1);

    for (const interfaceVersion of [
      "deepseek-harness-session-event/0",
      "deepseek-harness@0.1.0-rc.4/session-event/0",
      "deepseek-harness@0.1.0-rc.5/session-event/0",
      "deepseek-harness@0.1.0-rc.6/session-event/1",
      "deepseek-harness@0.1.0/session-event/0",
    ]) {
      expect(normalizeRawEnvelope(
        { ...envelope!, interface_version: interfaceVersion },
        { traceId: TRACE_ID, nextSequence: 0 },
      )).toEqual([]);
    }
  });

  it("uses the resolved provider route for reasoning claims and refuses persistence drift", () => {
    const payload = {
      session_id: "provider-neutral-session",
      session_header: { version: 0, id: "provider-neutral-session", parent_session: null, origin: "user" },
      route: { provider: "anthropic", model: "claude-sonnet" },
      event_id: "provider-neutral-session:0",
      timestamp: 1_786_800_000_000,
      event: {
        type: "assistant/chunk",
        seq: 0,
        time: 1_786_800_000_000,
        data: { turn: 0, step: 0, chunk: { type: "reasoning-delta", index: 0, text: "visible state" } },
      },
    };
    const normalized = normalizeDeepSeekSessionEvent(payload, { traceId: TRACE_ID, capturedAt: FIXED });
    expect(normalized.events[0]?.content[0]?.reasoning).toMatchObject({
      representation: "opaque_reasoning_state",
      provider_claim: "none",
      visibility: "api_only",
    });
    expect(normalizeDeepSeekSessionEvent({
      ...payload,
      session_header: { version: 1, id: "provider-neutral-session" },
    }, { traceId: TRACE_ID, capturedAt: FIXED }).events).toEqual([]);
    expect(normalizeDeepSeekSessionEvent({
      ...payload,
      event: { type: "future/required", seq: 0, time: 1_786_800_000_000, data: {} },
    }, { traceId: TRACE_ID, capturedAt: FIXED }).events).toEqual([]);
    const ignorable = normalizeDeepSeekSessionEvent({
      ...payload,
      event: { type: "plugin/telemetry", seq: 0, time: 1_786_800_000_000, data: {}, ignorable: true },
    }, { traceId: TRACE_ID, capturedAt: FIXED }).events;
    expect(ignorable).toHaveLength(1);
    expect(ignorable[0]).toMatchObject({
      event_type: "evaluation",
      status: "partial",
      metadata: {
        durable_event_type: "plugin/telemetry",
        source_event_ignorable: true,
        opaque_durable_event: true,
        training_semantics_available: false,
      },
    });
  });

  it("retains discontinuous rc.6 records as raw-only instead of reconstructing a partial branch", () => {
    const values = fixtureObjects("deepseek.session.jsonl").slice(0, 2).map((value) => structuredClone(value));
    const secondEvent = values[1]?.event;
    if (typeof secondEvent !== "object" || secondEvent === null || Array.isArray(secondEvent)) {
      throw new Error("fixture event missing");
    }
    secondEvent.seq = 2;
    values[1]!.event_id = "dsh-session-1:2";
    const normalized = normalizeDeepSeekSessionJsonl(values.map((value) => JSON.stringify(value)).join("\n"), {
      traceId: TRACE_ID,
      capturedAt: FIXED,
    });
    expect(normalized.raw).toHaveLength(2);
    expect(normalized.events.map((event) => event.metadata.durable_event_type)).toEqual(["request/header"]);
  });

  it("projects every recognized rc.6 durable type or emits an explicit opaque marker", () => {
    const dataFor = (type: string): Record<string, unknown> => {
      if (type === "assistant/chunk") {
        return { turn: 0, step: 0, chunk: { type: "block-start", index: 0, blockType: "text" } };
      }
      if (type === "assistant/message") {
        return { turn: 0, step: 0, message: {
          id: "assistant-empty", role: "assistant",
          source: { kind: "model", provider: "deepseek-official", model: "deepseek-reasoner" },
          content: [],
        } };
      }
      if (type === "user/message") {
        return { id: "user-empty", role: "user", source: { kind: "user" }, content: [] };
      }
      if (type === "tool/result") {
        return { turn: 0, step: 0, message: {
          id: "tool-result", role: "user", source: { kind: "tool", callId: "call-1" },
          content: [{ type: "tool-result", toolCallId: "call-1", content: [] }],
        } };
      }
      if (type === "subagent/descriptor") {
        return { version: 2, mode: "one-shot", provider: "in-process" };
      }
      if (type === "turn/end") return { turn: 0, reason: { kind: "completed" } };
      return { turn: 0, step: 0 };
    };

    for (const type of DEEPSEEK_HARNESS_DURABLE_EVENT_TYPES) {
      const normalized = normalizeDeepSeekSessionEvent({
        session_id: "catalog-session",
        session_header: { version: 0, id: "catalog-session", parent_session: null, origin: "user" },
        route: { provider: "deepseek-official", model: "deepseek-reasoner" },
        event_id: `catalog-session:${type}`,
        timestamp: 1_786_800_000_000,
        event: { type, seq: 0, time: 1_786_800_000_000, data: dataFor(type) },
      }, { traceId: TRACE_ID, capturedAt: FIXED });
      expect(normalized.events.length, type).toBeGreaterThan(0);
    }
  });
});

describe("collector-facing API", () => {
  it("classifies one JSON line and assigns the caller's canonical sequence", () => {
    const line = fixture("codex.exec.jsonl").split(/\r?\n/)[0];
    expect(line).toBeTypeOf("string");
    const envelope = classifyJsonLine("codex", line ?? "", 7);
    expect(envelope).not.toBeNull();
    const events = normalizeRawEnvelope(envelope!, { traceId: TRACE_ID, nextSequence: 41 });
    expect(events[0]?.trace_id).toBe(TRACE_ID);
    expect(events[0]?.sequence).toBe(41);
    expect(events[0]?.source_session_id).toBe("codex-session-1");
  });

  it("fails closed for malformed and unsupported JSONL", () => {
    expect(classifyJsonLine("codex", "not-json", 0)).toBeNull();
    expect(classifyJsonLine("browser", "not-json", 0)).toBeNull();
  });

  it("normalizes authorized DOM captures into ordered messages", () => {
    const normalized = normalizeAuthorizedDomCapture({
      record_kind: "authorized_dom_capture",
      provenance: {
        source_origin: "https://owned.example",
        selector_recipe_id: "owned-chat-v1",
        selector_recipe_version: "1",
        selector_recipe_sha256: "a".repeat(64),
      },
      capture: {
        session_id: "browser-session-1",
        page: { origin: "https://owned.example", title: "Owned chat" },
        recipe: {
          recipe_id: "owned-chat-v1",
          version: "1",
          origin: "https://owned.example",
          recipe_sha256: "a".repeat(64),
          authorization: {
            basis: "site_owner",
            evidence_ref: "consent-1",
            attested_by: "owner",
            expires_at: "2099-01-01T00:00:00.000Z",
          },
        },
        messages: [
          { sequence: 2, role: "assistant", text: "World" },
          { sequence: 1, role: "user", text: "Hello" },
        ],
      },
    }, { traceId: TRACE_ID, capturedAt: FIXED });
    assertSchema(normalized.events);
    expect(normalized.events.map((event) => [event.actor, event.content[0]?.value])).toEqual([
      ["user", "Hello"],
      ["assistant", "World"],
    ]);
    expect(normalized.events[0]?.metadata).toMatchObject({
      origin: "https://owned.example",
      recipe_id: "owned-chat-v1",
      recipe_version: "1",
      recipe_sha256: "a".repeat(64),
      authorization_basis: "site_owner",
      authorization_ref: "consent-1",
    });
  });

  it("normalizes manual imported records and exposes them through the generic API", () => {
    const payload = {
      record_kind: "imported_record",
      provenance: { source: "official_export", format: "example/1" },
      record: {
        conversation_id: "import-session-1",
        messages: [
          { id: "m1", role: "user", content: "Question" },
          { id: "m2", role: "assistant", content: [{ type: "text", text: "Answer" }] },
        ],
      },
    };
    const normalized = normalizeManualImport(payload, { traceId: TRACE_ID, capturedAt: FIXED });
    assertSchema(normalized.events);
    expect(normalized.events).toHaveLength(2);

    const envelope = classifyJsonLine("manual_import", JSON.stringify(payload), 9);
    expect(envelope).not.toBeNull();
    expect(normalizeRawEnvelope(envelope!, { traceId: TRACE_ID, nextSequence: 70 }).map((event) => event.sequence))
      .toEqual([70, 71]);
  });

  it("normalizes conservative ChatGPT and Claude official export records", () => {
    const chatGpt = normalizeManualImport({
      record_kind: "imported_record",
      provenance: { detected_format: "chatgpt_official_json", source_product: "chatgpt" },
      record: {
        id: "chatgpt-conversation",
        mapping: {
          root: {
            parent: null,
            message: { id: "m-user", author: { role: "user" }, create_time: 1, content: { parts: ["Question"] } },
          },
          answer: {
            parent: "m-user",
            message: { id: "m-assistant", author: { role: "assistant" }, create_time: 2, content: { parts: ["Answer"] } },
          },
        },
      },
    }, { traceId: TRACE_ID, capturedAt: FIXED });
    assertSchema(chatGpt.events);
    expect(chatGpt.events.map((event) => [event.actor, event.content[0]?.value])).toEqual([
      ["user", "Question"],
      ["assistant", "Answer"],
    ]);
    expect(chatGpt.events[1]?.parent_span_id).toBe(chatGpt.events[0]?.span_id);

    const claude = normalizeManualImport({
      record_kind: "imported_record",
      provenance: { detected_format: "claude_official_json", source_product: "claude" },
      record: {
        uuid: "claude-conversation",
        chat_messages: [
          { uuid: "c-user", sender: "human", text: "Hello" },
          { uuid: "c-assistant", sender: "assistant", text: "Hi" },
        ],
      },
    }, { traceId: TRACE_ID, capturedAt: FIXED });
    assertSchema(claude.events);
    expect(claude.events.map((event) => [event.actor, event.content[0]?.value])).toEqual([
      ["user", "Hello"],
      ["assistant", "Hi"],
    ]);
  });

  it("normalizes imported DeepSeek API reasoning, messages, tools, usage, and choice provenance", () => {
    const record = JSON.parse(fixture("deepseek-api.response.json")) as unknown;
    const normalized = normalizeManualImport({
      record_kind: "imported_record",
      provenance: {
        detected_format: "deepseek_api_response",
        source_product: "deepseek_api",
        source_authenticity: "unverified_user_supplied",
      },
      record,
    }, { traceId: TRACE_ID, capturedAt: FIXED });
    assertSchema(normalized.events);
    expect(normalized.events.map((event) => event.event_type)).toEqual([
      "reasoning",
      "tool.call",
      "reasoning",
      "message",
    ]);

    const firstReasoning = normalized.events[0]!;
    expect(firstReasoning.content[0]?.reasoning).toMatchObject({
      representation: "provider_exposed_reasoning",
      source_field: "reasoning_content",
      visibility: "api_only",
    });
    expect(firstReasoning.metadata).toMatchObject({
      import_format: "deepseek_api_response",
      import_source: "deepseek_api",
      api_model: "deepseek-reasoner",
      choice_index: 0,
      finish_reason: "tool_calls",
      provider_exposed_field: "reasoning_content",
    });
    expect(firstReasoning.usage).toMatchObject({
      input_tokens: 24,
      output_tokens: 18,
      reasoning_tokens: 11,
      cache_read_tokens: 8,
    });
    expect(normalized.events.filter((event) => event.usage.input_tokens !== null)).toHaveLength(1);

    const tool = normalized.events[1]!;
    expect(tool.tool).toMatchObject({
      call_id: "call_fixture_1",
      name: "get_weather",
      arguments: "{\"city\":\"Hangzhou\"}",
    });
    expect(tool.metadata).toMatchObject({ choice_index: 0, tool_call_index: 0 });
    expect(normalized.events[3]?.metadata).toMatchObject({ choice_index: 1, finish_reason: "stop" });

    const generic = normalizeManualImport({
      record_kind: "imported_record",
      provenance: { detected_format: "generic_json", source_product: "generic" },
      record,
    }, { traceId: TRACE_ID, capturedAt: FIXED });
    expect(generic.events).toEqual([]);
  });

  it("preserves DeepSeek API delta status and usage-only terminal chunks", () => {
    const provenance = { detected_format: "deepseek_api_response", source_product: "deepseek_api" };
    const delta = normalizeManualImport({
      record_kind: "imported_record",
      provenance,
      record: {
        id: "chatcmpl-stream",
        object: "chat.completion.chunk",
        created: 1786838400,
        model: "deepseek-reasoner",
        choices: [{ index: 0, delta: { reasoning_content: "Inspect first." }, finish_reason: null }],
      },
    }, { traceId: TRACE_ID, capturedAt: FIXED });
    assertSchema(delta.events);
    expect(delta.events[0]).toMatchObject({ event_type: "reasoning", status: "partial" });

    const terminal = normalizeManualImport({
      record_kind: "imported_record",
      provenance,
      record: {
        id: "chatcmpl-stream",
        object: "chat.completion.chunk",
        created: 1786838400,
        model: "deepseek-reasoner",
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
    }, { traceId: TRACE_ID, capturedAt: FIXED });
    assertSchema(terminal.events);
    expect(terminal.events).toHaveLength(1);
    expect(terminal.events[0]).toMatchObject({
      event_type: "model.inference",
      status: "ok",
      usage: { input_tokens: 5, output_tokens: 3 },
      metadata: { usage_only_api_chunk: true },
    });
  });

  it("keeps hook forwarding scripts silent and successful while unarmed", () => {
    const env = { ...process.env };
    delete env.TRAJPACK_COLLECTOR_URL;
    delete env.TRAJPACK_CAPTURE_TOKEN;
    const scripts = [
      new URL("../../../plugins/trajpack/scripts/forward-hook.mjs", import.meta.url),
      new URL("../../../plugins/claude-code/scripts/forward-hook.mjs", import.meta.url),
    ];
    for (const script of scripts) {
      const result = spawnSync(process.execPath, [fileURLToPath(script)], {
        input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "private prompt" }),
        encoding: "utf8",
        env,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    }
  });
});
