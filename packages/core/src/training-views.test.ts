import type { TraceBundle, TrajectoryEvent } from "@trajpack/schema";
import { DEEPSEEK_HARNESS_INTERFACE_VERSION, normalizeRawEnvelope } from "@trajpack/adapters";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "./canonical.js";
import { createApprovalScope, reviewEvidenceFingerprint } from "./policy.js";
import { fixtureBundle } from "./testing.js";
import {
  compileTrainingView,
  compileTrainingViews,
  TRAINING_VIEW_COMPILER_VERSION,
  TRAINING_VIEW_RECIPE_VERSIONS,
} from "./training-views.js";

let eventCounter = 0;

function content(
  value: string,
  type: TrajectoryEvent["content"][number]["type"] = "text",
  reasoning: TrajectoryEvent["content"][number]["reasoning"] = null,
): TrajectoryEvent["content"] {
  const part = structuredClone(fixtureBundle().events[0]!.content[0]!);
  return [{ ...part, type, value, sha256: sha256(value), reasoning }];
}

function event(
  sequence: number,
  eventType: TrajectoryEvent["event_type"],
  overrides: Partial<TrajectoryEvent> = {},
): TrajectoryEvent {
  const base = structuredClone(fixtureBundle().events[0]!);
  const instant = new Date(Date.parse("2026-08-16T00:00:00.000Z") + sequence * 1_000).toISOString();
  return {
    ...base,
    event_id: `evt_${eventType.replace(".", "_")}_${sequence}_${eventCounter++}`,
    span_id: (sequence + 1).toString(16).padStart(16, "0"),
    sequence,
    started_at: instant,
    ended_at: instant,
    event_type: eventType,
    actor: eventType === "tool.result" ? "tool" : "assistant",
    status: "ok",
    source_event_id: `deepseek-${sequence}`,
    source_session_id: "dsh-session",
    source_turn_id: "turn-1",
    source_step_id: `step-${sequence}`,
    content: [],
    tool: null,
    ...overrides,
    metadata: {
      provider_route: "deepseek-official",
      model: "deepseek-reasoner",
      interface_version: "deepseek-harness@0.1.0-rc.6/session-event/0",
      durable_event_type: eventType,
      ...(overrides.metadata ?? {}),
    },
  };
}

function bundle(events: TrajectoryEvent[]): TraceBundle {
  const result = fixtureBundle();
  result.manifest.source.provider = "deepseek";
  result.manifest.source.model_id = "deepseek-reasoner";
  const sessions = [...new Set(events.map((candidate) => candidate.source_session_id))];
  const syntheticHeaders = sessions.flatMap((sessionId) => {
    const existing = events.find((candidate) => candidate.source_session_id === sessionId
      && candidate.metadata.durable_event_type === "request/header");
    if (existing !== undefined) {
      existing.metadata.request_config ??= { provider: "deepseek-official", model: "deepseek-reasoner" };
      return [];
    }
    return [event(0, "model.inference", {
      actor: "assistant",
      status: "partial",
      source_session_id: sessionId,
      source_turn_id: null,
      source_step_id: null,
      metadata: {
        durable_event_type: "request/header",
        request_config: { provider: "deepseek-official", model: "deepseek-reasoner" },
      },
    })];
  });
  result.events = [...syntheticHeaders, ...events].map((candidate, sequence) => {
    candidate.sequence = sequence;
    return candidate;
  });
  result.manifest.review.approval_scope = createApprovalScope(result, [
    "training_noncompetitive",
    "training_competitive_distillation",
  ]);
  return result;
}

function call(sequence: number, id: string, name: string, args: unknown, step: string, retry = false) {
  return event(sequence, "tool.call", {
    actor: "assistant",
    status: "partial",
    source_step_id: step,
    content: content(JSON.stringify(args), "tool_call"),
    tool: { call_id: id, name, arguments: args, result: null, exit_code: null },
    metadata: { durable_event_type: "assistant/message", ...(retry ? { retry: true, retry_attempt: 1 } : {}) },
  });
}

function result(
  sequence: number,
  id: string,
  value: unknown,
  status: "ok" | "error",
  step: string,
  exitCode: number | null = null,
) {
  return event(sequence, "tool.result", {
    actor: "tool",
    status,
    source_step_id: step,
    content: content(typeof value === "string" ? value : JSON.stringify(value), "tool_result"),
    tool: { call_id: id, name: "shell", arguments: null, result: value, exit_code: exitCode },
    metadata: { durable_event_type: "tool/result" },
  });
}

function harnessCapsule(
  seq: number,
  type: string,
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  firstLiveSeq = 0,
): Record<string, unknown> {
  return {
    session_id: "dsh-epoch-session",
    session_header: {
      version: 0,
      id: "dsh-epoch-session",
      first_live_seq: firstLiveSeq,
      seed_length: 0,
      parent_session: null,
      origin: "user",
      delegation_depth: 0,
      agent_preset: "default",
    },
    route: { provider: "deepseek-official", model: "deepseek-reasoner" },
    event_id: `dsh-epoch-session:${seq}`,
    timestamp: 1_786_900_000_000 + seq,
    event: { type, seq, time: 1_786_900_000_000 + seq, data, ...extra },
  };
}

function deepSeekEpochBundle(firstLiveSeq = 0): TraceBundle {
  const payloads = [
    harnessCapsule(0, "request/header", {
      reason: "initial",
      header: {
        config: { provider: "deepseek-official", model: "deepseek-reasoner", temperature: 0 },
        system: "You are a repository agent.",
        tools: [{
          name: "shell",
          description: "Run a command",
          inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
        }],
      },
    }, {}, firstLiveSeq),
    harnessCapsule(1, "turn/start", { turn: 0 }, {}, firstLiveSeq),
    harnessCapsule(2, "step/start", { turn: 0, step: 0 }, {}, firstLiveSeq),
    harnessCapsule(3, "user/message", {
      id: "user-1", role: "user", source: { kind: "user" },
      content: [{ type: "text", text: "Run the tests." }],
    }, { surfaceOp: "append", sourceEventSeqs: [1] }, firstLiveSeq),
    harnessCapsule(4, "assistant/message", {
      turn: 0,
      step: 0,
      message: {
        id: "assistant-tool",
        role: "assistant",
        source: { kind: "model", provider: "deepseek-official", model: "deepseek-reasoner" },
        content: [{ type: "tool-call", id: "call-shell", name: "shell", arguments: { command: "pnpm test" } }],
      },
    }, { surfaceOp: "append", sourceEventSeqs: [] }, firstLiveSeq),
    harnessCapsule(5, "step/end", { turn: 0, step: 0 }, {}, firstLiveSeq),
    harnessCapsule(6, "tool/result", {
      turn: 0,
      step: 0,
      message: {
        id: "tool-result",
        role: "user",
        source: { kind: "tool", callId: "call-shell" },
        content: [{
          type: "tool-result",
          toolCallId: "call-shell",
          content: [{ type: "text", text: "all tests passed" }],
        }],
      },
    }, { surfaceOp: "append" }, firstLiveSeq),
    harnessCapsule(7, "step/start", { turn: 0, step: 1 }, {}, firstLiveSeq),
    harnessCapsule(8, "assistant/message", {
      turn: 0,
      step: 1,
      message: {
        id: "assistant-result",
        role: "assistant",
        source: { kind: "model", provider: "deepseek-official", model: "deepseek-reasoner" },
        content: [{ type: "text", text: "The tests passed." }],
      },
    }, { surfaceOp: "append", sourceEventSeqs: [] }, firstLiveSeq),
    harnessCapsule(9, "step/end", { turn: 0, step: 1 }, {}, firstLiveSeq),
    harnessCapsule(10, "user/message", {
      id: "compaction-summary",
      role: "user",
      source: { kind: "compaction" },
      content: [{ type: "text", text: "Summary: tests passed." }],
    }, { surfaceOp: { op: "replace", start: 3, end: 8 }, sourceEventSeqs: [3, 4, 6, 8] }, firstLiveSeq),
    harnessCapsule(11, "step/start", { turn: 0, step: 2 }, {}, firstLiveSeq),
    harnessCapsule(12, "assistant/message", {
      turn: 0,
      step: 2,
      message: {
        id: "assistant-final",
        role: "assistant",
        source: { kind: "model", provider: "deepseek-official", model: "deepseek-reasoner" },
        content: [
          { type: "reasoning", text: "The verifier output is complete." },
          { type: "text", text: "Done." },
        ],
      },
    }, { surfaceOp: "append", sourceEventSeqs: [] }, firstLiveSeq),
    harnessCapsule(13, "step/end", { turn: 0, step: 2 }, {}, firstLiveSeq),
    harnessCapsule(14, "turn/end", { turn: 0, reason: { kind: "completed" } }, {}, firstLiveSeq),
  ];
  const trace = fixtureBundle();
  trace.manifest.source = {
    ...trace.manifest.source,
    host: "deepseek_harness",
    provider: "deepseek",
    product: "deepseek-harness",
    surface: "harness",
    capture_method: "instrumented_harness",
    adapter_version: "0.1.0",
    interface_version: DEEPSEEK_HARNESS_INTERFACE_VERSION,
    model_id: "deepseek-reasoner",
  };
  trace.raw = payloads.map((payload, sequence) => ({
    envelope_version: "raw/0.1" as const,
    adapter: "deepseek_harness" as const,
    adapter_version: "0.1.0",
    interface_version: DEEPSEEK_HARNESS_INTERFACE_VERSION,
    captured_at: new Date(1_786_900_000_000 + sequence).toISOString(),
    sequence,
    source_event_id: `dsh-epoch-session:${sequence}`,
    session_id: "dsh-epoch-session",
    turn_id: null,
    payload_sha256: sha256(canonicalJson(payload)),
    payload,
  }));
  const normalized: TrajectoryEvent[] = [];
  let nextSequence = 0;
  for (const envelope of trace.raw) {
    const events = normalizeRawEnvelope(envelope, { traceId: trace.manifest.trace_id, nextSequence });
    for (const normalizedEvent of events) {
      normalizedEvent.content = normalizedEvent.content.map((part) => ({ ...part, redaction_status: "passed" }));
      normalized.push(normalizedEvent);
      nextSequence = Math.max(nextSequence, normalizedEvent.sequence + 1);
    }
  }
  trace.events = normalized;
  trace.manifest.lineage.raw_sha256 = sha256(canonicalJson(trace.raw));
  trace.manifest.review.approval_scope = createApprovalScope(trace, [
    "training_noncompetitive",
    "training_competitive_distillation",
  ]);
  return trace;
}

describe("versioned training view compiler", () => {
  it("compiles deterministic answer-only SFT targets and ignores partial stream chunks", () => {
    const streamed = event(1, "message", { actor: "assistant", status: "partial", content: content("I will") });
    const trace = bundle([
      event(0, "message", { actor: "user", content: content("Fix the failing test.") }),
      streamed,
      event(2, "message", { actor: "assistant", content: content("The test is fixed.") }),
    ]);

    const first = compileTrainingView(trace, "answer_sft");
    const second = compileTrainingView(trace, "answer_sft");

    expect(first).toEqual(second);
    expect(first.compilation_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.recipe_version).toBe(TRAINING_VIEW_RECIPE_VERSIONS.answer_sft);
    expect(first.compiler_version).toBe(TRAINING_VIEW_COMPILER_VERSION);
    expect(first.views).toHaveLength(1);
    expect(first.views[0]).toMatchObject({
      objective: "sft",
      loss_targets: [{ components: ["answer_text"] }],
      reward: null,
      verifier_provenance: null,
    });
    expect(first.views[0]!.messages.map((message) => message.content)).toEqual([
      "Fix the failing test.",
      "The test is fixed.",
    ]);
    expect(first.views[0]!.metadata.dropped_context_event_ids).toEqual([streamed.event_id]);
  });

  it("carries the latest Harness request system prompt and native tool schemas into the training view", () => {
    const systemPart = content("You are a repository agent.")[0]!;
    const toolPart = {
      ...content(JSON.stringify({
        name: "shell",
        description: "Run one command",
        inputSchema: { type: "object", properties: { command: { type: "string" } } },
      }), "file_ref")[0]!,
      ordinal: 1,
      mime_type: "application/vnd.trajpack.tool-schema+json",
    };
    const requestHeader = event(0, "model.inference", {
      actor: "assistant",
      status: "partial",
      content: [{ ...systemPart, ordinal: 0, mime_type: "text/plain; role=system" }, toolPart],
      metadata: {
        durable_event_type: "request/header",
        request_content_roles: [
          { ordinal: 0, role: "system" },
          { ordinal: 1, role: "tool_schema" },
        ],
      },
    });
    const compiled = compileTrainingView(bundle([
      requestHeader,
      event(1, "message", { actor: "user", content: content("Run the tests.") }),
      event(2, "message", { actor: "assistant", content: content("Tests passed.") }),
    ]), "answer_sft");

    expect(compiled.views).toHaveLength(1);
    expect(compiled.views[0]!.messages[0]).toMatchObject({
      role: "system",
      content: "You are a repository agent.",
      source_event_ids: [requestHeader.event_id],
    });
    expect(compiled.views[0]!.tools).toEqual([{
      type: "function",
      function: {
        name: "shell",
        description: "Run one command",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
      source_event_id: requestHeader.event_id,
    }]);
    expect(compiled.views[0]!.source_event_ids).toContain(requestHeader.event_id);
  });

  it("fails closed when a declared request tool schema is malformed or unavailable", () => {
    const toolPart = {
      ...content("not-json", "file_ref")[0]!,
      redaction_status: "redacted" as const,
      value: "[REDACTED]",
      sha256: sha256("[REDACTED]"),
    };
    const header = event(0, "model.inference", {
      status: "partial",
      content: [toolPart],
      metadata: {
        durable_event_type: "request/header",
        request_content_roles: [{ ordinal: 0, role: "tool_schema" }],
      },
    });
    const compiled = compileTrainingView(bundle([
      header,
      event(1, "message", { actor: "user", content: content("Run tests.") }),
      event(2, "message", { actor: "assistant", content: content("Done.") }),
    ]), "answer_sft");

    expect(compiled.views).toHaveLength(0);
    expect(compiled.exclusions[0]?.reason_codes).toContain("TOOL_SCHEMA_INVALID_OR_UNAVAILABLE");
  });

  it("keeps root and child sessions isolated and binds request headers to the target session", () => {
    const rootHeader = event(0, "model.inference", {
      source_session_id: "root",
      status: "partial",
      content: [{ ...content("Root system")[0]!, ordinal: 0 }],
      metadata: { durable_event_type: "request/header", request_content_roles: [{ ordinal: 0, role: "system" }] },
    });
    const childHeader = event(1, "model.inference", {
      source_session_id: "child",
      status: "partial",
      content: [{ ...content("Child system")[0]!, ordinal: 0 }],
      metadata: { durable_event_type: "request/header", request_content_roles: [{ ordinal: 0, role: "system" }] },
    });
    const childPrompt = event(2, "message", {
      source_session_id: "child",
      actor: "user",
      content: content("Child-only secret context"),
    });
    const rootPrompt = event(3, "message", {
      source_session_id: "root",
      actor: "user",
      content: content("Root request"),
    });
    const rootAnswer = event(4, "message", {
      source_session_id: "root",
      actor: "assistant",
      content: content("Root answer"),
    });
    const compiled = compileTrainingView(bundle([
      rootHeader, childHeader, childPrompt, rootPrompt, rootAnswer,
    ]), "answer_sft");

    expect(compiled.views).toHaveLength(1);
    expect(compiled.views[0]!.messages.map((message) => message.content)).toEqual([
      "Root system", "Root request", "Root answer",
    ]);
    expect(compiled.views[0]!.source_event_ids).not.toContain(childPrompt.event_id);
    expect(compiled.views[0]!.source_event_ids).not.toContain(childHeader.event_id);
  });

  it("opts in only completed provider-exposed DeepSeek reasoning and fails summaries and opaque states closed", () => {
    const exposed = {
      representation: "provider_exposed_reasoning" as const,
      provider_claim: "chain_of_thought" as const,
      source_field: "reasoning_content",
      visibility: "api_only" as const,
      include_in_loss: false,
    };
    const summary = {
      representation: "provider_summary" as const,
      provider_claim: "reasoning_summary" as const,
      source_field: "summary",
      visibility: "user_visible" as const,
      include_in_loss: false,
    };
    const opaque = {
      representation: "opaque_reasoning_state" as const,
      provider_claim: "none" as const,
      source_field: "redacted_thinking",
      visibility: "not_returned" as const,
      include_in_loss: false,
    };
    const streamed = event(1, "reasoning", {
      source_step_id: "step-visible",
      status: "partial",
      content: content("Inspect", "reasoning", exposed),
    });
    const completed = event(2, "reasoning", {
      source_step_id: "step-visible",
      content: content("Inspect files first.", "reasoning", exposed),
    });
    const trace = bundle([
      event(0, "message", { actor: "user", content: content("Inspect the repository.") }),
      streamed,
      completed,
      event(3, "reasoning", { source_step_id: "step-summary", content: content("I inspected files.", "reasoning", summary) }),
      event(4, "reasoning", { source_step_id: "step-opaque", content: content("opaque", "reasoning", opaque) }),
      event(5, "reasoning", {
        source_step_id: "step-partial",
        status: "partial",
        content: content("unfinished delta", "reasoning", exposed),
      }),
    ]);

    const compiled = compileTrainingView(trace, "reasoning_sft");

    expect(compiled.views).toHaveLength(1);
    expect(compiled.views[0]).toMatchObject({
      objective: "sft",
      loss_targets: [{ components: ["reasoning"] }],
      metadata: {
        reasoning_representation: "provider_exposed_reasoning",
        explicit_recipe_opt_in: true,
        original_include_in_loss: [[false]],
        streaming_evidence_event_ids: [streamed.event_id],
      },
    });
    expect(compiled.views[0]!.evidence_event_ids).toEqual([streamed.event_id]);
    expect(compiled.views[0]!.target_event_ids).toEqual([completed.event_id]);
    expect(compiled.views[0]!.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: null,
      reasoning_content: "Inspect files first.",
    });
    expect(compiled.exclusions.flatMap((item) => item.reason_codes)).toEqual(expect.arrayContaining([
      "REASONING_REPRESENTATION_NOT_TRAINABLE",
      "PARTIAL_REASONING_WITHOUT_COMPLETION",
    ]));
  });

  it("preserves parallel DeepSeek tool calls, native arguments, result evidence, and component loss masks", () => {
    const callA = call(1, "call-a", "search", { query: "ATIF" }, "parallel-step");
    const callB = call(2, "call-b", "read_file", { path: "README.md" }, "parallel-step");
    const resultA = result(3, "call-a", ["ATIF-v1.7"], "ok", "parallel-step");
    const resultB = result(4, "call-b", "documentation", "ok", "parallel-step");
    const trace = bundle([
      event(0, "message", { actor: "user", content: content("Research trajectory formats.") }),
      callA,
      callB,
      resultA,
      resultB,
    ]);

    const compiled = compileTrainingView(trace, "tool_use_sft");

    expect(compiled.views).toHaveLength(1);
    const view = compiled.views[0]!;
    expect(view.target_event_ids).toEqual([callA.event_id, callB.event_id]);
    expect(view.evidence_event_ids).toEqual([resultA.event_id, resultB.event_id]);
    expect(view.messages.at(-1)?.tool_calls).toHaveLength(2);
    expect(view.loss_targets).toEqual([expect.objectContaining({
      components: ["tool_name", "tool_arguments"],
      source_event_ids: [callA.event_id, callB.event_id],
    })]);
    expect(view.metadata).toMatchObject({ parallel_call_count: 2, observed_result_statuses: ["ok", "ok"] });
  });

  it("does not pair a reused tool call id with a result from another step", () => {
    const original = call(1, "reused-call", "shell", { command: "first" }, "step-one");
    const unrelated = result(2, "reused-call", "second-step-result", "ok", "step-two");
    const compiled = compileTrainingView(bundle([
      event(0, "message", { actor: "user", content: content("Run the first step.") }),
      original,
      unrelated,
    ]), "tool_use_sft");

    expect(compiled.views).toHaveLength(0);
    expect(compiled.exclusions.flatMap((item) => item.reason_codes)).toContain("TOOL_RESULT_MISSING");
  });

  it("deduplicates Harness tool-call delta, assembled message, and execution lifecycle into one target", () => {
    const delta = call(1, "call-one", "shell", "{\"command\":", "tool-step");
    delta.metadata.durable_event_type = "assistant/chunk";
    const assembled = call(2, "call-one", "shell", { command: "pnpm test" }, "tool-step");
    const lifecycle = call(3, "call-one", "shell", { command: "pnpm test" }, "tool-step");
    lifecycle.metadata.durable_event_type = "tool/call";
    const observed = result(4, "call-one", "passed", "ok", "tool-step");
    const compiled = compileTrainingView(bundle([
      event(0, "message", { actor: "user", content: content("Test it.") }),
      delta,
      assembled,
      lifecycle,
      observed,
    ]), "tool_use_sft");

    expect(compiled.views).toHaveLength(1);
    const view = compiled.views[0]!;
    expect(view.target_event_ids).toEqual([assembled.event_id]);
    expect(view.messages.filter((message) => message.tool_calls)).toHaveLength(1);
    expect(view.messages.find((message) => message.tool_calls)?.tool_calls).toHaveLength(1);
    expect(view.messages.find((message) => message.tool_calls)?.source_event_ids).toEqual(expect.arrayContaining([
      delta.event_id, assembled.event_id, lifecycle.event_id,
    ]));
    expect(view.evidence_event_ids).toEqual(expect.arrayContaining([
      observed.event_id, delta.event_id, lifecycle.event_id,
    ]));
  });

  it("derives failure-recovery SFT only from explicit retry and successful observed outcome evidence", () => {
    const firstCall = call(1, "call-failed", "shell", { command: "pnpm test" }, "failed-step");
    const failed = result(2, "call-failed", "exit 1", "error", "failed-step", 1);
    const retryMarker = event(3, "model.inference", {
      status: "partial",
      metadata: { durable_event_type: "llm/retry", retry: true, retry_attempt: 1 },
    });
    const retryCall = call(4, "call-retry", "shell", { command: "pnpm test --run" }, "retry-step");
    const succeeded = result(5, "call-retry", "all tests passed", "ok", "retry-step", 0);
    const trace = bundle([
      event(0, "message", { actor: "user", content: content("Run and repair the tests.") }),
      firstCall,
      failed,
      retryMarker,
      retryCall,
      succeeded,
    ]);

    const compiled = compileTrainingView(trace, "failure_recovery");

    expect(compiled.views).toHaveLength(1);
    expect(compiled.views[0]).toMatchObject({
      target_event_ids: [retryCall.event_id],
      evidence_event_ids: [failed.event_id, retryMarker.event_id, succeeded.event_id],
      loss_targets: [{ components: ["tool_name", "tool_arguments"] }],
      reward: null,
      verifier_provenance: null,
      metadata: {
        observed_recovery: true,
        synthetic_success_label: false,
      },
    });

    const withoutMarker = bundle([trace.events[0]!, firstCall, failed]);
    const blocked = compileTrainingView(withoutMarker, "failure_recovery");
    expect(blocked.views).toHaveLength(0);
    expect(blocked.exclusions[0]?.reason_codes).toContain("EXPLICIT_RETRY_EVIDENCE_MISSING");
  });

  it("compiles correlated subagent delegation and handoff without fabricating topology", () => {
    const invoke = event(1, "agent.invoke", {
      actor: "agent",
      status: "partial",
      source_step_id: "subagent-7",
      content: content("Audit the persistence adapter."),
      metadata: { durable_event_type: "tool-workflow/agent-start", subagent_mode: "continuable" },
    });
    const handoff = event(2, "handoff", {
      actor: "agent",
      source_step_id: "subagent-7",
      content: content("The adapter preserves contiguous durable sequence numbers."),
      metadata: { durable_event_type: "tool-workflow/agent-end" },
    });
    const compiled = compileTrainingView(bundle([invoke, handoff]), "subagent_handoff");

    expect(compiled.views).toHaveLength(1);
    expect(compiled.views[0]).toMatchObject({
      source_event_ids: [invoke.event_id, handoff.event_id],
      target_event_ids: [handoff.event_id],
      evidence_event_ids: [invoke.event_id],
      messages: [
        { role: "user", content: "Audit the persistence adapter." },
        { role: "assistant", content: "The adapter preserves contiguous durable sequence numbers." },
      ],
      loss_targets: [{ message_index: 1, components: ["answer_text"] }],
      metadata: { synthetic_handoff: false },
    });
  });

  it("emits only confirmed pointwise RL rewards and never fabricates DPO pairs or step rewards", () => {
    const answer = event(1, "message", { actor: "assistant", content: content("Implemented and tested.") });
    const evaluation = event(2, "evaluation", {
      actor: "environment",
      content: [],
      metadata: {
        reward: 0.875,
        verifier: {
          name: "unit-test-verifier",
          version: "2.1.0",
          artifact_sha256: "a".repeat(64),
          result_sha256: "b".repeat(64),
        },
      },
    });
    const verifier = evaluation.metadata.verifier as {
      name: string;
      version: string;
      artifact_sha256: string;
      result_sha256: string;
    };
    const trace = bundle([
      event(0, "message", { actor: "user", content: content("Implement the change.") }),
      answer,
      evaluation,
    ]);
    evaluation.metadata.target_event_id = answer.event_id;
    evaluation.metadata.target_event_sha256 = reviewEvidenceFingerprint(answer);
    evaluation.metadata.trajpack_review = {
      verifier_confirmation: {
        schema_version: "verifier-confirmation/0.1",
        reviewer: "research-reviewer",
        evidence_ref: "lab-run:unit-test-verifier/42",
        confirmed_at: "2026-08-16T00:10:00.000Z",
        event_sha256: reviewEvidenceFingerprint(evaluation),
        reward: 0.875,
        verifier,
      },
    };
    trace.manifest.review.approval_scope = createApprovalScope(trace, [
      "training_noncompetitive",
      "training_competitive_distillation",
    ]);

    const compiled = compileTrainingView(trace, "pointwise_reward_rl_ready");

    expect(compiled.views).toHaveLength(1);
    expect(compiled.views[0]).toMatchObject({
      objective: "pointwise_reward",
      target_event_ids: [answer.event_id],
      evidence_event_ids: [evaluation.event_id],
      reward: 0.875,
      loss_targets: [],
      verifier_provenance: {
        label_kind: "verified_pointwise_reward",
        source_event_id: evaluation.event_id,
        reward: 0.875,
        verifier: { name: "unit-test-verifier", version: "2.1.0" },
        confirmation: { reviewer: "research-reviewer" },
      },
      metadata: {
        preference_pair: null,
        step_rewards: [],
        synthetic_preference_pair: false,
        synthetic_step_reward: false,
      },
    });

    const unconfirmed = structuredClone(trace);
    delete unconfirmed.events.find((candidate) => candidate.event_id === evaluation.event_id)!.metadata.trajpack_review;
    unconfirmed.manifest.review.approval_scope = createApprovalScope(unconfirmed, [
      "training_noncompetitive",
      "training_competitive_distillation",
    ]);
    const blocked = compileTrainingView(unconfirmed, "pointwise_reward_rl_ready");
    expect(blocked.views).toHaveLength(0);
    expect(blocked.exclusions[0]?.reason_codes).toContain("VERIFIER_CONFIRMATION_INVALID_OR_MISSING");
  });

  it("compiles exact DeepSeek Harness request epochs across tools and compaction", () => {
    const trace = deepSeekEpochBundle();
    const first = compileTrainingView(trace, "deepseek_epoch_sft");
    const second = compileTrainingView(trace, "deepseek_epoch_sft");

    expect(first).toEqual(second);
    expect(first.recipe_version).toBe("deepseek-exact-request-epoch-sft/0.1");
    expect(first.views).toHaveLength(3);
    const toolEpoch = first.views.find((view) => view.metadata.output_event_seq === 4)!;
    const observationEpoch = first.views.find((view) => view.metadata.output_event_seq === 8)!;
    const compactedEpoch = first.views.find((view) => view.metadata.output_event_seq === 12)!;
    expect(toolEpoch.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call-shell", function: { name: "shell", arguments: "{\"command\":\"pnpm test\"}" } }],
    });
    expect(toolEpoch.loss_targets).toEqual([expect.objectContaining({
      components: ["tool_name", "tool_arguments"],
    })]);
    expect(observationEpoch.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", tool_call_id: "call-shell", content: "all tests passed" }),
    ]));
    expect(compactedEpoch.messages.map((message) => message.content)).toEqual([
      "You are a repository agent.",
      "Summary: tests passed.",
      "Done.",
    ]);
    expect(compactedEpoch.messages.at(-1)).toMatchObject({
      role: "assistant",
      reasoning_content: "The verifier output is complete.",
    });
    expect(compactedEpoch.loss_targets).toEqual([expect.objectContaining({
      components: ["reasoning", "answer_text"],
    })]);
    expect(compactedEpoch.metadata).toMatchObject({
      epoch_compiler_version: "dsh-epoch/0.1",
      request_header_seq: 0,
      input_surface_seqs: [10],
      output_event_seq: 12,
      source_raw_seqs: expect.arrayContaining([0, 3, 4, 6, 8, 10, 12]),
      exact_model_visible_surface: true,
      target_contains_provider_exposed_reasoning: true,
      reasoning_loss_enabled: true,
      hidden_chain_of_thought_claimed: false,
    });
    expect(compactedEpoch.metadata.epoch_input_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(compactedEpoch.metadata.epoch_output_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(compactedEpoch.tools).toEqual([expect.objectContaining({
      function: expect.objectContaining({ name: "shell", parameters: expect.objectContaining({ type: "object" }) }),
    })]);
  });

  it("never re-emits redacted epoch content and rejects resumed Harness context", () => {
    const trace = deepSeekEpochBundle();
    const finalReasoning = trace.events.find((candidate) => candidate.metadata.harness_seq === 12
      && candidate.event_type === "reasoning")!;
    finalReasoning.content[0]!.redaction_status = "redacted";
    finalReasoning.content[0]!.value = "[REDACTED]";
    finalReasoning.content[0]!.sha256 = sha256("[REDACTED]");
    trace.manifest.review.approval_scope = createApprovalScope(trace, [
      "training_noncompetitive",
      "training_competitive_distillation",
    ]);
    const redacted = compileTrainingView(trace, "deepseek_epoch_sft");
    expect(redacted.views.some((view) => view.metadata.output_event_seq === 12)).toBe(false);
    expect(redacted.exclusions.flatMap((item) => item.reason_codes)).toContain("CANONICAL_CONTENT_CHANGED");
    expect(canonicalJson(redacted.views)).not.toContain("The verifier output is complete.");

    const resumed = deepSeekEpochBundle(5);
    const blocked = compileTrainingView(resumed, "deepseek_epoch_sft");
    expect(blocked.views).toHaveLength(0);
    expect(blocked.exclusions[0]?.reason_codes).toContain("DEEPSEEK_RESUMED_CONTEXT_INCOMPLETE");
    const generic = compileTrainingView(resumed, "answer_sft");
    expect(generic.views).toHaveLength(0);
    expect(generic.exclusions[0]?.reason_codes).toContain("DEEPSEEK_RESUMED_CONTEXT_INCOMPLETE");
  });

  it("provides every versioned recipe and fails an unapproved trace closed", () => {
    const trace = fixtureBundle("answer");
    trace.manifest.review.human_approval = "pending";
    trace.manifest.review.approval_scope = null;

    const compilations = compileTrainingViews(trace);

    expect(compilations.map((item) => item.recipe)).toEqual(Object.keys(TRAINING_VIEW_RECIPE_VERSIONS));
    expect(compilations.every((item) => item.views.length === 0)).toBe(true);
    expect(compilations.every((item) => item.exclusions[0]?.reason_codes.includes("HUMAN_APPROVAL_REQUIRED"))).toBe(true);
  });
});
