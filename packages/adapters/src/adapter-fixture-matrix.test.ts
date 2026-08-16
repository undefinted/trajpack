import { readFileSync } from "node:fs";

import { trajectoryEventSchema, type TrajectoryEvent } from "@trajpack/schema";
import { describe, expect, it } from "vitest";

import { normalizeClaudeHook, normalizeClaudeStreamJson } from "./claude.js";
import { parseJsonLines } from "./common.js";
import { normalizeCodexHook, normalizeCodexJsonl } from "./codex.js";
import { normalizeDeepSeekSessionJsonl } from "./deepseek.js";

const TRACE_ID = "fedcba9876543210fedcba9876543210";
const PARENT_SPAN_ID = "cafebabecafebabe";
const FIXED = "2026-08-16T04:00:00.000Z";

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}

function fixtureObjects(name: string): Record<string, unknown>[] {
  return parseJsonLines(fixture(name)).values;
}

function normalizeHooks(
  name: string,
  normalize: (payload: unknown, options: {
    traceId: string;
    parentSpanId: string;
    capturedAt: string;
    sequence: number;
  }) => { events: TrajectoryEvent[] },
): TrajectoryEvent[] {
  return fixtureObjects(name).flatMap((payload, sequence) => normalize(payload, {
    traceId: TRACE_ID,
    parentSpanId: PARENT_SPAN_ID,
    capturedAt: FIXED,
    sequence,
  }).events);
}

function assertValidTopology(events: TrajectoryEvent[]): void {
  expect(events.length).toBeGreaterThan(0);
  for (const event of events) {
    trajectoryEventSchema.parse(event);
    expect(event.trace_id).toBe(TRACE_ID);
    expect(event.parent_span_id).toBe(PARENT_SPAN_ID);
    expect(event.links).toEqual([]);
  }
  expect(new Set(events.map((event) => event.span_id)).size).toBe(events.length);
}

function assertToolPairs(events: TrajectoryEvent[], expected: ReadonlyArray<[string, TrajectoryEvent["status"]]>): void {
  const calls = events.filter((event) => event.event_type === "tool.call" && event.tool?.call_id !== null);
  const results = events.filter((event) => event.event_type === "tool.result" && event.tool?.call_id !== null);
  const callIds = new Set(calls.map((event) => event.tool!.call_id));
  for (const result of results) expect(callIds.has(result.tool!.call_id)).toBe(true);
  expect(results.map((event) => [event.tool!.call_id!, event.status])).toEqual(expected);
}

function assertParallelCallsPrecedeFirstResult(events: TrajectoryEvent[], callIds: readonly string[]): void {
  const positions = callIds.map((callId) => events.findIndex(
    (event) => event.event_type === "tool.call" && event.tool?.call_id === callId,
  ));
  const firstResult = events.findIndex((event) => event.event_type === "tool.result");
  expect(positions.every((position) => position >= 0 && position < firstResult)).toBe(true);
}

describe("versioned native adapter acceptance fixtures", () => {
  it("covers Codex exec parallel outcomes, cancellation, summary reasoning, and hook lifecycle", () => {
    const stream = normalizeCodexJsonl(fixture("codex.exec.matrix-v1.jsonl"), {
      traceId: TRACE_ID,
      parentSpanId: PARENT_SPAN_ID,
      capturedAt: FIXED,
    });
    const hooks = normalizeHooks("codex.hooks.matrix-v1.jsonl", normalizeCodexHook);
    const events = [...stream.events, ...hooks];
    assertValidTopology(events);

    assertParallelCallsPrecedeFirstResult(stream.events, ["codex-parallel-a", "codex-parallel-b"]);
    assertToolPairs(stream.events, [
      ["codex-parallel-b", "error"],
      ["codex-parallel-a", "ok"],
      ["codex-cancelled", "cancelled"],
      ["codex-retry", "ok"],
    ]);
    expect(stream.events.find((event) => event.event_type === "reasoning")?.content[0]?.reasoning)
      .toMatchObject({ representation: "provider_summary", provider_claim: "reasoning_summary" });
    expect(stream.events.some((event) => event.status === "partial")).toBe(true);
    expect(stream.raw.some((raw) => {
      const payload = raw.payload as { item?: { retry?: boolean } };
      return payload.item?.retry === true;
    })).toBe(true);

    expect(hooks.map((event) => event.event_type)).toEqual([
      "approval.request",
      "agent.invoke",
      "handoff",
      "compaction",
      "compaction",
    ]);
    const [invoke, handoff] = [
      hooks.find((event) => event.event_type === "agent.invoke"),
      hooks.find((event) => event.event_type === "handoff"),
    ];
    expect(invoke?.source_step_id).toBe("codex-child");
    expect(handoff?.source_step_id).toBe(invoke?.source_step_id);
  });

  it("covers Claude stream parallel outcomes, partial deltas, retry, cancellation, denial, and subagent lifecycle", () => {
    const stream = normalizeClaudeStreamJson(fixture("claude.stream.matrix-v1.jsonl"), {
      traceId: TRACE_ID,
      parentSpanId: PARENT_SPAN_ID,
      capturedAt: FIXED,
    });
    const hooks = normalizeHooks("claude.hooks.matrix-v1.jsonl", normalizeClaudeHook);
    const events = [...stream.events, ...hooks];
    assertValidTopology(events);

    assertParallelCallsPrecedeFirstResult(stream.events, ["claude-parallel-a", "claude-parallel-b"]);
    assertToolPairs(stream.events, [
      ["claude-parallel-b", "error"],
      ["claude-parallel-a", "ok"],
      ["claude-retry", "ok"],
    ]);
    const reasoning = stream.events.filter((event) => event.event_type === "reasoning");
    expect(reasoning).toHaveLength(2);
    expect(reasoning.every((event) =>
      event.content[0]?.reasoning?.representation === "provider_summary" &&
      event.content[0]?.reasoning?.provider_claim === "reasoning_summary"
    )).toBe(true);
    expect(reasoning.some((event) => event.status === "partial")).toBe(true);
    expect(stream.events.some((event) =>
      event.status === "partial" && event.event_type === "tool.call" && event.tool?.call_id === null
    )).toBe(true);
    expect(stream.events.some((event) => event.status === "cancelled")).toBe(true);
    expect(stream.events.some((event) => event.metadata.retry === true && event.metadata.retry_count === 1)).toBe(true);

    expect(hooks.map((event) => event.event_type)).toEqual([
      "approval.decision",
      "agent.invoke",
      "handoff",
      "compaction",
    ]);
    expect(hooks[0]).toMatchObject({ status: "cancelled", metadata: { approval_decision: "deny" } });
    expect(hooks[1]?.source_step_id).toBe("claude-child");
    expect(hooks[2]?.source_step_id).toBe(hooks[1]?.source_step_id);
  });

  it("covers exact DeepSeek Harness rc.6 durable events without downgrading provider-exposed reasoning", () => {
    const normalized = normalizeDeepSeekSessionJsonl(fixture("deepseek.session.matrix-rc6.jsonl"), {
      traceId: TRACE_ID,
      parentSpanId: PARENT_SPAN_ID,
      capturedAt: FIXED,
      interfaceVersion: "deepseek-harness@0.1.0-rc.6/session-event/0",
    });
    assertValidTopology(normalized.events);
    expect(normalized.raw.every((raw) =>
      raw.interface_version === "deepseek-harness@0.1.0-rc.6/session-event/0"
    )).toBe(true);

    assertParallelCallsPrecedeFirstResult(normalized.events, ["dsh-parallel-a", "dsh-parallel-b"]);
    assertToolPairs(normalized.events, [
      ["dsh-parallel-b", "error"],
      ["dsh-parallel-a", "ok"],
      ["dsh-retry", "ok"],
    ]);
    expect(normalized.events.find((event) => event.event_type === "reasoning")?.content[0]?.reasoning)
      .toMatchObject({
        representation: "provider_exposed_reasoning",
        provider_claim: "chain_of_thought",
        source_field: "reasoning_content",
        visibility: "api_only",
      });
    expect(normalized.events.some((event) => event.event_type === "message" && event.status === "partial")).toBe(true);
    expect(normalized.events.some((event) => event.metadata.retry === true)).toBe(true);
    expect(normalized.events.find((event) => event.event_type === "approval.decision"))
      .toMatchObject({ status: "cancelled", metadata: { approval_decision: "deny" } });
    expect(normalized.events.filter((event) => event.event_type === "compaction")).toHaveLength(2);
    expect(normalized.events.some((event) => event.status === "cancelled")).toBe(true);

    const invoke = normalized.events.find((event) =>
      event.event_type === "agent.invoke" && event.source_step_id === "dsh-child"
    );
    const handoff = normalized.events.find((event) => event.event_type === "handoff");
    expect(invoke).toBeDefined();
    expect(handoff?.source_step_id).toBe(invoke?.source_step_id);
  });
});
