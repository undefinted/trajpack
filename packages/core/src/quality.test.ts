import type { TraceBundle, TrajectoryEvent } from "@trajpack/schema";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "./canonical.js";
import { inspectQuality } from "./quality.js";
import { fixtureBundle } from "./testing.js";

type EventOverrides = Partial<TrajectoryEvent>;
let nextEventId = 0;

function makeEvent(sequence: number, eventType: TrajectoryEvent["event_type"], overrides: EventOverrides = {}): TrajectoryEvent {
  const fixture = fixtureBundle();
  const base = structuredClone(fixture.events[0]!);
  const startedAt = new Date(Date.parse("2026-08-16T00:00:00.000Z") + sequence * 1_000).toISOString();
  return {
    ...base,
    event_id: `evt_${sequence}_${eventType}_${nextEventId++}`,
    span_id: Math.max(0, sequence + 1).toString(16).padStart(16, "0").slice(-16),
    sequence,
    started_at: startedAt,
    ended_at: startedAt,
    event_type: eventType,
    actor: eventType === "tool.result" ? "tool" : "assistant",
    status: "ok",
    content: [],
    tool: null,
    metadata: {},
    ...overrides,
  };
}

function tool(callId: string, name = "shell", argumentsValue: unknown = null, result: unknown = null, exitCode: number | null = null): NonNullable<TrajectoryEvent["tool"]> {
  return { call_id: callId, name, arguments: argumentsValue, result, exit_code: exitCode };
}

function textContent(value: string): TrajectoryEvent["content"] {
  return [{
    ...structuredClone(fixtureBundle().events[0]!.content[0]!),
    value,
    sha256: sha256(value),
  }];
}

function bundleWith(events: TrajectoryEvent[], mutate?: (bundle: TraceBundle) => void): TraceBundle {
  const bundle = fixtureBundle();
  bundle.events = events;
  mutate?.(bundle);
  return bundle;
}

function codes(report: ReturnType<typeof inspectQuality>): Set<string> {
  return new Set(report.issues.map((issue) => issue.code));
}

function expectCodes(report: ReturnType<typeof inspectQuality>, expected: string[]): void {
  expect([...codes(report)]).toEqual(expect.arrayContaining(expected));
}

describe("quality inspection", () => {
  it("preserves the compatibility metrics for a simple deterministic fixture", () => {
    const report = inspectQuality(fixtureBundle());

    expect(report.passed).toBe(true);
    expect(report.metrics).toMatchObject({
      event_count: 1,
      tool_call_count: 0,
      tool_result_count: 0,
      failed_event_count: 0,
      verified_action_ratio: 1,
      reasoning_part_count: 0,
      sequence_gap_count: 0,
      exact_duplicate_text_count: 0,
      egs_completeness_ratio: 1,
      tor_completeness_ratio: 1,
    });
  });

  it("detects sequence defects, duplicate tool identities, ordering, and a parallel call group", () => {
    const events = [
      makeEvent(0, "tool.call", { tool: tool("a") }),
      makeEvent(2, "tool.call", { tool: tool("b") }),
      makeEvent(3, "tool.result", { tool: tool("b", "shell", null, "b-result", 0) }),
      makeEvent(4, "tool.result", { tool: tool("a", "shell", null, "a-result", 0) }),
      makeEvent(5, "tool.call", { tool: tool("a") }),
      makeEvent(5, "tool.result", { tool: tool("a", "shell", null, "a-result-again", 0) }),
      makeEvent(6, "tool.result", { tool: tool("c", "shell", null, "premature", 0) }),
      makeEvent(7, "tool.call", { tool: tool("c") }),
    ];

    const report = inspectQuality(bundleWith(events));

    expect(report.passed).toBe(false);
    expect(report.metrics).toMatchObject({
      sequence_gap_count: 1,
      duplicate_sequence_count: 1,
      duplicate_tool_call_id_count: 1,
      duplicate_tool_result_count: 1,
      out_of_order_tool_result_count: 1,
      ordered_tool_pair_count: 2,
      parallel_tool_call_group_count: 1,
      parallel_tool_call_count: 1,
    });
    expectCodes(report, [
      "SEQUENCE_GAP",
      "DUPLICATE_SEQUENCE",
      "DUPLICATE_TOOL_CALL_ID",
      "DUPLICATE_TOOL_RESULT",
      "TOOL_RESULT_BEFORE_CALL",
    ]);
  });

  it("reports lifecycle, compaction, subagent topology, cancellation, and recovery evidence", () => {
    const invoke = makeEvent(0, "agent.invoke", { status: "partial", source_step_id: "child-1", metadata: { agent_type: "worker" } });
    const events = [
      invoke,
      makeEvent(1, "compaction", { status: "partial", actor: "system", metadata: { phase: "before" } }),
      makeEvent(2, "model.inference", { status: "partial" }),
      makeEvent(3, "model.inference", { status: "cancelled" }),
      makeEvent(4, "handoff", {
        actor: "agent",
        source_step_id: "child-2",
        parent_span_id: "ffffffffffffffff",
        links: [{ trace_id: invoke.trace_id, span_id: "eeeeeeeeeeeeeeee", relation: "child" }],
      }),
      makeEvent(5, "error", { actor: "environment", status: "error" }),
      makeEvent(6, "tool.call", { status: "partial", tool: tool("retry-test", "shell", { command: "pnpm test" }), metadata: { retry: true } }),
      makeEvent(7, "tool.result", { actor: "tool", tool: tool("retry-test", "shell", null, "passed", 0) }),
      makeEvent(8, "evaluation", { actor: "environment", metadata: { verifier: { name: "tests", version: "1.2.0" } } }),
      makeEvent(9, "agent.invoke", { actor: "agent", status: "partial", source_step_id: "child-3", metadata: { agent_type: "worker" } }),
      makeEvent(10, "handoff", { actor: "agent", source_step_id: "child-3", metadata: { agent_type: "worker" } }),
    ];

    const report = inspectQuality(bundleWith(events));

    expect(report.metrics).toMatchObject({
      retry_event_count: 1,
      compaction_event_count: 1,
      unpaired_compaction_boundary_count: 1,
      cancelled_event_count: 1,
      subagent_invoke_count: 2,
      handoff_count: 2,
      unpaired_subagent_count: 2,
      missing_parent_span_count: 1,
      missing_link_span_count: 1,
      missing_subagent_edge_count: 1,
      first_error_sequence: 5,
      recovery_after_error_count: 2,
    });
    expectCodes(report, [
      "RETRY_ACTIVITY_OBSERVED",
      "PARTIAL_EVENTS_PRESENT",
      "CANCELLED_EVENTS_PRESENT",
      "COMPACTION_BOUNDARY_MISMATCH",
      "SUBAGENT_HANDOFF_MISSING",
      "ORPHAN_HANDOFF",
      "SUBAGENT_TOPOLOGY_EDGE_MISSING",
      "MISSING_PARENT_SPAN",
      "MISSING_LINKED_SPAN",
    ]);
  });

  it("counts versioned repo/patch/test/verifier evidence and complete EGS/TOR without inventing success", () => {
    const events = [
      makeEvent(0, "artifact.read", { actor: "environment", content: textContent("Observed the current parser source." ) }),
      makeEvent(1, "tool.call", { status: "partial", tool: tool("test-1", "shell", { command: "pnpm test" }) }),
      makeEvent(2, "tool.result", { actor: "tool", status: "error", tool: tool("test-1", "shell", null, "tests failed", 1) }),
      makeEvent(3, "artifact.patch", { actor: "agent", content: [{ ...textContent("@@ deterministic patch @@")[0]!, type: "patch" }] }),
      makeEvent(4, "evaluation", { actor: "environment", status: "error", metadata: { verifier: { name: "repo-tests", version: "2026.08" } } }),
    ];
    const report = inspectQuality(bundleWith(events, (bundle) => {
      bundle.manifest.environment.repo_commit = "abc123";
    }));

    expect(report.passed).toBe(true);
    expect(report.metrics).toMatchObject({
      failed_event_count: 2,
      first_error_sequence: 2,
      recovery_after_error_count: 0,
      repo_commit_evidence_count: 1,
      patch_evidence_count: 1,
      test_evidence_count: 1,
      verifier_evidence_count: 1,
      evaluation_event_count: 1,
      environment_grounded_turn_count: 1,
      egs_complete_turn_count: 1,
      egs_completeness_ratio: 1,
      tor_complete_action_count: 1,
      tor_complete_turn_count: 1,
      tor_completeness_ratio: 1,
    });
    expect(codes(report)).toContain("UNRECOVERED_ERROR");
    expect(codes(report)).not.toContain("TEST_EVIDENCE_MISSING");
    expect(codes(report)).not.toContain("VERIFIER_VERSION_EVIDENCE_MISSING");
  });

  it("emits exact/near duplicate and repo/time split contamination signals", () => {
    const repeated = "The deterministic parser preserves every environment observation, action, result, verification, tool identifier, and lineage record before the approved dataset export.";
    const events = [
      makeEvent(0, "message", { started_at: "2026-08-16T02:00:00.000Z", content: textContent(repeated), metadata: { split: "train", repo_id: "repo-1" } }),
      makeEvent(1, "message", { started_at: "2026-08-16T01:00:00.000Z", content: textContent(repeated), metadata: { split: "test", repo_id: "repo-1" } }),
      makeEvent(2, "message", { started_at: "2026-08-16T03:00:00.000Z", content: textContent(`${repeated} Safely.`), metadata: { split: "validation", repo_id: "repo-1" } }),
    ];

    const report = inspectQuality(bundleWith(events));

    expect(report.metrics.exact_duplicate_text_count).toBe(1);
    expect(report.metrics.near_duplicate_text_count).toBeGreaterThan(0);
    expect(report.metrics.cross_split_duplicate_count).toBeGreaterThan(0);
    expect(report.metrics.repo_split_contamination_signal_count).toBe(1);
    expect(report.metrics.time_split_contamination_signal_count).toBe(2);
    expectCodes(report, [
      "EXACT_DUPLICATE_TEXT",
      "NEAR_DUPLICATE_TEXT",
      "CROSS_SPLIT_DUPLICATE_TEXT",
      "REPO_SPLIT_CONTAMINATION_SIGNAL",
      "TIME_SPLIT_CONTAMINATION_SIGNAL",
    ]);
  });

  it("counts raw sequence gaps between consecutive envelopes, not offset from zero", () => {
    const rawEnvelope = (sequence: number) => {
      const payload = { seq: sequence };
      return {
        envelope_version: "raw/0.1" as const,
        adapter: "deepseek_harness" as const,
        adapter_version: "0.1.0",
        interface_version: "deepseek-harness@0.1.0-rc.6/session-event/0",
        captured_at: "2026-08-16T00:00:00.000Z",
        sequence,
        source_event_id: null,
        session_id: null,
        turn_id: null,
        payload_sha256: sha256(canonicalJson(payload)),
        payload,
      };
    };

    const consecutive = fixtureBundle();
    consecutive.raw = [rawEnvelope(1), rawEnvelope(2), rawEnvelope(3)];
    expect(inspectQuality(consecutive).metrics.raw_sequence_gap_count).toBe(0);

    const gapped = fixtureBundle();
    gapped.raw = [rawEnvelope(0), rawEnvelope(2), rawEnvelope(4)];
    expect(inspectQuality(gapped).metrics.raw_sequence_gap_count).toBe(2);
  });

  it("uses warnings for absent provenance and grounding rather than fabricating verifier or success labels", () => {
    const report = inspectQuality(bundleWith([
      makeEvent(0, "artifact.patch", { actor: "agent", content: [{ ...textContent("@@ patch without evidence @@")[0]!, type: "patch" }] }),
    ]));

    expect(report.passed).toBe(true);
    expect(report.metrics).toMatchObject({
      repo_commit_evidence_count: 0,
      patch_evidence_count: 1,
      test_evidence_count: 0,
      verifier_evidence_count: 0,
      environment_grounded_turn_count: 0,
      egs_complete_turn_count: 0,
      egs_completeness_ratio: 0.25,
    });
    expectCodes(report, [
      "REPO_COMMIT_EVIDENCE_MISSING",
      "TEST_EVIDENCE_MISSING",
      "ENVIRONMENT_OBSERVATION_MISSING",
      "ENVIRONMENT_RESULT_MISSING",
    ]);
  });
});
