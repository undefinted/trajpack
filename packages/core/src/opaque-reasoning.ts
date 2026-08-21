import type { RawEnvelope } from "@trajpack/schema";

/**
 * Opaque provider state is protocol data, not an observable rationale.  The
 * inventory deliberately exposes only counts and locations; ciphertext,
 * signatures, and content-addresses never enter plaintext reports.
 */
export type OpaqueReasoningArtifactKind =
  | "anthropic_thinking_signature"
  | "anthropic_redacted_thinking"
  | "google_thought_signature"
  | "openai_encrypted_reasoning";

export interface OpaqueReasoningArtifactLocation {
  raw_sequence: number;
  kind: OpaqueReasoningArtifactKind;
  path: string;
  byte_length: number;
}

export interface OpaqueReasoningInventory {
  schema_version: "opaque-reasoning-inventory/0.2";
  handling: "vault_only";
  total_count: number;
  by_kind: Record<OpaqueReasoningArtifactKind, number>;
  locations: OpaqueReasoningArtifactLocation[];
  scan_truncated: boolean;
}

const MAX_VISITED_NODES = 100_000;
const MAX_DEPTH = 64;
const MAX_ARTIFACTS = 10_000;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function addString(
  locations: OpaqueReasoningArtifactLocation[],
  rawSequence: number,
  kind: OpaqueReasoningArtifactKind,
  path: string,
  value: unknown,
): void {
  if (typeof value !== "string" || value.length === 0 || locations.length >= MAX_ARTIFACTS) return;
  locations.push({ raw_sequence: rawSequence, kind, path, byte_length: byteLength(value) });
}

function inspectObject(
  value: Record<string, unknown>,
  rawSequence: number,
  path: string,
  locations: OpaqueReasoningArtifactLocation[],
): void {
  const type = typeof value.type === "string" ? value.type : null;
  if (type === "thinking" || type === "signature_delta") {
    addString(locations, rawSequence, "anthropic_thinking_signature", `${path}.signature`, value.signature);
  }
  if (type === "redacted_thinking") {
    addString(locations, rawSequence, "anthropic_redacted_thinking", `${path}.data`, value.data);
  }
  if (type === "reasoning") {
    addString(locations, rawSequence, "openai_encrypted_reasoning", `${path}.encrypted_content`, value.encrypted_content);
    addString(locations, rawSequence, "openai_encrypted_reasoning", `${path}.encryptedContent`, value.encryptedContent);
  }
  addString(locations, rawSequence, "google_thought_signature", `${path}.thought_signature`, value.thought_signature);
  addString(locations, rawSequence, "google_thought_signature", `${path}.thoughtSignature`, value.thoughtSignature);
}

/**
 * Inventory known provider reasoning envelopes in raw in-memory events.  This
 * is a bounded, cycle-safe metadata scan.  It never interprets or returns the
 * opaque values and is therefore suitable for review/export security reports.
 */
export function inventoryOpaqueReasoningArtifacts(raw: readonly RawEnvelope[]): OpaqueReasoningInventory {
  const locations: OpaqueReasoningArtifactLocation[] = [];
  let visited = 0;
  let scanTruncated = false;

  for (const envelope of raw) {
    const seen = new WeakSet<object>();
    const visit = (value: unknown, path: string, depth: number): void => {
      if (scanTruncated) return;
      visited += 1;
      if (visited > MAX_VISITED_NODES || depth > MAX_DEPTH) {
        scanTruncated = true;
        return;
      }
      if (value === null || typeof value !== "object") return;
      if (seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        value.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
        return;
      }
      const object = record(value)!;
      inspectObject(object, envelope.sequence, path, locations);
      if (locations.length >= MAX_ARTIFACTS) {
        scanTruncated = true;
        return;
      }
      // Raw object keys are attacker/user-controlled and may themselves carry
      // secrets. Only structural ordinals and fixed recognized terminal field
      // names are permitted in a plaintext inventory path.
      for (const [index, entry] of Object.values(object).entries()) {
        visit(entry, `${path}.object[${index}]`, depth + 1);
      }
    };
    visit(envelope.payload, "$.payload", 0);
  }

  const byKind: OpaqueReasoningInventory["by_kind"] = {
    anthropic_thinking_signature: 0,
    anthropic_redacted_thinking: 0,
    google_thought_signature: 0,
    openai_encrypted_reasoning: 0,
  };
  for (const location of locations) byKind[location.kind] += 1;
  return {
    schema_version: "opaque-reasoning-inventory/0.2",
    handling: "vault_only",
    total_count: locations.length,
    by_kind: byKind,
    locations,
    scan_truncated: scanTruncated,
  };
}
