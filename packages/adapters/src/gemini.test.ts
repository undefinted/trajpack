import { readFileSync } from "node:fs";

import { trajectoryEventSchema } from "@trajpack/schema";
import { describe, expect, it } from "vitest";

import { classifyJsonLine, normalizeRawEnvelope } from "./index.js";
import {
  GEMINI_CLI_HOOK_INTERFACE_VERSION,
  normalizeGeminiCliHook,
  normalizeGeminiCliHookJsonl,
} from "./gemini.js";

const TRACE_ID = "aabbccddaabbccddaabbccddaabbccdd";
const FIXED = "2026-08-16T04:00:00.000Z";

function fixture(): string {
  return readFileSync(new URL("../fixtures/gemini.hooks.matrix-v1.jsonl", import.meta.url), "utf8");
}

describe("Gemini CLI hook adapter", () => {
  it("normalizes the documented model, tool, permission, session, and compaction hooks", () => {
    const normalized = normalizeGeminiCliHookJsonl(fixture(), { traceId: TRACE_ID, capturedAt: FIXED });
    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.raw.every((raw) => raw.interface_version === GEMINI_CLI_HOOK_INTERFACE_VERSION)).toBe(true);
    for (const event of normalized.events) trajectoryEventSchema.parse(event);

    expect(normalized.events.map((event) => event.sequence)).toEqual(
      normalized.events.map((_, index) => index),
    );
    expect(normalized.events.some((event) => event.event_type === "agent.invoke")).toBe(true);
    expect(normalized.events.some((event) => event.event_type === "compaction")).toBe(true);
    expect(normalized.events.find((event) => event.event_type === "approval.request"))
      .toMatchObject({ status: "partial", metadata: { decision_observed: false } });

    const calls = normalized.events.filter((event) => event.event_type === "tool.call");
    const results = normalized.events.filter((event) => event.event_type === "tool.result");
    expect(calls).toHaveLength(2);
    expect(results).toHaveLength(2);
    expect(calls.every((event) => event.metadata.synthetic_call_id === true)).toBe(true);
    expect(results.map((event) => event.status)).toEqual(["error", "ok"]);
    expect(new Set(calls.map((event) => event.tool?.call_id))).toEqual(
      new Set(results.map((event) => event.tool?.call_id)),
    );

    const streamed = normalized.events.find((event) => event.metadata.streaming_chunk === true);
    expect(streamed).toMatchObject({
      event_type: "model.inference",
      status: "partial",
      review_disposition: "exclude",
      content: [expect.objectContaining({ review_disposition: "exclude" })],
      usage: { input_tokens: 17, output_tokens: 9, reasoning_tokens: 3 },
      metadata: {
        model: "gemini-2.5-pro",
        reasoning_representation: "unavailable",
        training_excluded: true,
        exclusion_reason: "GEMINI_HOOK_MODEL_CONTENT_SEMANTICS_AMBIGUOUS",
      },
    });
    expect(normalized.events.filter((event) => event.event_type === "reasoning")).toEqual([]);
    expect(normalized.events.every((event) => !("transcript_path" in event.metadata))).toBe(true);
  });

  it("uses the provider candidate index, not the text-list position", () => {
    const normalized = normalizeGeminiCliHook({
      session_id: "gemini-session",
      hook_event_name: "AfterModel",
      llm_response: {
        candidates: [
          { index: 0, content: { parts: [{ text: "" }] } },
          { index: 1, content: { parts: [{ text: "the real answer" }] } },
        ],
      },
    }, { traceId: TRACE_ID, capturedAt: FIXED });

    expect(normalized.events).toHaveLength(1);
    expect(normalized.events[0]?.metadata.candidate_index).toBe(1);
    expect(normalized.events[0]?.content[0]?.value).toBe("the real answer");
    expect(normalized.events[0]).toMatchObject({
      event_type: "model.inference",
      review_disposition: "exclude",
      content: [expect.objectContaining({ review_disposition: "exclude" })],
    });
  });

  it("fails closed on an interface version mismatch and unknown hook vocabulary", () => {
    const payload = { session_id: "gemini-session", hook_event_name: "BeforeAgent", prompt: "hello" };
    const wrong = normalizeGeminiCliHook(payload, {
      traceId: TRACE_ID,
      capturedAt: FIXED,
      interfaceVersion: "gemini-cli-hook/2",
    });
    expect(wrong.events).toEqual([]);
    expect(classifyJsonLine("gemini_cli", JSON.stringify(payload), 0, "gemini-cli-hook/2")).toBeNull();

    const unknown = normalizeGeminiCliHook({ ...payload, hook_event_name: "FutureHook" }, {
      traceId: TRACE_ID,
      capturedAt: FIXED,
    });
    expect(unknown.events).toEqual([]);
  });

  it("retains documented non-permission notifications without inventing an approval", () => {
    const normalized = normalizeGeminiCliHook({
      session_id: "gemini-session",
      hook_event_name: "Notification",
      notification_type: "IdlePrompt",
      message: "provider-controlled notification",
    }, { traceId: TRACE_ID, capturedAt: FIXED });

    expect(normalized.events).toHaveLength(1);
    expect(normalized.events[0]).toMatchObject({
      event_type: "evaluation",
      actor: "environment",
      status: "partial",
      content: [],
      metadata: {
        notification_type: "IdlePrompt",
        opaque_notification: true,
        decision_observed: false,
      },
    });
  });

  it("keeps Gemini thought signatures in encrypted raw and out of canonical projections", () => {
    const secret = "opaque-thought-signature-that-must-not-export";
    const beforeModel = normalizeGeminiCliHook({
      session_id: "gemini-session",
      hook_event_name: "BeforeModel",
      llm_request: {
        model: "gemini-test",
        contents: [{ parts: [
          { text: "visible context", thoughtSignature: secret },
          { thought_signature: `${secret}-snake` },
        ] }],
      },
    }, { traceId: TRACE_ID, capturedAt: FIXED });
    expect(JSON.stringify(beforeModel.raw.payload)).toContain(secret);
    expect(JSON.stringify(beforeModel.events)).not.toContain(secret);
    expect(beforeModel.events[0]).toMatchObject({
      metadata: { opaque_provider_state_removed: 2, opaque_provider_state_scan_truncated: false },
    });

    const tool = normalizeGeminiCliHook({
      session_id: "gemini-session",
      hook_event_name: "BeforeTool",
      tool_name: "example",
      tool_input: { visible: true, nested: { thoughtSignature: secret } },
    }, { traceId: TRACE_ID, capturedAt: FIXED });
    expect(JSON.stringify(tool.raw.payload)).toContain(secret);
    expect(JSON.stringify(tool.events)).not.toContain(secret);
    expect(tool.events[0]?.tool?.arguments).toEqual({ visible: true, nested: {} });
  });

  it("routes an encrypted raw envelope only through the exact pinned adapter", () => {
    const raw = classifyJsonLine("gemini_cli", JSON.stringify({
      session_id: "gemini-session",
      hook_event_name: "BeforeAgent",
      prompt: "hello",
    }), 4, GEMINI_CLI_HOOK_INTERFACE_VERSION);
    expect(raw).not.toBeNull();
    const events = normalizeRawEnvelope(raw!, { traceId: TRACE_ID, nextSequence: 11 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: "message",
      actor: "user",
      sequence: 11,
      source_session_id: "gemini-session",
      metadata: { interface_version: GEMINI_CLI_HOOK_INTERFACE_VERSION },
    });
  });
});
