import type { RawEnvelope } from "@trajpack/schema";
import { detectImportFormat } from "./detect.js";
import { canonicalJson, sha256Bytes } from "./hash.js";
import { extractNonExecutingHtmlPreview } from "./html.js";
import {
  IMPORTER_VERSION,
  IMPORT_PROVENANCE_VERSION,
  type ImportedPayload,
  type ImportOptions,
  type ImportProvenance,
  type ImportResult,
  type ZipEntryProvenance,
} from "./types.js";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const MAX_HARNESS_SESSION_HEADER_BYTES = 1024 * 1024;
const MAX_HARNESS_SESSION_HEADER_NODES = 50_000;
const MAX_HARNESS_SESSION_HEADER_DEPTH = 64;
const MAX_IMPORT_RECORDS = 250_000;
const MAX_IMPORT_STRUCTURE_NODES = 2_000_000;
const MAX_IMPORT_STRUCTURE_DEPTH = 64;

function boundedStructureNodes(value: unknown): number {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (current.depth > MAX_IMPORT_STRUCTURE_DEPTH) {
      throw new Error(`Import record exceeds the structural depth limit of ${MAX_IMPORT_STRUCTURE_DEPTH}`);
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
    } else if (current.value !== null && typeof current.value === "object") {
      for (const child of Object.values(current.value as Record<string, unknown>)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return nodes;
}

function assertBoundedHarnessHeader(value: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_HARNESS_SESSION_HEADER_NODES || current.depth > MAX_HARNESS_SESSION_HEADER_DEPTH) {
      throw new Error("DeepSeek Harness persistence header exceeds structural limits");
    }
    if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
    } else if (current.value !== null && typeof current.value === "object") {
      for (const child of Object.values(current.value as Record<string, unknown>)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  if (new TextEncoder().encode(canonicalJson(value)).byteLength > MAX_HARNESS_SESSION_HEADER_BYTES) {
    throw new Error("DeepSeek Harness persistence header exceeds the 1 MiB limit");
  }
}

function decodeInput(input: string | Uint8Array): { text: string; bytes: Uint8Array } {
  if (typeof input === "string") {
    const bytes = new TextEncoder().encode(input);
    return { text: input, bytes };
  }
  return { text: new TextDecoder("utf-8", { fatal: true }).decode(input), bytes: input };
}

function assertIsoDatetime(value: string): void {
  if (!Number.isFinite(Date.parse(value)) || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) {
    throw new Error("capturedAt must be an ISO-8601 datetime");
  }
}

function inferSessionId(record: unknown): string | null {
  if (typeof record !== "object" || record === null || Array.isArray(record)) return null;
  const candidate = record as Record<string, unknown>;
  for (const key of ["conversation_id", "uuid", "id", "session_id"]) {
    const value = candidate[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function importedRecord(record: unknown, provenance: ImportProvenance): ImportedPayload {
  if (
    (provenance.detected_format === "generic_html"
      || provenance.detected_format === "chatgpt_official_html"
      || provenance.detected_format === "gemini_takeout_activity_html") &&
    typeof record === "string"
  ) {
    return {
      record_kind: "imported_record",
      provenance,
      record: {
        html: record,
        non_executing_text_preview: extractNonExecutingHtmlPreview(record),
        preview_is_not_visibility_evidence: true,
      },
    };
  }
  return { record_kind: "imported_record", provenance, record };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function deepSeekHarnessEnvelopes(
  records: unknown[],
  provenance: ImportProvenance,
  fallbackCapturedAt: string,
): RawEnvelope[] {
  const header = record(records[0]);
  if (header === null || header.type !== "session" || header.version !== 0) {
    throw new Error("DeepSeek Harness persistence header is invalid");
  }
  const sessionId = nonEmptyText(header.id);
  if (sessionId === null) throw new Error("DeepSeek Harness persistence header has no session id");
  assertBoundedHarnessHeader(header);
  const headerSha256 = sha256Bytes(canonicalJson(header));
  let route: { provider: string | null; model: string | null } | null = null;
  return records.slice(1).map((value, sequence) => {
    const event = record(value);
    if (event === null || event.seq !== sequence) throw new Error("DeepSeek Harness persistence sequence is not contiguous");
    const data = record(event.data) ?? {};
    if (event.type === "request/header") {
      const requestHeader = record(data.header);
      const config = requestHeader === null ? null : record(requestHeader.config);
      if (config !== null) {
        const provider = nonEmptyText(config.provider);
        const model = nonEmptyText(config.model);
        // Preserve the previously observed route when a later header omits the
        // provider/model fields; a partial config must not erase valid route
        // evidence for every subsequent event.
        if (provider !== null && model !== null) route = { provider, model };
      }
    } else if (event.type === "assistant/message") {
      const message = record(data.message);
      const source = message === null ? null : record(message.source);
      if (source?.kind === "model") {
        const provider = nonEmptyText(source.provider);
        const model = nonEmptyText(source.model);
        if (provider !== null && model !== null) route = { provider, model };
      }
    }
    const observedDate = typeof event.time === "number" && Number.isFinite(event.time)
      ? new Date(event.time)
      : null;
    const timestamp = observedDate !== null && !Number.isNaN(observedDate.valueOf())
      ? observedDate.toISOString()
      : fallbackCapturedAt;
    const payload = {
      session_id: sessionId,
      // Preserve the complete persistence header as encrypted raw provenance.
      // `session_header` below is the pinned projection consumed by the live
      // adapter; this opaque copy keeps future/unknown official fields without
      // making the normalizer depend on them.
      ...(sequence === 0 ? { persistence_session_header_raw: header } : {}),
      persistence_session_header_sha256: headerSha256,
      session_header: {
        version: 0,
        id: sessionId,
        parent_session: nonEmptyText(header.parentSession),
        origin: nonEmptyText(header.origin),
        delegation_depth: header.delegationDepth,
        agent_preset: nonEmptyText(header.agentPreset),
        // A full, unpacked persistence artifact starts at durable sequence 0.
        // CaptureSession uses this boundary to distinguish a complete import
        // from a resumed live stream whose first observed sequence may be > 0.
        first_live_seq: 0,
        first_observed_seq: 0,
        seed_length: header.seedLength ?? null,
        created_at: header.createdAt,
        cwd: nonEmptyText(header.cwd),
      },
      route,
      event_id: `${sessionId}:${sequence}`,
      timestamp: event.time,
      event,
      persistence_provenance: {
        detected_format: provenance.detected_format,
        original_sha256: provenance.original_sha256,
        source_authenticity: provenance.source_authenticity,
        unpacked_event_rows: true,
      },
    };
    return {
      envelope_version: "raw/0.1",
      adapter: "deepseek_harness",
      adapter_version: IMPORTER_VERSION,
      interface_version: "deepseek-harness@0.1.0-rc.6/session-event/0",
      captured_at: timestamp,
      sequence,
      source_event_id: `${sessionId}:${sequence}`,
      session_id: sessionId,
      turn_id: typeof data.turn === "number" ? String(data.turn) : null,
      payload_sha256: sha256Bytes(canonicalJson(payload)),
      payload,
    } satisfies RawEnvelope;
  });
}

function importInput(
  input: string | Uint8Array,
  options: ImportOptions,
  archive: ZipEntryProvenance | null,
): ImportResult {
  const { text, bytes } = decodeInput(input);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be a positive safe integer");
  if (bytes.byteLength > maxBytes) throw new Error(`Import input exceeds the ${maxBytes}-byte limit`);

  const capturedAt = options.capturedAt ?? new Date().toISOString();
  assertIsoDatetime(capturedAt);
  const { detection, records } = detectImportFormat(text, options);
  if (records.length > MAX_IMPORT_RECORDS) {
    throw new Error(`Import contains more than ${MAX_IMPORT_RECORDS} records`);
  }
  let structuralNodes = 0;
  for (const record of records) {
    structuralNodes += boundedStructureNodes(record);
    if (structuralNodes > MAX_IMPORT_STRUCTURE_NODES) {
      throw new Error(`Import exceeds the structural node limit of ${MAX_IMPORT_STRUCTURE_NODES}`);
    }
  }

  const sourceProduct = detection.format === "chatgpt_official_json" || detection.format === "chatgpt_official_html"
    ? "chatgpt"
    : detection.format === "claude_official_json"
      ? "claude"
      : detection.format === "gemini_takeout_activity_json" || detection.format === "gemini_takeout_activity_html"
        ? "gemini"
      : detection.format === "deepseek_api_response"
        ? "deepseek_api"
        : detection.format === "deepseek_harness_session_jsonl"
          ? "deepseek_harness"
        : "generic";
  const provenance: ImportProvenance = {
    schema_version: IMPORT_PROVENANCE_VERSION,
    importer_version: IMPORTER_VERSION,
    import_method: sourceProduct === "deepseek_harness"
      ? "host_persistence"
      : sourceProduct === "generic" || sourceProduct === "deepseek_api" ? "manual_import" : "official_export",
    source_product: sourceProduct,
    source_authenticity: "unverified_user_supplied",
    fidelity: sourceProduct === "generic" ? "C" : "B",
    detected_format: detection.format,
    detection_basis: detection.basis,
    original_filename: options.filename ?? null,
    original_media_type: detection.mediaType,
    original_sha256: sha256Bytes(bytes),
    source_origin: options.sourceOrigin ?? null,
    authorization_evidence_ref: options.authorizationEvidenceRef ?? null,
    archive,
  };

  const envelopes: RawEnvelope[] = detection.format === "deepseek_harness_session_jsonl"
    ? deepSeekHarnessEnvelopes(records, provenance, capturedAt)
    : records.map((record, sequence) => {
    const payload = importedRecord(record, provenance);
    return {
      envelope_version: "raw/0.1",
      adapter: "manual_import",
      adapter_version: IMPORTER_VERSION,
      interface_version: detection.format,
      captured_at: capturedAt,
      sequence,
      source_event_id: null,
      session_id: inferSessionId(record),
      turn_id: null,
      payload_sha256: sha256Bytes(canonicalJson(payload)),
      payload,
    };
    });

  const warnings = [
    ...(detection.format === "generic_html"
      || detection.format === "chatgpt_official_html"
      || detection.format === "gemini_takeout_activity_html"
      ? ["HTML was stored as untrusted raw text and was never rendered; its preview is not proof of DOM visibility."]
      : []),
    ...(detection.format === "gemini_takeout_activity_json" || detection.format === "gemini_takeout_activity_html"
      ? ["Google Takeout Gemini Apps data is an activity log; it may be flat, localized, incomplete, and insufficient to reconstruct full multi-turn conversations."]
      : []),
    ...(detection.format === "deepseek_harness_session_jsonl"
      ? ["The unpacked Harness artifact is user supplied: event fidelity is preserved, but provider/model authenticity is not verified by file shape."]
      : []),
  ];

  return { detection, provenance, envelopes, warnings };
}

export function importToRawEnvelopes(input: string | Uint8Array, options: ImportOptions = {}): ImportResult {
  return importInput(input, options, null);
}

/** Internal entry point for the ZIP reader. Not re-exported from the package. */
export function importArchiveEntryToRawEnvelopes(
  input: Uint8Array,
  options: ImportOptions,
  archive: ZipEntryProvenance,
): ImportResult {
  return importInput(input, options, archive);
}
