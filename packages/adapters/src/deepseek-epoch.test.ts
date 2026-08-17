import { describe, expect, it } from "vitest";

import { compileDeepSeekRequestEpochs, DEEPSEEK_EPOCH_COMPILER_VERSION } from "./deepseek-epoch.js";
import { normalizeDeepSeekSessionEvent } from "./deepseek.js";

function capsule(
  seq: number,
  type: string,
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    session_id: "session-a",
    session_header: {
      version: 0,
      id: "session-a",
      parent_session: null,
      origin: "user",
      delegation_depth: 0,
      agent_preset: "default",
    },
    event_id: `session-a:${seq}`,
    timestamp: 1_786_900_000_000 + seq,
    event: { type, seq, time: 1_786_900_000_000 + seq, data, ...extra },
  };
}

const header = capsule(0, "request/header", {
  reason: "initial",
  header: {
    config: { provider: "deepseek-official", model: "deepseek-reasoner", temperature: 0 },
    adapterDefaults: { temperature: 0 },
    system: "You are a coding agent.",
    tools: [{ name: "shell", description: "Run a command", inputSchema: { type: "object" } }],
  },
});

describe("compileDeepSeekRequestEpochs", () => {
  it("projects request system text and tool schemas into independently scannable content parts", () => {
    const normalized = normalizeDeepSeekSessionEvent(header, {
      traceId: "0".repeat(32),
      capturedAt: "2026-08-17T00:00:00.000Z",
    });

    expect(normalized.events).toHaveLength(1);
    expect(normalized.events[0]!.content).toEqual([
      expect.objectContaining({ type: "text", mime_type: "text/plain; role=system", value: "You are a coding agent." }),
      expect.objectContaining({ type: "file_ref", mime_type: "application/vnd.trajpack.tool-schema+json" }),
    ]);
    expect(normalized.events[0]!.metadata).toMatchObject({
      tool_schema_count: 1,
      request_config: { provider: "deepseek-official", model: "deepseek-reasoner", temperature: 0 },
      request_content_roles: [
        { ordinal: 0, role: "system" },
        { ordinal: 1, role: "tool_schema" },
      ],
    });
  });

  it("does not infer DeepSeek reasoning provenance from a proxy substring", () => {
    const proxied = capsule(0, "assistant/message", {
      turn: 0,
      step: 0,
      message: {
        id: "proxy-answer",
        role: "assistant",
        source: { kind: "model", provider: "openai-deepseek-proxy", model: "proxy-model" },
        content: [{ type: "reasoning", text: "visible but provenance-ambiguous" }],
      },
    }, { surfaceOp: "append", sourceEventSeqs: [] });
    const normalized = normalizeDeepSeekSessionEvent(proxied, {
      traceId: "0".repeat(32),
      capturedAt: "2026-08-17T00:00:00.000Z",
    });

    expect(normalized.events[0]!.content[0]!.reasoning).toMatchObject({
      representation: "opaque_reasoning_state",
      provider_claim: "none",
      include_in_loss: false,
    });
  });

  it("reconstructs the exact request header and model-visible surface before output", () => {
    const result = compileDeepSeekRequestEpochs([
      header,
      capsule(1, "turn/start", { turn: 0 }),
      capsule(2, "step/start", { turn: 0, step: 0 }),
      capsule(3, "user/message", {
        id: "user-1",
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "Run the tests" }],
      }, { surfaceOp: "append", sourceEventSeqs: [1] }),
      capsule(4, "assistant/chunk", {
        turn: 0,
        step: 0,
        chunk: { type: "reasoning-delta", index: 0, text: "I should inspect the suite." },
      }),
      capsule(5, "assistant/message", {
        turn: 0,
        step: 0,
        message: {
          id: "assistant-1",
          role: "assistant",
          source: { kind: "model", provider: "deepseek-official", model: "deepseek-reasoner" },
          content: [{ type: "text", text: "Running tests." }],
        },
      }, { surfaceOp: "append", sourceEventSeqs: [4] }),
      capsule(6, "step/end", { turn: 0, step: 0 }),
      capsule(7, "turn/end", { turn: 0, reason: { kind: "completed" } }),
    ]);

    expect(result.complete).toBe(true);
    expect(result.compiler_version).toBe(DEEPSEEK_EPOCH_COMPILER_VERSION);
    expect(result.diagnostics).toEqual([]);
    expect(result.epochs).toHaveLength(1);
    expect(result.epochs[0]).toMatchObject({
      provider: "deepseek-official",
      model: "deepseek-reasoner",
      turn: 0,
      step: 0,
      request_header_seq: 0,
      output_event_seq: 5,
      system: "You are a coding agent.",
      reconstructable: true,
      output_source_event_seqs: [4],
    });
    expect(result.epochs[0]!.tools).toHaveLength(1);
    expect(result.epochs[0]!.surface_before.map((message) => message.surface_seq)).toEqual([3]);
    expect(result.epochs[0]!.input_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.epochs[0]!.output_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("folds a compaction replacement before compiling the next epoch", () => {
    const values = [
      header,
      capsule(1, "turn/start", { turn: 0 }),
      capsule(2, "step/start", { turn: 0, step: 0 }),
      capsule(3, "user/message", {
        id: "u1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "Long prompt" }],
      }, { surfaceOp: "append", sourceEventSeqs: [1] }),
      capsule(4, "assistant/message", {
        turn: 0, step: 0,
        message: {
          id: "a1", role: "assistant",
          source: { kind: "model", provider: "deepseek-official", model: "deepseek-reasoner" },
          content: [{ type: "text", text: "Long answer" }],
        },
      }, { surfaceOp: "append", sourceEventSeqs: [] }),
      capsule(5, "step/end", { turn: 0, step: 0 }),
      capsule(6, "user/message", {
        id: "summary", role: "user", source: { kind: "compaction" },
        content: [{ type: "text", text: "Summary" }],
      }, { surfaceOp: { op: "replace", start: 3, end: 4 }, sourceEventSeqs: [3, 4] }),
      capsule(7, "step/start", { turn: 0, step: 1 }),
      capsule(8, "assistant/message", {
        turn: 0, step: 1,
        message: {
          id: "a2", role: "assistant",
          source: { kind: "model", provider: "deepseek-official", model: "deepseek-reasoner" },
          content: [{ type: "text", text: "Continue" }],
        },
      }, { surfaceOp: "append", sourceEventSeqs: [] }),
      capsule(9, "step/end", { turn: 0, step: 1 }),
      capsule(10, "turn/end", { turn: 0, reason: { kind: "completed" } }),
    ];
    const result = compileDeepSeekRequestEpochs(values);

    expect(result.complete).toBe(true);
    expect(result.epochs).toHaveLength(2);
    expect(result.epochs[1]!.surface_before.map((message) => message.surface_seq)).toEqual([6]);
    expect(result.epochs[1]!.surface_before[0]!.message_sha256)
      .not.toBe(result.epochs[0]!.surface_before[0]!.message_sha256);
  });

  it("fails closed on sequence gaps and invalid replacement provenance", () => {
    const result = compileDeepSeekRequestEpochs([
      header,
      capsule(2, "turn/start", { turn: 0 }),
      capsule(3, "user/message", {
        id: "summary", role: "user", source: { kind: "compaction" }, content: [],
      }, { surfaceOp: { op: "replace", start: 10, end: 11 }, sourceEventSeqs: [] }),
    ]);

    expect(result.complete).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining([
      "sequence_gap_or_duplicate",
      "surface_replace_invalid",
    ]));
  });

  it("rejects unknown required records but permits explicitly ignorable extensions", () => {
    const required = compileDeepSeekRequestEpochs([
      header,
      capsule(1, "plugin/changes-surface", {}),
    ]);
    const ignorable = compileDeepSeekRequestEpochs([
      header,
      capsule(1, "plugin/telemetry", {}, { ignorable: true }),
    ]);

    expect(required.complete).toBe(false);
    expect(required.diagnostics).toContainEqual(expect.objectContaining({ code: "unknown_required_event" }));
    expect(ignorable.complete).toBe(true);
    expect(ignorable.diagnostics).toContainEqual(expect.objectContaining({
      code: "unknown_ignorable_event",
      severity: "warning",
    }));
  });

  it("rejects an assembled output whose model source conflicts with the request route", () => {
    const result = compileDeepSeekRequestEpochs([
      header,
      capsule(1, "turn/start", { turn: 0 }),
      capsule(2, "step/start", { turn: 0, step: 0 }),
      capsule(3, "assistant/message", {
        turn: 0,
        step: 0,
        message: {
          id: "wrong-teacher",
          role: "assistant",
          source: { kind: "model", provider: "openai", model: "gpt-x" },
          content: [{ type: "text", text: "OPENAI_OUTPUT" }],
        },
      }, { surfaceOp: "append", sourceEventSeqs: [] }),
    ]);

    expect(result.complete).toBe(false);
    expect(result.epochs[0]?.reconstructable).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "output_route_mismatch",
      severity: "error",
    }));
  });
});
