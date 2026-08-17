import type { Host, RawEnvelope, TraceBundle } from "@trajpack/schema";
import { canonicalJson, sha256 } from "./canonical.js";

const PINNED_INTERFACES: Readonly<Record<Host, ReadonlySet<string>>> = {
  codex: new Set(["codex-exec-jsonl/1", "codex-hook/1", "codex-app-server-v2-jsonrpc/1"]),
  claude_code: new Set(["claude-stream-json/1", "claude-hook/1", "claude-transcript-opaque/1"]),
  gemini_cli: new Set(["gemini-cli-hook/1"]),
  deepseek_harness: new Set(["deepseek-harness@0.1.0-rc.6/session-event/0"]),
  browser: new Set(["authorized-dom/0.1"]),
  manual_import: new Set([
    "chatgpt_official_json",
    "chatgpt_official_html",
    "claude_official_json",
    "gemini_takeout_activity_json",
    "gemini_takeout_activity_html",
    "deepseek_api_response",
    "generic_json",
    "generic_jsonl",
    "generic_html",
  ]),
};

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

export function observedRawSource(raw: RawEnvelope[]): { interfaceVersion: string; adapterVersion: string } | null {
  if (raw.length === 0) return null;
  return {
    interfaceVersion: sortedUnique(raw.map((envelope) => envelope.interface_version)).join("+"),
    adapterVersion: sortedUnique(raw.map((envelope) => envelope.adapter_version)).join("+"),
  };
}

export function rawIntegrityReasons(bundle: TraceBundle): string[] {
  if (bundle.raw.length === 0) return [];
  const reasons: string[] = [];
  const sequenceCounts = new Map<number, number>();
  let previous = -1;
  for (const envelope of bundle.raw) {
    sequenceCounts.set(envelope.sequence, (sequenceCounts.get(envelope.sequence) ?? 0) + 1);
    if (envelope.sequence <= previous) reasons.push("RAW_SEQUENCE_NON_MONOTONIC");
    previous = envelope.sequence;
    if (envelope.adapter !== bundle.manifest.source.host) reasons.push("RAW_ADAPTER_MISMATCH");
    if (!PINNED_INTERFACES[envelope.adapter].has(envelope.interface_version)) reasons.push("RAW_INTERFACE_UNSUPPORTED");
    if (sha256(canonicalJson(envelope.payload)) !== envelope.payload_sha256) reasons.push("RAW_PAYLOAD_HASH_MISMATCH");
  }
  const unique = [...sequenceCounts.keys()].sort((left, right) => left - right);
  if (unique.some((sequence, index) => sequence !== index)) reasons.push("RAW_SEQUENCE_GAP");
  if ([...sequenceCounts.values()].some((count) => count > 1)) reasons.push("RAW_SEQUENCE_DUPLICATE");
  const observed = observedRawSource(bundle.raw)!;
  if (bundle.manifest.source.interface_version !== observed.interfaceVersion) reasons.push("RAW_INTERFACE_MANIFEST_MISMATCH");
  if (bundle.manifest.source.adapter_version !== observed.adapterVersion) reasons.push("RAW_ADAPTER_VERSION_MANIFEST_MISMATCH");
  if (bundle.manifest.lineage.raw_sha256 !== sha256(canonicalJson(bundle.raw))) reasons.push("RAW_LINEAGE_HASH_MISMATCH");
  return [...new Set(reasons)].sort();
}
