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

  const sourceProduct = detection.format === "chatgpt_official_json" || detection.format === "chatgpt_official_html"
    ? "chatgpt"
    : detection.format === "claude_official_json"
      ? "claude"
      : detection.format === "gemini_takeout_activity_json" || detection.format === "gemini_takeout_activity_html"
        ? "gemini"
      : detection.format === "deepseek_api_response"
        ? "deepseek_api"
        : "generic";
  const provenance: ImportProvenance = {
    schema_version: IMPORT_PROVENANCE_VERSION,
    importer_version: IMPORTER_VERSION,
    import_method: sourceProduct === "generic" || sourceProduct === "deepseek_api" ? "manual_import" : "official_export",
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

  const envelopes: RawEnvelope[] = records.map((record, sequence) => {
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
