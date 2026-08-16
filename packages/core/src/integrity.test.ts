import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "./canonical.js";
import { rawIntegrityReasons } from "./integrity.js";
import { fixtureBundle } from "./testing.js";

describe("raw integrity", () => {
  it("binds payloads, strict vault sequence, source interface, and aggregate lineage", () => {
    const bundle = fixtureBundle();
    const payload = { type: "turn/start", session_id: "session" };
    bundle.manifest.source.host = "deepseek_harness";
    bundle.manifest.source.interface_version = "deepseek-harness@0.1.0-rc.6/session-event/0";
    bundle.manifest.source.adapter_version = "0.1.0";
    bundle.raw = [{
      envelope_version: "raw/0.1",
      adapter: "deepseek_harness",
      adapter_version: "0.1.0",
      interface_version: "deepseek-harness@0.1.0-rc.6/session-event/0",
      captured_at: "2026-08-16T00:00:00.000Z",
      sequence: 0,
      source_event_id: "raw-0",
      session_id: "session",
      turn_id: null,
      payload_sha256: sha256(canonicalJson(payload)),
      payload,
    }];
    bundle.manifest.lineage.raw_sha256 = sha256(canonicalJson(bundle.raw));
    expect(rawIntegrityReasons(bundle)).toEqual([]);
    bundle.raw[0]!.sequence = 2;
    expect(rawIntegrityReasons(bundle)).toContain("RAW_SEQUENCE_GAP");
    bundle.raw[0]!.payload = { type: "tampered" };
    expect(rawIntegrityReasons(bundle)).toContain("RAW_PAYLOAD_HASH_MISMATCH");
  });
});
