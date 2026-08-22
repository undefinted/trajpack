import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ParquetReader } from "@dsnp/parquetjs";
import {
  DEEPSEEK_HARNESS_INTERFACE_VERSION,
  normalizeRawEnvelope,
} from "@trajpack/adapters";
import type { DatasetExample, RawEnvelope, TraceBundle, TrajectoryEvent } from "@trajpack/schema";
import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "./canonical.js";
import { exportApprovedBundle } from "./exporters.js";
import { createApprovalScope, reviewEvidenceFingerprint } from "./policy.js";
import { fixtureBundle } from "./testing.js";

const SESSION_ID = "dsh-research-golden";
const RAW_ONLY_SENTINEL = "RAW_PERSISTENCE_CURSOR_MUST_NEVER_LEAK";
const START_MILLIS = 1_786_900_000_000;

function capsule(
  seq: number,
  type: string,
  data: Record<string, unknown>,
  eventFields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    session_id: SESSION_ID,
    session_header: {
      version: 0,
      id: SESSION_ID,
      first_live_seq: 0,
      seed_length: 0,
      parent_session: null,
      origin: "user",
      delegation_depth: 0,
      agent_preset: "research",
      opaque_storage_cursor: RAW_ONLY_SENTINEL,
    },
    route: { provider: "deepseek-official", model: "deepseek-reasoner" },
    event_id: `${SESSION_ID}:${seq}`,
    timestamp: START_MILLIS + seq,
    event: { type, seq, time: START_MILLIS + seq, data, ...eventFields },
  };
}

function goldenPayloads(): Record<string, unknown>[] {
  return [
    capsule(0, "request/header", {
      reason: "initial",
      header: {
        config: {
          provider: "deepseek-official",
          model: "deepseek-reasoner",
          reasoningEffort: "high",
          temperature: 0,
        },
        system: "You are a research coding agent.",
        tools: [{
          name: "shell",
          description: "Run a command in the controlled workspace",
          inputSchema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
            additionalProperties: false,
          },
        }],
      },
    }),
    capsule(1, "turn/start", { turn: 0 }),
    capsule(2, "step/start", { turn: 0, step: 0 }),
    capsule(3, "user/message", {
      id: "user-initial",
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: "Run the complete test suite." }],
    }, { surfaceOp: "append", sourceEventSeqs: [1] }),
    // The same logical call appears as a stream delta, an assembled model
    // message, and an execution lifecycle record. Only seq=5 is trainable.
    capsule(4, "assistant/chunk", {
      turn: 0,
      step: 0,
      chunk: {
        type: "tool-call-delta",
        index: 0,
        id: "call-shell",
        name: "shell",
        argumentsDelta: "{\"command\":\"pnpm test\"}",
      },
    }),
    capsule(5, "assistant/message", {
      turn: 0,
      step: 0,
      message: {
        id: "assistant-tool",
        role: "assistant",
        source: { kind: "model", provider: "deepseek-official", model: "deepseek-reasoner" },
        content: [{
          type: "tool-call",
          id: "call-shell",
          name: "shell",
          arguments: { command: "pnpm test" },
        }],
      },
    }, { surfaceOp: "append", sourceEventSeqs: [4] }),
    capsule(6, "tool/call", {
      turn: 0,
      step: 0,
      callId: "call-shell",
      name: "shell",
      arguments: "{\"command\":\"pnpm test\"}",
    }),
    capsule(7, "step/end", { turn: 0, step: 0 }),
    capsule(8, "tool/result", {
      turn: 0,
      step: 0,
      message: {
        id: "tool-result",
        role: "user",
        source: { kind: "tool", callId: "call-shell" },
        content: [{
          type: "tool-result",
          toolCallId: "call-shell",
          content: [{ type: "text", text: "142 tests passed" }],
        }],
      },
    }, { surfaceOp: "append" }),
    capsule(9, "step/start", { turn: 0, step: 1 }),
    capsule(10, "assistant/message", {
      turn: 0,
      step: 1,
      message: {
        id: "assistant-observation",
        role: "assistant",
        source: { kind: "model", provider: "deepseek-official", model: "deepseek-reasoner" },
        content: [{ type: "text", text: "The complete suite passed." }],
      },
    }, { surfaceOp: "append", sourceEventSeqs: [] }),
    capsule(11, "step/end", { turn: 0, step: 1 }),
    capsule(12, "compaction/start", { turn: 0, step: 1, compactionId: "compact-golden" }),
    capsule(13, "compaction/summary", {
      turn: 0,
      step: 1,
      compactionId: "compact-golden",
      summary: "All tests passed; only the verified outcome remains relevant.",
    }),
    capsule(14, "user/message", {
      id: "compaction-replacement",
      role: "user",
      source: { kind: "compaction" },
      content: [{ type: "text", text: "Compacted context: 142 tests passed." }],
    }, {
      surfaceOp: { op: "replace", start: 3, end: 10 },
      sourceEventSeqs: [3, 5, 8, 10],
    }),
    capsule(15, "compaction/end", {
      turn: 0,
      step: 1,
      compactionId: "compact-golden",
      status: "completed",
    }),
    capsule(16, "step/start", { turn: 0, step: 2 }),
    capsule(17, "assistant/chunk", {
      turn: 0,
      step: 2,
      chunk: {
        type: "reasoning-delta",
        index: 0,
        text: "The verifier result is sufficient.",
      },
    }),
    capsule(18, "assistant/message", {
      turn: 0,
      step: 2,
      message: {
        id: "assistant-final-response",
        role: "assistant",
        source: { kind: "model", provider: "deepseek-official", model: "deepseek-reasoner" },
        content: [
          { type: "reasoning", text: "The verifier result is sufficient." },
          { type: "text", text: "The validated run is complete." },
        ],
      },
    }, { surfaceOp: "append", sourceEventSeqs: [17] }),
    capsule(19, "step/end", { turn: 0, step: 2 }),
    capsule(20, "turn/end", { turn: 0, reason: { kind: "completed" } }),
  ];
}

function attestStructuredToolRights(bundle: TraceBundle): void {
  const decision = bundle.manifest.eligibility.training_competitive_distillation;
  const sourceSha256 = sha256(canonicalJson(bundle.manifest.source));
  for (const event of bundle.events.filter((candidate) => candidate.tool !== null)) {
    event.metadata.trajpack_review = {
      rights_attestation: {
        schema_version: "rights-attestation/0.1",
        rights: bundle.manifest.rights,
        scopes: [{
          mode: "training_competitive_distillation",
          target_model_owner: decision.target_model_owner,
          target_product: decision.target_product,
        }],
        reviewer: "research-golden-reviewer",
        evidence_ref: "rights-evidence:deepseek-golden",
        evidence_sha256: "d".repeat(64),
        attested_at: "2026-08-16T00:00:00.000Z",
        expires_at: "2099-01-01T00:00:00.000Z",
        event_sha256: reviewEvidenceFingerprint(event),
        source_sha256: sourceSha256,
      },
    };
  }
}

function approvedGoldenBundle(): TraceBundle {
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
  trace.manifest.account_contract.account_type = "api";
  trace.manifest.account_contract.terms = [
    {
      name: "DeepSeek Terms of Use (unverified test locator; not permission evidence)",
      url: "https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html",
      effective_at: "2026-03-27T00:00:00.000Z",
      retrieved_at: "2026-08-16T00:00:00.000Z",
      snapshot_sha256: "e".repeat(64),
      review_after: "2099-01-01T00:00:00.000Z",
    },
    {
      name: "DeepSeek Open Platform Terms (unverified test locator; not permission evidence)",
      url: "https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html",
      effective_at: "2026-04-29T00:00:00.000Z",
      retrieved_at: "2026-08-16T00:00:00.000Z",
      snapshot_sha256: "f".repeat(64),
      review_after: "2099-01-01T00:00:00.000Z",
    },
  ];

  trace.raw = goldenPayloads().map((payload, sequence): RawEnvelope => ({
    envelope_version: "raw/0.1",
    adapter: "deepseek_harness",
    adapter_version: "0.1.0",
    interface_version: DEEPSEEK_HARNESS_INTERFACE_VERSION,
    captured_at: new Date(START_MILLIS + sequence).toISOString(),
    sequence,
    source_event_id: `${SESSION_ID}:${sequence}`,
    session_id: SESSION_ID,
    turn_id: null,
    payload_sha256: sha256(canonicalJson(payload)),
    payload,
  }));

  const normalized: TrajectoryEvent[] = [];
  let nextSequence = 0;
  for (const envelope of trace.raw) {
    const events = normalizeRawEnvelope(envelope, {
      traceId: trace.manifest.trace_id,
      nextSequence,
    });
    for (const event of events) {
      event.content = event.content.map((part) => ({ ...part, redaction_status: "passed" }));
      normalized.push(event);
      nextSequence = Math.max(nextSequence, event.sequence + 1);
    }
  }
  trace.events = normalized;
  trace.manifest.lineage.raw_sha256 = sha256(canonicalJson(trace.raw));
  attestStructuredToolRights(trace);
  trace.manifest.review.approval_scope = createApprovalScope(trace, [
    "training_noncompetitive",
    "training_competitive_distillation",
  ]);
  return trace;
}

function viewMetadata(example: DatasetExample): Record<string, unknown> {
  const value = example.metadata.view;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Golden example is missing training-view provenance");
  }
  return value as Record<string, unknown>;
}

describe("DeepSeek Harness research vertical", () => {
  it("exports an exact approved rc.6 epoch into JSONL, native Parquet, and a provenance report", async () => {
    const bundle = approvedGoldenBundle();
    const finalReasoning = bundle.events.find((event) =>
      event.metadata.harness_seq === 18 && event.event_type === "reasoning");
    expect(finalReasoning?.content[0]?.reasoning).toEqual({
      representation: "provider_exposed_reasoning",
      provider_claim: "chain_of_thought",
      source_field: "message.content[].reasoning",
      visibility: "api_only",
      // Canonical capture never opts a part into loss by default. The explicit,
      // approved epoch recipe below is the independent supervision decision.
      include_in_loss: false,
    });
    const root = await mkdtemp(join(tmpdir(), "trajpack-dsh-vertical-"));
    const output = join(root, "hf");
    try {
      const result = await exportApprovedBundle(bundle, {
        format: "hf-trl",
        outputDirectory: output,
        mode: "training_competitive_distillation",
        trainingRecipe: "deepseek_epoch_sft",
      });

      expect(Object.keys(result.checksums)).toEqual(expect.arrayContaining([
        "dataset.jsonl",
        "dataset.parquet",
        "training-view-report.json",
        "provenance.json",
      ]));
      const jsonlText = await readFile(join(output, "dataset.jsonl"), "utf8");
      const reportText = await readFile(join(output, "training-view-report.json"), "utf8");
      const examples = jsonlText.trim().split("\n").map((line) => JSON.parse(line) as DatasetExample);
      expect(examples).toHaveLength(3);

      const toolEpoch = examples.find((example) => viewMetadata(example).output_event_seq === 5);
      const compactedEpoch = examples.find((example) => viewMetadata(example).output_event_seq === 18);
      expect(toolEpoch).toBeDefined();
      expect(compactedEpoch).toBeDefined();

      const exportedCalls = toolEpoch!.messages.flatMap((message) =>
        Array.isArray(message.tool_calls) ? message.tool_calls : []);
      expect(exportedCalls).toEqual([{
        id: "call-shell",
        type: "function",
        function: { name: "shell", arguments: "{\"command\":\"pnpm test\"}" },
      }]);
      expect(toolEpoch!.training_targets).toEqual([expect.objectContaining({
        components: ["tool_name", "tool_arguments"],
      })]);

      expect(compactedEpoch!.messages).toEqual([
        expect.objectContaining({
          role: "system",
          content: "You are a research coding agent.",
        }),
        expect.objectContaining({
          role: "user",
          content: "Compacted context: 142 tests passed.",
        }),
        expect.objectContaining({
          role: "assistant",
          content: "The validated run is complete.",
          reasoning_content: "The verifier result is sufficient.",
        }),
      ]);
      expect(canonicalJson(compactedEpoch!.messages)).not.toContain("Run the complete test suite.");
      expect(canonicalJson(compactedEpoch!.messages)).not.toContain("The complete suite passed.");
      expect(compactedEpoch!.tools).toEqual([expect.objectContaining({
        type: "function",
        function: {
          name: "shell",
          description: "Run a command in the controlled workspace",
          parameters: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
            additionalProperties: false,
          },
        },
      })]);
      expect(compactedEpoch!.assistant_loss_mask).toEqual([false, false, true]);
      expect(compactedEpoch!.training_targets).toEqual([{
        message_index: 2,
        components: ["reasoning", "answer_text"],
        loss_weight: 1,
        source_event_ids: expect.arrayContaining([finalReasoning!.event_id]),
      }]);
      expect(compactedEpoch!.reward).toBeNull();
      expect(compactedEpoch!.verifier).toBeNull();
      expect(viewMetadata(compactedEpoch!)).toMatchObject({
        recipe: "deepseek_epoch_sft",
        recipe_version: "deepseek-exact-request-epoch-sft/0.1",
        compiler_version: "training-view-compiler/0.2",
        epoch_compiler_version: "dsh-epoch/0.1",
        provider: "deepseek-official",
        model: "deepseek-reasoner",
        request_header_seq: 0,
        input_surface_seqs: [14],
        output_event_seq: 18,
        exact_model_visible_surface: true,
        target_contains_provider_exposed_reasoning: true,
        reasoning_loss_enabled: true,
        hidden_chain_of_thought_claimed: false,
      });
      expect(viewMetadata(compactedEpoch!).epoch_input_sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(viewMetadata(compactedEpoch!).epoch_output_sha256).toMatch(/^[a-f0-9]{64}$/u);

      const report = JSON.parse(reportText) as {
        views: Array<{ metadata: Record<string, unknown>; target_event_ids: string[] }>;
      };
      const finalReportView = report.views.find((view) => view.metadata.output_event_seq === 18);
      expect(finalReportView).toMatchObject({
        target_event_ids: compactedEpoch!.training_targets[0]!.source_event_ids,
        metadata: {
          input_surface_seqs: [14],
          source_raw_seqs: expect.arrayContaining([0, 3, 5, 8, 10, 14, 17, 18]),
        },
      });

      for (const plaintext of [jsonlText, reportText]) {
        expect(plaintext).not.toContain(RAW_ONLY_SENTINEL);
        expect(plaintext).not.toContain("opaque_storage_cursor");
        expect(plaintext).not.toContain("session_header");
        expect(plaintext).not.toContain("surfaceOp");
        expect(plaintext).not.toContain("sourceEventSeqs");
      }

      const reader = await ParquetReader.openFile(join(output, "dataset.parquet"));
      try {
        const rows: Array<Record<string, unknown>> = [];
        const cursor = reader.getCursor();
        let row: Record<string, unknown> | null;
        while ((row = await cursor.next() as Record<string, unknown> | null) !== null) rows.push(row);
        expect(rows).toHaveLength(examples.length);
        const parquetFinal = rows.find((candidate) => {
          const metadata = JSON.parse(String(candidate.metadata_json)) as { view?: { output_event_seq?: number } };
          return metadata.view?.output_event_seq === 18;
        });
        expect(parquetFinal).toBeDefined();
        expect(parquetFinal?.messages).toEqual([
          expect.objectContaining({ role: "system", content: "You are a research coding agent." }),
          expect.objectContaining({ role: "user", content: "Compacted context: 142 tests passed." }),
          expect.objectContaining({
            role: "assistant",
            content: "The validated run is complete.",
            reasoning_content: "The verifier result is sufficient.",
          }),
        ]);
        expect(parquetFinal?.assistant_loss_mask).toEqual([false, false, true]);
        expect(parquetFinal?.training_targets).toEqual([expect.objectContaining({
          message_index: 2n,
          components: ["reasoning", "answer_text"],
        })]);
        expect(parquetFinal?.tools).toEqual([expect.objectContaining({
          function: expect.objectContaining({
            name: "shell",
            parameters_json: canonicalJson({
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
              additionalProperties: false,
            }),
          }),
        })]);
        expect(JSON.stringify(parquetFinal, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value)).not.toContain(RAW_ONLY_SENTINEL);
      } finally {
        await reader.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
