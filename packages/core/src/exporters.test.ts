import { mkdtemp, mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ParquetReader } from "@dsnp/parquetjs";
import { DEEPSEEK_HARNESS_INTERFACE_VERSION, normalizeRawEnvelope } from "@trajpack/adapters";
import { describe, expect, it } from "vitest";
import { exportApprovedBundle, toAtif, toHfExample, toHfExamples } from "./exporters.js";
import * as publicCore from "./index.js";
import { canonicalJson, sha256 } from "./canonical.js";
import { createApprovalScope, reviewEvidenceFingerprint, validateApprovalScope } from "./policy.js";
import { applyAutomatedReview } from "./quality.js";
import { sanitizeBundle } from "./redaction.js";
import { fixtureBundle } from "./testing.js";

function reapprove(bundle: ReturnType<typeof fixtureBundle>): void {
  bundle.manifest.review.approval_scope = createApprovalScope(bundle, [
    "archive",
    "training_noncompetitive",
    "training_competitive_distillation",
    "redistribution",
  ]);
}

function genericExportBundle(text = "hello"): ReturnType<typeof fixtureBundle> {
  const bundle = fixtureBundle(text);
  bundle.manifest.source.host = "manual_import";
  reapprove(bundle);
  return bundle;
}

function attestToolRights(bundle: ReturnType<typeof fixtureBundle>, eventIndex: number): void {
  const event = bundle.events[eventIndex]!;
  const rights = bundle.manifest.rights;
  const decision = bundle.manifest.eligibility.training_competitive_distillation;
  event.metadata.trajpack_review = {
    rights_attestation: {
      schema_version: "rights-attestation/0.1",
      rights,
      scopes: [{
        mode: "training_competitive_distillation",
        target_model_owner: decision.target_model_owner,
        target_product: decision.target_product,
      }],
      reviewer: "fixture-rights-reviewer",
      evidence_ref: `rights:sha256:${"b".repeat(64)}`,
      evidence_sha256: "b".repeat(64),
      attested_at: "2026-08-16T00:00:00.000Z",
      expires_at: "2099-01-01T00:00:00.000Z",
      event_sha256: reviewEvidenceFingerprint(event),
      source_sha256: sha256(canonicalJson(bundle.manifest.source)),
    },
  };
}

function epochExportBundle(): ReturnType<typeof fixtureBundle> {
  const capsule = (seq: number, type: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    session_id: "epoch-export",
    session_header: {
      version: 0, id: "epoch-export", first_live_seq: 0, seed_length: 0,
      parent_session: null, origin: "user", delegation_depth: 0, agent_preset: "default",
    },
    route: { provider: "self_hosted", model: "fixture-model" },
    event_id: `epoch-export:${seq}`,
    timestamp: 1_786_900_100_000 + seq,
    event: { type, seq, time: 1_786_900_100_000 + seq, data, ...extra },
  });
  const payloads = [
    capsule(0, "request/header", { header: {
      config: { provider: "self_hosted", model: "fixture-model" },
      system: "Local research system",
      tools: [],
    }, reason: "initial" }),
    capsule(1, "turn/start", { turn: 0 }),
    capsule(2, "step/start", { turn: 0, step: 0 }),
    capsule(3, "user/message", {
      id: "user", role: "user", source: { kind: "user" },
      content: [{ type: "text", text: "Compile the fixture." }],
    }, { surfaceOp: "append" }),
    capsule(4, "assistant/message", {
      turn: 0, step: 0,
      message: {
        id: "assistant", role: "assistant",
        source: { kind: "model", provider: "self_hosted", model: "fixture-model" },
        content: [{ type: "text", text: "Fixture compiled." }],
      },
    }, { surfaceOp: "append", sourceEventSeqs: [] }),
    capsule(5, "step/end", { turn: 0, step: 0 }),
    capsule(6, "turn/end", { turn: 0, reason: { kind: "completed" } }),
  ];
  const bundle = fixtureBundle();
  bundle.manifest.source.adapter_version = "0.1.0";
  bundle.manifest.source.interface_version = DEEPSEEK_HARNESS_INTERFACE_VERSION;
  bundle.raw = payloads.map((payload, sequence) => ({
    envelope_version: "raw/0.1" as const,
    adapter: "deepseek_harness" as const,
    adapter_version: "0.1.0",
    interface_version: DEEPSEEK_HARNESS_INTERFACE_VERSION,
    captured_at: new Date(1_786_900_100_000 + sequence).toISOString(),
    sequence,
    source_event_id: `epoch-export:${sequence}`,
    session_id: "epoch-export",
    turn_id: null,
    payload_sha256: sha256(canonicalJson(payload)),
    payload,
  }));
  const events = [] as ReturnType<typeof normalizeRawEnvelope>;
  let nextSequence = 0;
  for (const envelope of bundle.raw) {
    const projected = normalizeRawEnvelope(envelope, { traceId: bundle.manifest.trace_id, nextSequence });
    for (const event of projected) {
      event.content = event.content.map((part) => ({ ...part, redaction_status: "passed" }));
      for (const key of ["raw_payload_sha256", "request_header_sha256", "dedupe_key"]) {
        if (key in event.metadata) event.metadata[key] = key === "dedupe_key" ? "dedupe-alpha" : "a".repeat(64);
      }
      events.push(event);
      nextSequence = Math.max(nextSequence, event.sequence + 1);
    }
  }
  bundle.events = events;
  bundle.manifest.lineage.raw_sha256 = sha256(canonicalJson(bundle.raw));
  const reviewed = applyAutomatedReview(sanitizeBundle(bundle).bundle).bundle;
  reapprove(reviewed);
  return reviewed;
}

describe("exporters", () => {
  it("keeps partial assistant chunks out of the HF conversational loss view", () => {
    const bundle = fixtureBundle("complete response");
    const partial = structuredClone(bundle.events[0]!);
    partial.event_id = "evt_partial_chunk";
    partial.span_id = "abcdabcdabcdabcd";
    partial.source_event_id = "provider-stream-chunk";
    partial.sequence = 0;
    partial.status = "partial";
    partial.content[0]!.value = "complete";
    partial.content[0]!.sha256 = sha256("complete");
    bundle.events[0]!.sequence = 1;
    bundle.events = [partial, bundle.events[0]!];

    const example = toHfExample(bundle);
    expect(example.messages).toHaveLength(1);
    expect(example.messages[0]).toMatchObject({ content: "complete response" });
    expect(example.assistant_loss_mask).toEqual([true]);
    expect(example.source_event_ids).toContain("evt_partial_chunk");
  });

  it("does not expose ungated format mappers from the public package surface", () => {
    expect(publicCore).not.toHaveProperty("toAtif");
    expect(publicCore).not.toHaveProperty("toHfExample");
    expect(publicCore).not.toHaveProperty("toHfExamples");
    expect(publicCore).not.toHaveProperty("toOtlp");
    expect(publicCore).toHaveProperty("exportApprovedBundle");
    expect(publicCore).not.toHaveProperty("compileTrainingView");
  });

  it("inventories opaque provider state while keeping its bytes out of plaintext export", async () => {
    const secret = "opaque-provider-state-must-never-escape-the-vault";
    const bundle = genericExportBundle("observable answer");
    const payload = {
      type: "assistant",
      content: [
        { type: "thinking", thinking: "provider summary", signature: secret },
        { type: "redacted_thinking", data: `${secret}-redacted` },
      ],
    };
    bundle.manifest.source.interface_version = "generic_json";
    bundle.raw = [{
      envelope_version: "raw/0.1",
      adapter: "manual_import",
      adapter_version: "0.1.0",
      interface_version: "generic_json",
      captured_at: "2026-08-21T00:00:00.000Z",
      sequence: 0,
      source_event_id: "opaque-fixture-0",
      session_id: "opaque-fixture",
      turn_id: null,
      payload_sha256: sha256(canonicalJson(payload)),
      payload,
    }];
    bundle.manifest.lineage.raw_sha256 = sha256(canonicalJson(bundle.raw));
    reapprove(bundle);

    const root = await mkdtemp(join(tmpdir(), "trajpack-opaque-export-"));
    try {
      const output = join(root, "canonical");
      const result = await exportApprovedBundle(bundle, {
        format: "canonical",
        mode: "archive",
        outputDirectory: output,
      });
      const report = JSON.parse(await readFile(join(output, "opaque-reasoning-report.json"), "utf8")) as {
        total_count: number;
        handling: string;
      };
      expect(report).toMatchObject({ total_count: 2, handling: "vault_only" });
      for (const path of result.files) {
        expect(await readFile(path, "utf8")).not.toContain(secret);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed without publishing output when the opaque-state scan is truncated", async () => {
    const bundle = genericExportBundle("observable answer");
    let payload: Record<string, unknown> = { terminal: "value" };
    for (let depth = 0; depth < 66; depth += 1) payload = { nested: payload };
    bundle.manifest.source.interface_version = "generic_json";
    bundle.raw = [{
      envelope_version: "raw/0.1",
      adapter: "manual_import",
      adapter_version: "0.1.0",
      interface_version: "generic_json",
      captured_at: "2026-08-21T00:00:00.000Z",
      sequence: 0,
      source_event_id: "opaque-depth-fixture-0",
      session_id: "opaque-depth-fixture",
      turn_id: null,
      payload_sha256: sha256(canonicalJson(payload)),
      payload,
    }];
    bundle.manifest.lineage.raw_sha256 = sha256(canonicalJson(bundle.raw));
    reapprove(bundle);

    const root = await mkdtemp(join(tmpdir(), "trajpack-opaque-truncated-"));
    try {
      const output = join(root, "canonical");
      await expect(exportApprovedBundle(bundle, {
        format: "canonical",
        mode: "archive",
        outputDirectory: output,
      })).rejects.toThrow("opaque provider-state inventory exceeded its scan limits");
      await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exports an explicit provider-exposed reasoning recipe with its evidence report", async () => {
    const bundle = fixtureBundle("Inspect the repository first.");
    bundle.manifest.source.host = "manual_import";
    bundle.manifest.source.surface = "manual_import";
    bundle.manifest.source.capture_method = "manual_copy";
    bundle.events[0]!.actor = "user";
    bundle.events[0]!.source_step_id = "step-0";
    const reasoning = structuredClone(bundle.events[0]!);
    reasoning.event_id = "reasoning-complete";
    reasoning.span_id = "9876987698769876";
    reasoning.sequence = 1;
    reasoning.actor = "assistant";
    reasoning.event_type = "reasoning";
    reasoning.status = "ok";
    reasoning.metadata.provider_route = "self_hosted";
    reasoning.metadata.model = "fixture-model";
    reasoning.content[0] = {
      ...reasoning.content[0]!,
      type: "reasoning",
      value: "Inspect the tests before changing implementation.",
      sha256: sha256("Inspect the tests before changing implementation."),
      reasoning: {
        representation: "provider_exposed_reasoning",
        provider_claim: "chain_of_thought",
        source_field: "reasoning_content",
        visibility: "api_only",
        include_in_loss: false,
      },
    };
    bundle.events = [bundle.events[0]!, reasoning];
    reapprove(bundle);
    const root = await mkdtemp(join(tmpdir(), "trajpack-reasoning-view-"));
    try {
      const output = join(root, "dataset");
      await exportApprovedBundle(bundle, {
        format: "hf-trl",
        mode: "training_noncompetitive",
        trainingRecipe: "reasoning_sft",
        outputDirectory: output,
      });
      const dataset = JSON.parse((await readFile(join(output, "dataset.jsonl"), "utf8")).trim()) as Record<string, unknown>;
      expect(dataset).toMatchObject({
        training_targets: [{ components: ["reasoning"] }],
        metadata: { view: { recipe: "reasoning_sft", objective: "sft" } },
      });
      const report = JSON.parse(await readFile(join(output, "training-view-report.json"), "utf8")) as Record<string, unknown>;
      expect(report).toMatchObject({
        recipe: "reasoning_sft",
        compiler_version: "training-view-compiler/0.2",
      });
      expect(await readFile(join(output, "DATASET_CARD.md"), "utf8")).toContain("reasoning_sft");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("exports exact Harness epochs through the selected canonical view without serializing raw capsules", async () => {
    const bundle = epochExportBundle();
    const root = await mkdtemp(join(tmpdir(), "trajpack-epoch-view-"));
    try {
      const output = join(root, "dataset");
      await exportApprovedBundle(bundle, {
        format: "hf-trl",
        mode: "training_noncompetitive",
        trainingRecipe: "deepseek_epoch_sft",
        outputDirectory: output,
      });
      const datasetText = await readFile(join(output, "dataset.jsonl"), "utf8");
      const dataset = JSON.parse(datasetText.trim()) as Record<string, unknown>;
      expect(dataset).toMatchObject({
        messages: [
          { role: "system", content: "Local research system" },
          { role: "user", content: "Compile the fixture." },
          { role: "assistant", content: "Fixture compiled." },
        ],
        assistant_loss_mask: [false, false, true],
        metadata: { view: { recipe: "deepseek_epoch_sft", exact_model_visible_surface: true } },
      });
      expect(datasetText).not.toContain("session_header");
      expect(datasetText).not.toContain("first_live_seq");
      const report = JSON.parse(await readFile(join(output, "training-view-report.json"), "utf8")) as Record<string, unknown>;
      expect(report).toMatchObject({ recipe: "deepseek_epoch_sft", views: [expect.any(Object)] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }

    const redacted = epochExportBundle();
    const output = redacted.events.find((event) => event.metadata.harness_seq === 4
      && event.event_type === "message")!;
    output.content[0]!.redaction_status = "redacted";
    output.content[0]!.value = "[REDACTED]";
    output.content[0]!.sha256 = sha256("[REDACTED]");
    reapprove(redacted);
    const rejectedRoot = await mkdtemp(join(tmpdir(), "trajpack-epoch-redacted-"));
    try {
      await expect(exportApprovedBundle(redacted, {
        format: "hf-trl",
        mode: "training_noncompetitive",
        trainingRecipe: "deepseek_epoch_sft",
        outputDirectory: join(rejectedRoot, "dataset"),
      })).rejects.toThrow(/produced no eligible views|RAW_LINEAGE_HASH_MISMATCH|CANONICAL/u);
    } finally {
      await rm(rejectedRoot, { recursive: true, force: true });
    }
  });

  it("refuses an ambiguous trace_full HF view for DeepSeek Harness", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dsh-trace-full-"));
    try {
      await expect(exportApprovedBundle(epochExportBundle(), {
        format: "hf-trl",
        outputDirectory: join(root, "hf"),
        mode: "training_competitive_distillation",
      })).rejects.toThrow("requires an explicit versioned recipe");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects plaintext output through a symlinked ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-export-symlink-"));
    const realParent = join(root, "real-parent");
    const linkedParent = join(root, "linked-parent");
    await mkdir(realParent);
    await symlink(realParent, linkedParent, "dir");
    try {
      await expect(exportApprovedBundle(fixtureBundle(), {
        format: "canonical",
        outputDirectory: join(linkedParent, "dataset"),
      })).rejects.toThrow("symbolic-link or junction ancestor");
      await expect(stat(join(realParent, "dataset"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps canonical events to ATIF-v1.7 steps with parallel calls, observations, metrics, compaction, and visible reasoning", () => {
    const bundle = fixtureBundle("research prompt");
    const user = bundle.events[0]!;
    user.actor = "user";
    user.source_step_id = "user-step";

    const callA = structuredClone(user);
    callA.event_id = "call-event-a";
    callA.span_id = "1111111111111111";
    callA.sequence = 1;
    callA.actor = "assistant";
    callA.event_type = "tool.call";
    callA.source_step_id = "parallel-step";
    callA.content = [];
    callA.tool = {
      call_id: "call-a",
      name: "search",
      arguments: { query: "trajectory distillation" },
      result: null,
      exit_code: null,
    };
    callA.usage = {
      input_tokens: 7,
      output_tokens: 3,
      reasoning_tokens: 1,
      cache_read_tokens: 2,
      latency_ms: 12,
      cost_usd: 0.5,
    };
    callA.metadata = {
      llm_call_count: 1,
      input_schema: { type: "object", properties: { query: { type: "string" } } },
    };

    const callB = structuredClone(callA);
    callB.event_id = "call-event-b";
    callB.span_id = "2222222222222222";
    callB.sequence = 2;
    callB.tool = {
      call_id: "call-b",
      name: "fetch",
      arguments: "{\"url\":\"https://example.test\"}",
      result: null,
      exit_code: null,
    };
    callB.usage = {
      input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      cache_read_tokens: null,
      latency_ms: null,
      cost_usd: null,
    };
    callB.metadata = {};

    const resultA = structuredClone(callA);
    resultA.event_id = "result-event-a";
    resultA.span_id = "3333333333333333";
    resultA.sequence = 3;
    resultA.actor = "tool";
    resultA.event_type = "tool.result";
    resultA.content = [];
    resultA.tool = {
      call_id: "call-a",
      name: "search",
      arguments: null,
      result: { hits: 2 },
      exit_code: 0,
    };
    resultA.usage = {
      input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      cache_read_tokens: null,
      latency_ms: null,
      cost_usd: null,
    };

    const resultB = structuredClone(resultA);
    resultB.event_id = "result-event-b";
    resultB.span_id = "4444444444444444";
    resultB.sequence = 4;
    resultB.tool = {
      call_id: "call-b",
      name: "fetch",
      arguments: null,
      result: "paper body",
      exit_code: 0,
    };

    const compaction = structuredClone(user);
    compaction.event_id = "compaction-event";
    compaction.span_id = "5555555555555555";
    compaction.sequence = 5;
    compaction.actor = "system";
    compaction.event_type = "compaction";
    compaction.source_step_id = "compact-step";
    compaction.content[0]!.value = "Summary: retained experimental context";

    const reasoning = structuredClone(user);
    reasoning.event_id = "reasoning-event";
    reasoning.span_id = "6666666666666666";
    reasoning.sequence = 6;
    reasoning.actor = "agent";
    reasoning.event_type = "reasoning";
    reasoning.source_step_id = "reasoning-step";
    reasoning.content[0]!.type = "reasoning";
    reasoning.content[0]!.value = "visible provider summary";
    reasoning.content[0]!.reasoning = {
      representation: "provider_summary",
      provider_claim: "reasoning_summary",
      source_field: "thinking",
      visibility: "user_visible",
      include_in_loss: false,
    };
    const opaque = structuredClone(reasoning.content[0]!);
    opaque.ordinal = 1;
    opaque.value = "opaque state must not escape";
    opaque.reasoning = {
      representation: "opaque_reasoning_state",
      provider_claim: "none",
      source_field: null,
      visibility: "not_returned",
      include_in_loss: false,
    };
    reasoning.content.push(opaque);

    bundle.events = [user, callA, callB, resultA, resultB, compaction, reasoning];
    const atif = toAtif(bundle) as {
      schema_version: string;
      trajectory_id: string;
      agent: { name: string; version: string; tool_definitions: unknown[] };
      steps: Array<Record<string, unknown>>;
      final_metrics: Record<string, unknown>;
      extra: Record<string, unknown>;
    };

    expect(atif.schema_version).toBe("ATIF-v1.7");
    expect(atif.trajectory_id).toBe(bundle.manifest.trace_id);
    expect(atif.agent).toMatchObject({
      name: bundle.manifest.source.product,
      version: bundle.manifest.source.adapter_version,
    });
    expect(atif.agent.tool_definitions).toHaveLength(2);
    expect(atif.steps.map((step) => step.step_id)).toEqual([1, 2, 3, 4]);
    expect(atif.steps.map((step) => step.source)).toEqual(["user", "agent", "system", "agent"]);

    const toolStep = atif.steps[1]!;
    expect(toolStep.tool_calls).toEqual([
      expect.objectContaining({ tool_call_id: "call-a", function_name: "search", arguments: { query: "trajectory distillation" } }),
      expect.objectContaining({ tool_call_id: "call-b", function_name: "fetch", arguments: { url: "https://example.test" } }),
    ]);
    expect(toolStep.observation).toMatchObject({
      results: [
        expect.objectContaining({ source_call_id: "call-a", content: "{\"hits\":2}" }),
        expect.objectContaining({ source_call_id: "call-b", content: "paper body" }),
      ],
    });
    expect(toolStep.metrics).toEqual({
      prompt_tokens: 7,
      completion_tokens: 3,
      cached_tokens: 2,
      cost_usd: 0.5,
      extra: { reasoning_tokens: 1, latency_ms: 12 },
    });
    expect(toolStep.llm_call_count).toBe(1);

    expect(atif.steps[2]).toMatchObject({
      source: "system",
      observation: { results: [expect.objectContaining({ content: "Summary: retained experimental context" })] },
      extra: { context_management: { type: "compaction", boundary: "replace" } },
    });
    expect(atif.steps[3]!.reasoning_content).toBe("visible provider summary");
    expect(JSON.stringify(atif)).not.toContain("opaque state must not escape");
    expect(atif.final_metrics).toMatchObject({
      total_prompt_tokens: 7,
      total_completion_tokens: 3,
      total_cached_tokens: 2,
      total_cost_usd: 0.5,
      total_steps: 4,
      extra: { total_reasoning_tokens: 1, total_latency_ms: 12 },
    });
    expect(atif).not.toHaveProperty("messages");
    expect(atif).not.toHaveProperty("reward");
    expect(atif).not.toHaveProperty("provenance");

    const hf = toHfExample(bundle);
    const assistantCalls = hf.messages.filter((message) => Array.isArray(message.tool_calls));
    expect(assistantCalls).toHaveLength(1);
    expect(assistantCalls[0]!.tool_calls).toHaveLength(2);
    expect(hf.messages.filter((message) => message.role === "tool")).toHaveLength(2);
    expect(hf.training_targets.find((target) => target.components.includes("tool_arguments"))?.source_event_ids)
      .toEqual(["call-event-a", "call-event-b"]);
  });

  it("does not invent parallel tool-call grouping without a complete source boundary", () => {
    const bundle = fixtureBundle();
    const first = bundle.events[0]!;
    first.event_type = "tool.call";
    first.actor = "agent";
    first.content = [];
    first.tool = { call_id: "call-1", name: "one", arguments: {}, result: null, exit_code: null };
    first.source_step_id = null;
    const second = structuredClone(first);
    second.event_id = "second-call";
    second.sequence = 1;
    second.span_id = "7777777777777777";
    second.tool.call_id = "call-2";
    bundle.events.push(second);

    const atif = toAtif(bundle) as { steps: Array<Record<string, unknown>> };
    expect(atif.steps).toHaveLength(2);
    expect(atif.steps.map((step) => (step.tool_calls as unknown[]).length)).toEqual([1, 1]);
  });

  it("preserves an orphan tool result as an unpaired ATIF observation", () => {
    const bundle = fixtureBundle();
    const result = bundle.events[0]!;
    result.event_type = "tool.result";
    result.actor = "tool";
    result.content = [];
    result.tool = { call_id: "missing-call", name: "probe", arguments: null, result: "partial output", exit_code: 1 };
    const step = (toAtif(bundle) as { steps: Array<Record<string, unknown>> }).steps[0]!;
    expect(step.source).toBe("system");
    expect(step.observation).toEqual({
      results: [expect.objectContaining({
        content: "partial output",
        extra: { trajpack: expect.objectContaining({ unpaired_source_call_id: "missing-call" }) },
      })],
    });
  });

  it("isolates imported sessions and mutually exclusive message branches", () => {
    const bundle = fixtureBundle("session-a root");
    const root = bundle.events[0]!;
    root.actor = "user";
    root.source_session_id = "session-a";
    root.metadata.source_parent_message_id = null;
    const branchOne = structuredClone(root);
    branchOne.event_id = "branch-one";
    branchOne.span_id = "1111111111111111";
    branchOne.parent_span_id = root.span_id;
    branchOne.sequence = 1;
    branchOne.actor = "assistant";
    branchOne.content[0]!.value = "session-a branch one";
    branchOne.metadata.source_parent_message_id = root.event_id;
    const branchTwo = structuredClone(branchOne);
    branchTwo.event_id = "branch-two";
    branchTwo.span_id = "2222222222222222";
    branchTwo.sequence = 2;
    branchTwo.content[0]!.value = "session-a branch two";
    const otherRoot = structuredClone(root);
    otherRoot.event_id = "session-b-root";
    otherRoot.span_id = "3333333333333333";
    otherRoot.sequence = 3;
    otherRoot.source_session_id = "session-b";
    otherRoot.content[0]!.value = "session-b root";
    const otherAnswer = structuredClone(branchOne);
    otherAnswer.event_id = "session-b-answer";
    otherAnswer.span_id = "4444444444444444";
    otherAnswer.parent_span_id = otherRoot.span_id;
    otherAnswer.sequence = 4;
    otherAnswer.source_session_id = "session-b";
    otherAnswer.content[0]!.value = "session-b answer";
    otherAnswer.metadata.source_parent_message_id = otherRoot.event_id;
    bundle.events = [root, branchOne, branchTwo, otherRoot, otherAnswer];

    const examples = toHfExamples(bundle);
    expect(examples).toHaveLength(3);
    expect(examples.map((example) => example.messages.map((message) => message.content))).toEqual([
      ["session-a root", "session-a branch one"],
      ["session-a root", "session-a branch two"],
      ["session-b root", "session-b answer"],
    ]);
    expect(() => toHfExample(bundle)).toThrow("3 isolated HF views");
  });

  it("keeps native message structure and aligned loss masks", () => {
    const example = toHfExample(fixtureBundle());
    expect(example.messages).toHaveLength(example.assistant_loss_mask.length);
    expect(example.assistant_loss_mask).toEqual([true]);
    expect(example.training_targets).toEqual([{
      message_index: 0,
      components: ["answer_text"],
      loss_weight: 1,
      source_event_ids: ["evt_fixture"],
    }]);
  });

  it("emits component-level HF targets for plans, included reasoning, and tool calls", () => {
    const plan = fixtureBundle("execute the controlled experiment");
    plan.events[0]!.event_type = "plan";
    const reasoningPart = structuredClone(plan.events[0]!.content[0]!);
    reasoningPart.ordinal = 1;
    reasoningPart.type = "reasoning";
    reasoningPart.value = "observable rationale";
    reasoningPart.reasoning = {
      representation: "generated_rationale",
      provider_claim: "rationale",
      source_field: "rationale",
      visibility: "user_visible",
      include_in_loss: true,
    };
    plan.events[0]!.content.push(reasoningPart);
    expect(toHfExample(plan).training_targets).toEqual([{
      message_index: 0,
      components: ["plan", "reasoning"],
      loss_weight: 1,
      source_event_ids: ["evt_fixture"],
    }]);

    const tool = fixtureBundle();
    tool.events[0]!.event_type = "tool.call";
    tool.events[0]!.content = [];
    tool.events[0]!.tool = {
      call_id: "call-target",
      name: "run_test",
      arguments: { suite: "core" },
      result: null,
      exit_code: null,
    };
    expect(toHfExample(tool).training_targets).toEqual([{
      message_index: 0,
      components: ["tool_name", "tool_arguments"],
      loss_weight: 1,
      source_event_ids: ["evt_fixture"],
    }]);
  });

  it("exports rewards only with concrete verifier provenance", () => {
    const unverified = fixtureBundle();
    const target = unverified.events[0]!;
    const evaluation = structuredClone(target);
    evaluation.event_id = "evt_evaluation";
    evaluation.span_id = "1111111111111111";
    evaluation.sequence = 1;
    evaluation.event_type = "evaluation";
    evaluation.actor = "environment";
    evaluation.content = [];
    evaluation.metadata = {
      reward: 1,
      target_event_id: target.event_id,
      target_event_sha256: reviewEvidenceFingerprint(target),
    };
    unverified.events = [target, evaluation];
    expect(toHfExample(unverified).reward).toBeNull();

    const verifier = {
      name: "tests",
      version: "1.2.3",
      artifact_sha256: "a".repeat(64),
      result_sha256: null,
    };
    evaluation.metadata.verifier = verifier;
    evaluation.metadata.trajpack_review = {
      verifier_confirmation: {
        schema_version: "verifier-confirmation/0.1",
        reviewer: "fixture-reviewer",
        evidence_ref: "verifier-run:fixture",
        confirmed_at: "2026-08-16T00:00:00.000Z",
        event_sha256: reviewEvidenceFingerprint(evaluation),
        reward: 1,
        verifier,
      },
    };
    const verified = toHfExample(unverified);
    expect(verified.reward).toBeNull();
    expect(verified.verifier).toBeNull();
    expect(verified.metadata.verified_label_source_event_id).toBeNull();

    const atif = toAtif(unverified) as {
      reward?: unknown;
      extra: { trajpack: { verified_label: unknown } };
    };
    expect(atif.reward).toBeUndefined();
    expect(atif.extra.trajpack.verified_label).toEqual({
      reward: 1,
      verifier: { name: "tests", version: "1.2.3" },
      sourceEventId: "evt_evaluation",
      targetEventId: "evt_fixture",
      targetEventSha256: reviewEvidenceFingerprint(target),
    });
  });

  it("honors reasoning loss metadata and omits opaque reasoning states", () => {
    const summary = fixtureBundle("visible summary");
    summary.events[0]!.event_type = "reasoning";
    summary.events[0]!.content[0]!.type = "reasoning";
    summary.events[0]!.content[0]!.reasoning = {
      representation: "provider_summary",
      provider_claim: "reasoning_summary",
      source_field: "thinking",
      visibility: "user_visible",
      include_in_loss: false,
    };
    const summaryExample = toHfExample(summary);
    expect(summaryExample.assistant_loss_mask).toEqual([]);
    expect(summaryExample.messages).toEqual([]);

    summary.events[0]!.content[0]!.reasoning.representation = "opaque_reasoning_state";
    summary.events[0]!.content[0]!.reasoning.visibility = "not_returned";
    summary.events[0]!.content[0]!.value = "opaque marker";
    expect(toHfExample(summary).messages).toEqual([]);
  });

  it("refuses HF/TRL through a non-training mode while allowing ATIF archival interchange", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-export-mode-"));
    try {
      await expect(exportApprovedBundle(fixtureBundle(), {
        format: "hf-trl",
        outputDirectory: join(root, "dataset"),
        mode: "archive",
      })).rejects.toThrow("require an explicit training eligibility gate");
      await exportApprovedBundle(fixtureBundle(), {
        format: "atif",
        outputDirectory: join(root, "atif"),
        mode: "archive",
      });
      expect(await readFile(join(root, "atif", "trajectory.atif.json"), "utf8"))
        .toContain("ATIF-v1.7");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes canonical data with checksums", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-export-"));
    const output = join(root, "dataset");
    try {
      await exportApprovedBundle(fixtureBundle(), { format: "canonical", outputDirectory: output });
      expect(await readFile(join(output, "manifest.json"), "utf8")).toContain("trajectory/0.1");
      expect(await readFile(join(output, "checksums.txt"), "utf8")).toContain("events.jsonl");
      expect(await readFile(join(output, "redaction-report.json"), "utf8")).toContain("redaction/0.1");
      expect(await readFile(join(output, "license-summary.json"), "utf8")).toContain("data_license_is_independent");
      expect(await readFile(join(output, "COMPLETE"), "utf8")).toContain("export-complete/0.1");
      const digest = fixtureBundle().events[0]!.content[0]!.sha256;
      expect((await stat(join(output, "blobs", "sha256", digest))).isFile()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes native nested HF conversational Parquet columns", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-export-hf-parquet-"));
    const output = join(root, "dataset");
    try {
      await exportApprovedBundle(genericExportBundle("assistant parquet answer"), {
        format: "hf-trl",
        outputDirectory: output,
        mode: "training_competitive_distillation",
      });
      const reader = await ParquetReader.openFile(join(output, "dataset.parquet"));
      try {
        const row = await reader.getCursor().next() as Record<string, unknown> | null;
        expect(row).not.toBeNull();
        expect(row?.messages).toEqual([expect.objectContaining({
          role: "assistant",
          content: "assistant parquet answer",
        })]);
        expect(row?.assistant_loss_mask).toEqual([true]);
        expect(row).not.toHaveProperty("messages_json");
      } finally {
        await reader.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not export content-derived provenance hashes after redaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-export-redacted-provenance-"));
    const output = join(root, "dataset");
    const bundle = fixtureBundle("[REDACTED:api_key]");
    const event = bundle.events[0]!;
    event.content[0]!.redaction_status = "redacted";
    event.event_id = `self_hosted:${"2".repeat(64)}:message:0`;
    event.source_event_id = "2".repeat(64);
    event.metadata.raw_payload_sha256 = "2".repeat(64);
    bundle.manifest.lineage.raw_sha256 = "3".repeat(64);
    reapprove(bundle);
    try {
      await exportApprovedBundle(bundle, { format: "canonical", outputDirectory: output });
      const plaintext = `${await readFile(join(output, "manifest.json"), "utf8")}\n${await readFile(join(output, "events.jsonl"), "utf8")}`;
      expect(plaintext).not.toContain("2".repeat(64));
      expect(plaintext).not.toContain("3".repeat(64));
      expect(plaintext).toContain("redacted:");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never emits excluded review content in canonical plaintext", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-export-selection-"));
    const output = join(root, "dataset");
    const bundle = fixtureBundle("included sentinel");
    const excluded = structuredClone(bundle.events[0]!);
    excluded.event_id = "evt_excluded";
    excluded.span_id = "fedcba9876543210";
    excluded.sequence = 1;
    excluded.review_disposition = "exclude";
    excluded.content[0]!.value = "must never escape sentinel";
    bundle.events.push(excluded);
    reapprove(bundle);
    try {
      await exportApprovedBundle(bundle, { format: "canonical", outputDirectory: output });
      const events = await readFile(join(output, "events.jsonl"), "utf8");
      expect(events).toContain("included sentinel");
      expect(events).not.toContain("must never escape sentinel");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let a structured tool copy bypass an excluded content projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-export-tool-selection-"));
    const bundle = genericExportBundle("included assistant answer");
    const toolEvent = structuredClone(bundle.events[0]!);
    toolEvent.event_id = "evt_excluded_tool_projection";
    toolEvent.span_id = "1234123412341234";
    toolEvent.sequence = 1;
    toolEvent.event_type = "tool.call";
    toolEvent.tool = {
      call_id: "call-excluded",
      name: "run_secret",
      arguments: { value: "STRUCTURED_REVIEW_EXCLUSION_SENTINEL" },
      result: null,
      exit_code: null,
    };
    toolEvent.content = [{
      ...toolEvent.content[0]!,
      type: "tool_call",
      value: "STRUCTURED_REVIEW_EXCLUSION_SENTINEL",
      sha256: sha256("STRUCTURED_REVIEW_EXCLUSION_SENTINEL"),
      review_disposition: "exclude",
    }];
    bundle.events.push(toolEvent);
    attestToolRights(bundle, 1);
    reapprove(bundle);
    try {
      const canonical = join(root, "canonical");
      const atif = join(root, "atif");
      const hf = join(root, "hf");
      await exportApprovedBundle(bundle, { format: "canonical", outputDirectory: canonical });
      await exportApprovedBundle(bundle, { format: "atif", outputDirectory: atif, mode: "archive" });
      await exportApprovedBundle(bundle, {
        format: "hf-trl",
        outputDirectory: hf,
        mode: "training_competitive_distillation",
      });
      const plaintext = [
        await readFile(join(canonical, "events.jsonl"), "utf8"),
        await readFile(join(atif, "trajectory.atif.json"), "utf8"),
        await readFile(join(hf, "dataset.jsonl"), "utf8"),
        await readFile(join(hf, "provenance.json"), "utf8"),
      ].join("\n");
      expect(plaintext).toContain("included assistant answer");
      expect(plaintext).not.toContain("STRUCTURED_REVIEW_EXCLUSION_SENTINEL");
      expect(plaintext).not.toContain("call-excluded");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes opaque reasoning parts from canonical training views", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-export-opaque-"));
    const output = join(root, "dataset");
    const bundle = fixtureBundle("opaque state sentinel");
    bundle.events[0]!.event_type = "reasoning";
    bundle.events[0]!.content[0]!.type = "reasoning";
    bundle.events[0]!.content[0]!.reasoning = {
      representation: "opaque_reasoning_state",
      provider_claim: "none",
      source_field: null,
      visibility: "not_returned",
      include_in_loss: false,
    };
    reapprove(bundle);
    try {
      await exportApprovedBundle(bundle, {
        format: "canonical",
        outputDirectory: output,
        mode: "training_competitive_distillation",
      });
      expect(await readFile(join(output, "events.jsonl"), "utf8")).not.toContain("opaque state sentinel");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves canonical-only patch and verifier fields in every lossy-format sidecar", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-export-sidecar-"));
    const bundle = genericExportBundle("diff --git a/a.ts b/a.ts");
    bundle.events[0]!.event_type = "artifact.patch";
    bundle.events[0]!.content[0]!.type = "patch";
    bundle.events[0]!.metadata.verifier = { name: "repo-tests", version: "2.0.0" };
    bundle.events[0]!.metadata.reward = 1;
    const answer = structuredClone(fixtureBundle("assistant training answer").events[0]!);
    answer.event_id = "answer-event";
    answer.span_id = "9999999999999999";
    answer.sequence = 1;
    answer.source_event_id = "answer-source";
    bundle.events.push(answer);
    reapprove(bundle);
    try {
      for (const format of ["atif", "hf-trl", "otlp"] as const) {
        const output = join(root, format);
        await exportApprovedBundle(bundle, {
          format,
          outputDirectory: output,
          mode: "training_competitive_distillation",
        });
        const sidecar = await readFile(join(output, "provenance.json"), "utf8");
        expect(sidecar, format).toContain("artifact.patch");
        expect(sidecar, format).toContain("repo-tests");
        expect(sidecar, format).toContain("diff --git");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("attests the approved source and validates each derived canonical view", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-export-attestation-"));
    const output = join(root, "dataset");
    try {
      await exportApprovedBundle(fixtureBundle(), { format: "canonical", outputDirectory: output });
      const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
      const events = (await readFile(join(output, "events.jsonl"), "utf8"))
        .split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
      const exported = { manifest, events, raw: [] };
      expect(manifest.review.approval_scope.export_pass_version).toBe("export-view/0.1");
      expect(manifest.review.approval_scope.approved_source_bundle_sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(validateApprovalScope(exported, "archive")).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
