import type { ContentPart, TraceBundle, TrajectoryEvent } from "@trajpack/schema";
import { describe, expect, it } from "vitest";
import { sha256 } from "./canonical.js";
import { createApprovalScope } from "./policy.js";
import {
  deriveResearchAnalytics,
  RESEARCH_ANALYTICS_VERSION,
  toTraceLabWorkloadRows,
  TRACELAB_WORKLOAD_MAPPING_VERSION,
} from "./research-analytics.js";
import { fixtureBundle } from "./testing.js";

function part(value: string, type: ContentPart["type"], options: Partial<ContentPart> = {}): ContentPart {
  return {
    ordinal: 0,
    type,
    mime_type: "text/plain",
    value,
    blob_ref: null,
    sha256: sha256(value),
    sensitivity: "confidential",
    redaction_status: "passed",
    review_disposition: "include",
    reasoning: null,
    rights_override: null,
    ...options,
  };
}

function at(index: number): string {
  return new Date(Date.parse("2026-08-16T00:00:00.000Z") + index * 100).toISOString();
}

function canonicalEvent(
  bundle: TraceBundle,
  index: number,
  eventType: TrajectoryEvent["event_type"],
  overrides: Partial<TrajectoryEvent> = {},
): TrajectoryEvent {
  return {
    ...bundle.events[0]!,
    event_id: `evt_${index}`,
    span_id: index.toString(16).padStart(16, "0"),
    sequence: index,
    started_at: at(index),
    ended_at: at(index),
    event_type: eventType,
    actor: "assistant",
    status: "ok",
    source_event_id: `source_${index}`,
    source_session_id: "private-session-identifier",
    source_turn_id: "private-turn-identifier",
    source_step_id: "step-1",
    content: [],
    tool: null,
    usage: {
      input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      cache_read_tokens: null,
      latency_ms: null,
      cost_usd: null,
    },
    metadata: {},
    review_disposition: "include",
    ...overrides,
  };
}

function researchBundle(): TraceBundle {
  const bundle = fixtureBundle("fixture body is replaced");
  const secretPrompt = "PROMPT_SECRET_alpha_9281";
  const secretArguments = "ARGUMENT_SECRET_beta_7742";
  const secretResult = "RESULT_SECRET_gamma_6630";
  bundle.events = [
    canonicalEvent(bundle, 0, "model.inference", {
      status: "partial",
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        reasoning_tokens: 10,
        cache_read_tokens: 60,
        latency_ms: 50,
        cost_usd: 0.01,
      },
    }),
    canonicalEvent(bundle, 1, "reasoning", {
      content: [part(secretPrompt, "reasoning", {
        reasoning: {
          representation: "provider_exposed_reasoning",
          provider_claim: "chain_of_thought",
          source_field: "reasoning_content",
          visibility: "api_only",
          include_in_loss: true,
        },
      })],
    }),
    canonicalEvent(bundle, 2, "tool.call", {
      status: "partial",
      content: [part(secretArguments, "tool_call")],
      tool: {
        call_id: "private-call-a",
        name: "PRIVATE_TOOL_NAME_delta_5519",
        arguments: { prompt: secretArguments },
        result: null,
        exit_code: null,
      },
    }),
    canonicalEvent(bundle, 3, "tool.call", {
      status: "partial",
      content: [part("second secret argument", "tool_call")],
      tool: {
        call_id: "private-call-b",
        name: "exec_command",
        arguments: { cmd: "never emit this command body" },
        result: null,
        exit_code: null,
      },
    }),
    canonicalEvent(bundle, 4, "tool.result", {
      actor: "tool",
      status: "error",
      content: [part(secretResult, "tool_result")],
      tool: {
        call_id: "private-call-a",
        name: null,
        arguments: null,
        result: secretResult,
        exit_code: 1,
      },
    }),
    canonicalEvent(bundle, 5, "tool.result", {
      actor: "tool",
      content: [part("second private tool result", "tool_result")],
      tool: {
        call_id: "private-call-b",
        name: null,
        arguments: null,
        result: "second private tool result",
        exit_code: 0,
      },
    }),
    canonicalEvent(bundle, 6, "evaluation", { actor: "environment", metadata: { recovered: true } }),
    canonicalEvent(bundle, 7, "compaction", {
      actor: "system",
      content: [part("private compaction body", "text", { review_disposition: "exclude" })],
    }),
    canonicalEvent(bundle, 8, "agent.invoke", {
      actor: "agent",
      source_step_id: "private-child-agent-id",
      metadata: { durable_event_type: "subagent/descriptor" },
    }),
    canonicalEvent(bundle, 9, "handoff", { actor: "agent", source_step_id: "private-child-agent-id" }),
    canonicalEvent(bundle, 10, "approval.request", { actor: "environment" }),
    canonicalEvent(bundle, 11, "approval.decision", {
      actor: "user",
      status: "cancelled",
      metadata: { approval_decision: "denied" },
    }),
    canonicalEvent(bundle, 12, "message", {
      actor: "user",
      content: [part("EXCLUDED_SECRET_epsilon_4408", "text")],
      review_disposition: "exclude",
    }),
  ];
  bundle.manifest.review.approval_scope = null;
  bundle.manifest.review.approval_scope = createApprovalScope(bundle, [
    "training_noncompetitive",
    "training_competitive_distillation",
  ]);
  return bundle;
}

describe("research analytics", () => {
  it("derives detailed deterministic workload, behavior, recovery, and structural training yield", () => {
    const summary = deriveResearchAnalytics({ kind: "approved_bundles", bundles: [researchBundle()] });
    expect(summary.schema_version).toBe(RESEARCH_ANALYTICS_VERSION);
    expect(summary.privacy).toEqual({
      content_values_emitted: false,
      tool_payloads_emitted: false,
      trajectory_identifiers_emitted: false,
    });
    expect(summary.scope).toMatchObject({
      bundle_count: 1,
      trace_count: 1,
      candidate_event_count: 13,
      selected_event_count: 12,
      excluded_event_count: 1,
      session_count: 1,
      turn_count: 1,
    });
    expect(summary.workload).toMatchObject({
      llm_round_count: 1,
      llm_rounds_with_usage: 1,
      inference_event_count: 1,
      usage: {
        input_tokens: { observed_round_count: 1, total: 100 },
        output_tokens: { observed_round_count: 1, total: 40 },
        reasoning_tokens: { observed_round_count: 1, total: 10 },
        cache_read_tokens: { observed_round_count: 1, total: 60 },
        cache_read_to_input_bp: 6000,
        reasoning_to_output_bp: 2500,
      },
    });
    expect(summary.tools).toMatchObject({
      call_count: 2,
      result_count: 2,
      paired_call_count: 2,
      unpaired_call_count: 0,
      orphan_result_count: 0,
      failed_call_count: 1,
      parallel_group_count: 1,
      parallel_additional_call_count: 1,
      max_observed_concurrency: 2,
      latency: { sample_count: 2, min_ms: 200, p50_ms: 200, p95_ms: 200, max_ms: 200 },
    });
    expect(summary.behavior).toMatchObject({
      reasoning_event_count: 1,
      action_event_count: 2,
      reasoning_to_action_bp: 5000,
      compaction_event_count: 1,
      subagent_invoke_count: 1,
      handoff_count: 1,
      approval_request_count: 1,
      approval_decision_count: 1,
      approval_deny_count: 1,
    });
    expect(summary.errors_and_recovery).toMatchObject({
      failed_event_count: 1,
      traces_with_error: 1,
      traces_with_evidenced_recovery: 1,
      first_errors: [{ sequence: 4, recovery_evidenced: true, recovery_sequence: 5, recovery_latency_ms: 100 }],
    });
    expect(summary.training_yield).toMatchObject({
      assistant_loss_candidate_part_count: 3,
      reasoning_loss_candidate_part_count: 1,
      selected_event_yield_bp: 9231,
      exclusions: { event_review_excluded: 1, content_review_excluded: 1 },
      training_gate_status: {
        noncompetitive: { allow: 1, deny: 0, unknown: 0 },
        competitive_distillation: { allow: 1, deny: 0, unknown: 0 },
        unavailable: 0,
      },
    });
  });

  it("emits TraceLab-shaped lossy rows without source text, payloads, identifiers, or paths", () => {
    const rows = toTraceLabWorkloadRows({ kind: "approved_bundles", bundles: [researchBundle()] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: "deepseek_harness",
      project: "trajpack-derived",
      session_file: "trajpack-derived",
      round_index: 0,
      model: "fixture-model",
      input_tokens_total: 100,
      prefix_tokens: 60,
      newly_append_tokens: 40,
      output_tokens: 40,
      reasoning_output_tokens: 10,
      current_input_event_count: null,
      home: null,
      _trajpack: {
        mapping_version: TRACELAB_WORKLOAD_MAPPING_VERSION,
        mapping_kind: "lossy_derived",
        canonical_source_of_truth: false,
        content_values_emitted: false,
        tool_payloads_emitted: false,
      },
    });
    expect(rows[0]!.tools).toHaveLength(2);
    expect(rows[0]!.tools[0]).toMatchObject({
      tool_index: 0,
      tool_name: expect.stringMatching(/^custom_[a-f0-9]{12}$/u),
      tool_wall_latency_ms: 200,
      tool_internal_latency_ms: null,
      is_error: true,
    });
    expect(rows[0]!.tools[0]).not.toHaveProperty("input");
    const serialized = JSON.stringify(rows);
    for (const secret of [
      "PROMPT_SECRET",
      "ARGUMENT_SECRET",
      "RESULT_SECRET",
      "PRIVATE_TOOL_NAME",
      "EXCLUDED_SECRET",
      "private-session-identifier",
      "private-turn-identifier",
      "private-child-agent-id",
      "never emit this command body",
      "private compaction body",
      "second private tool result",
    ]) expect(serialized).not.toContain(secret);
  });

  it("does not expose content in the aggregate summary", () => {
    const serialized = JSON.stringify(deriveResearchAnalytics({ kind: "approved_bundles", bundles: [researchBundle()] }));
    for (const secret of ["PROMPT_SECRET", "ARGUMENT_SECRET", "RESULT_SECRET", "EXCLUDED_SECRET", "private-session"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("is stable across pure canonical event input order and marks policy gates unavailable", () => {
    const events = researchBundle().events;
    const forward = { kind: "selected_events" as const, events };
    const reverse = { kind: "selected_events" as const, events: [...events].reverse() };
    expect(deriveResearchAnalytics(forward)).toEqual(deriveResearchAnalytics(reverse));
    expect(toTraceLabWorkloadRows(forward)).toEqual(toTraceLabWorkloadRows(reverse));
    expect(deriveResearchAnalytics(forward).training_yield.training_gate_status.unavailable).toBe(1);
  });

  it("rejects stale or merely pending bundles", () => {
    const stale = researchBundle();
    stale.events[0]!.usage.input_tokens = 101;
    expect(() => deriveResearchAnalytics({ kind: "approved_bundles", bundles: [stale] }))
      .toThrow("stale approval scope");
    const pending = researchBundle();
    pending.manifest.review.human_approval = "pending";
    pending.manifest.review.approval_scope = null;
    expect(() => toTraceLabWorkloadRows({ kind: "approved_bundles", bundles: [pending] }))
      .toThrow("human-approved bundle");
  });

  it("reports no latency sample when an observed tool call has no paired result", () => {
    const bundle = researchBundle();
    const events = bundle.events.filter((event) => event.event_id !== "evt_4" && event.event_id !== "evt_5");
    const summary = deriveResearchAnalytics({ kind: "selected_events", events });
    const rows = toTraceLabWorkloadRows({ kind: "selected_events", events });
    expect(summary.tools).toMatchObject({
      call_count: 2,
      paired_call_count: 0,
      unpaired_call_count: 2,
      latency: { sample_count: 0, min_ms: null, p50_ms: null, p95_ms: null, max_ms: null, mean_ms: null },
    });
    expect(rows[0]!.tools.every((tool) => tool.tool_wall_latency_ms === null && tool.result_at === null)).toBe(true);
  });
});
