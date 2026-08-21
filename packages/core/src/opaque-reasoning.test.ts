import type { RawEnvelope } from "@trajpack/schema";
import { describe, expect, it } from "vitest";

import { canonicalJson, sha256 } from "./canonical.js";
import { inventoryOpaqueReasoningArtifacts } from "./opaque-reasoning.js";

function envelope(payload: unknown, sequence = 0): RawEnvelope {
  return {
    envelope_version: "raw/0.1",
    adapter: "claude_code",
    adapter_version: "0.1.0",
    interface_version: "test/1",
    captured_at: "2026-08-21T00:00:00.000Z",
    sequence,
    source_event_id: null,
    session_id: null,
    turn_id: null,
    payload_sha256: sha256(canonicalJson(payload)),
    payload,
  };
}

describe("opaque reasoning inventory", () => {
  it("finds known provider envelopes without returning their values or hashes", () => {
    const secret = "ciphertext-that-must-remain-vault-only";
    const report = inventoryOpaqueReasoningArtifacts([envelope({
      content: [
        { type: "thinking", thinking: "summary", signature: secret },
        { type: "redacted_thinking", data: `${secret}-redacted` },
        { type: "reasoning", encrypted_content: `${secret}-openai` },
        { thoughtSignature: `${secret}-google` },
      ],
    })]);

    expect(report.total_count).toBe(4);
    expect(report.by_kind).toEqual({
      anthropic_thinking_signature: 1,
      anthropic_redacted_thinking: 1,
      google_thought_signature: 1,
      openai_encrypted_reasoning: 1,
    });
    expect(report.locations.every((location) => location.byte_length > 0)).toBe(true);
    expect(canonicalJson(report)).not.toContain(secret);
    expect(canonicalJson(report)).not.toContain(sha256(secret));
  });

  it("does not treat unrelated signatures as model reasoning state", () => {
    const report = inventoryOpaqueReasoningArtifacts([envelope({
      package_signature: "release-signature",
      signature: "document-signature",
      type: "artifact",
    })]);
    expect(report.total_count).toBe(0);
  });

  it("never copies attacker-controlled object keys into plaintext locations", () => {
    const sensitiveKey = "customer@example.com API_KEY_super_secret";
    const report = inventoryOpaqueReasoningArtifacts([envelope({
      [sensitiveKey]: { thought_signature: "opaque-provider-state" },
    })]);
    expect(report.schema_version).toBe("opaque-reasoning-inventory/0.2");
    expect(report.total_count).toBe(1);
    expect(report.locations[0]!.path).toBe("$.payload.object[0].thought_signature");
    expect(canonicalJson(report)).not.toContain(sensitiveKey);
  });
});
