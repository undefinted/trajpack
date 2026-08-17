import type { RawEnvelope } from "@trajpack/schema";

export const IMPORTER_VERSION = "0.1.0" as const;
export const IMPORT_PROVENANCE_VERSION = "import-provenance/0.1" as const;

export type ImportFormat =
  | "chatgpt_official_json"
  | "chatgpt_official_html"
  | "claude_official_json"
  | "gemini_takeout_activity_json"
  | "gemini_takeout_activity_html"
  | "deepseek_api_response"
  | "generic_json"
  | "generic_jsonl"
  | "generic_html";

export type ImportSourceHint = "chatgpt" | "claude" | "gemini" | "deepseek-api" | "generic";

export interface ImportOptions {
  filename?: string;
  capturedAt?: string;
  sourceHint?: ImportSourceHint;
  sourceOrigin?: string;
  authorizationEvidenceRef?: string;
  maxBytes?: number;
  maxArchiveEntries?: number;
  maxArchiveEntryBytes?: number;
  maxArchiveUncompressedBytes?: number;
}

export interface ImportDetection {
  format: ImportFormat;
  mediaType: "application/json" | "application/x-ndjson" | "text/html";
  basis: string;
}

export interface ImportProvenance {
  schema_version: typeof IMPORT_PROVENANCE_VERSION;
  importer_version: typeof IMPORTER_VERSION;
  import_method: "official_export" | "manual_import";
  source_product: "chatgpt" | "claude" | "gemini" | "deepseek_api" | "generic";
  source_authenticity: "unverified_user_supplied";
  fidelity: "B" | "C";
  detected_format: ImportFormat;
  detection_basis: string;
  original_filename: string | null;
  original_media_type: ImportDetection["mediaType"];
  original_sha256: string;
  source_origin: string | null;
  authorization_evidence_ref: string | null;
  archive: ZipEntryProvenance | null;
}

export interface ZipEntryProvenance {
  container_format: "zip";
  archive_filename: string | null;
  archive_sha256: string;
  archive_entry_count: number;
  selected_entry_name: string;
  selected_entry_sha256: string;
  selected_entry_uncompressed_bytes: number;
  selected_entry_index: number;
  selected_entry_count: number;
}

export interface ZipSelectedEntryMetadata {
  name: string;
  sha256: string;
  compressed_bytes: number;
  uncompressed_bytes: number;
  detected_format: ImportFormat;
}

export interface ZipArchiveMetadata {
  container_format: "zip";
  archive_filename: string | null;
  archive_sha256: string;
  archive_bytes: number;
  archive_entry_count: number;
  archive_uncompressed_bytes: number;
  selected_entries: ZipSelectedEntryMetadata[];
}

export interface ImportedPayload {
  record_kind: "imported_record";
  provenance: ImportProvenance;
  record: unknown;
}

export interface ImportResult {
  detection: ImportDetection;
  provenance: ImportProvenance;
  envelopes: RawEnvelope[];
  warnings: string[];
}
