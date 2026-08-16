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
      event_type: "message",
      status: "partial",
      usage: { input_tokens: 17, output_tokens: 9, reasoning_tokens: 3 },
      metadata: { model: "gemini-2.5-pro", reasoning_representation: "unavailable" },
    });
    expect(normalized.events.filter((event) => event.event_type === "reasoning")).toEqual([]);
    expect(normalized.events.every((event) => !("transcript_path" in event.metadata))).toBe(true);
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
