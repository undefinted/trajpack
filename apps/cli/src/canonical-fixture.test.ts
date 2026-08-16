import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyJsonLine, normalizeRawEnvelope } from "@trajpack/adapters";
import { canonicalJson, sha256 } from "@trajpack/core";

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const CAPTURED_AT = "2026-08-16T00:00:00.000Z";

describe("cross-platform canonical fixture", () => {
  it("normalizes one raw capsule to the pinned digest on every CI operating system", () => {
    const lines = readFileSync(
      new URL("../../../packages/adapters/fixtures/codex.exec.jsonl", import.meta.url),
      "utf8",
    ).split(/\r?\n/).filter(Boolean);
    const events = [] as ReturnType<typeof normalizeRawEnvelope>;
    for (const [sequence, line] of lines.entries()) {
      const classified = classifyJsonLine("codex", line, sequence);
      if (!classified) throw new Error(`Fixture line ${sequence + 1} was rejected`);
      events.push(...normalizeRawEnvelope(
        { ...classified, captured_at: CAPTURED_AT },
        { traceId: TRACE_ID, nextSequence: events.length },
      ));
    }
    expect(sha256(canonicalJson(events))).toBe("b70c732bc41bce384c89602ab90cb066332398b076ff8cce736f417da6d09f63");
  });
});
