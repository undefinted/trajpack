import { mkdtemp, mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ParquetReader } from "@dsnp/parquetjs";
import { describe, expect, it } from "vitest";
import { exportApprovedBundle, toAtif, toHfExample, toHfExamples } from "./exporters.js";
import * as publicCore from "./index.js";
import { createApprovalScope, reviewEvidenceFingerprint, validateApprovalScope } from "./policy.js";
import { fixtureBundle } from "./testing.js";

function reapprove(bundle: ReturnType<typeof fixtureBundle>): void {
  bundle.manifest.review.approval_scope = createApprovalScope(bundle, [
    "archive",
    "training_noncompetitive",
    "training_competitive_distillation",
    "redistribution",
  ]);
}

describe("exporters", () => {
  it("does not expose ungated format mappers from the public package surface", () => {
    expect(publicCore).not.toHaveProperty("toAtif");
    expect(publicCore).not.toHaveProperty("toHfExample");
    expect(publicCore).not.toHaveProperty("toHfExamples");
    expect(publicCore).not.toHaveProperty("toOtlp");
    expect(publicCore).toHaveProperty("exportApprovedBundle");
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
    unverified.events[0]!.event_type = "evaluation";
    unverified.events[0]!.metadata.reward = 1;
    expect(toHfExample(unverified).reward).toBeNull();

    const verifier = {
      name: "tests",
      version: "1.2.3",
      artifact_sha256: "a".repeat(64),
      result_sha256: null,
    };
    unverified.events[0]!.metadata.verifier = verifier;
    unverified.events[0]!.metadata.trajpack_review = {
      verifier_confirmation: {
        schema_version: "verifier-confirmation/0.1",
        reviewer: "fixture-reviewer",
        evidence_ref: "verifier-run:fixture",
        confirmed_at: "2026-08-16T00:00:00.000Z",
        event_sha256: reviewEvidenceFingerprint(unverified.events[0]!),
        reward: 1,
        verifier,
      },
    };
    const verified = toHfExample(unverified);
    expect(verified.reward).toBe(1);
    expect(verified.verifier).toEqual({ name: "tests", version: "1.2.3" });
    expect(verified.metadata.verified_label_source_event_id).toBe("evt_fixture");

    const atif = toAtif(unverified) as {
      reward?: unknown;
      extra: { trajpack: { verified_label: unknown } };
    };
    expect(atif.reward).toBeUndefined();
    expect(atif.extra.trajpack.verified_label).toEqual({
      reward: 1,
      verifier: { name: "tests", version: "1.2.3" },
      sourceEventId: "evt_fixture",
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
      await exportApprovedBundle(fixtureBundle("assistant parquet answer"), {
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
    const bundle = fixtureBundle("diff --git a/a.ts b/a.ts");
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
