import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { RawEnvelope } from "@trajpack/schema";
import { importToRawEnvelopes } from "./import.js";
import type { ImportFormat, ImportOptions } from "./types.js";
import { importOfficialZipArchive, isZipInput } from "./zip.js";

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export interface ImportFileResult {
  envelopes: RawEnvelope[];
  detectedFormat: ImportFormat;
  sourceMetadata: Record<string, unknown>;
}

export async function importFile(path: string, options: ImportOptions = {}): Promise<ImportFileResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("Import path must point to a regular file");
  if (metadata.size > maxBytes) throw new Error(`Import input exceeds the ${maxBytes}-byte limit`);

  const bytes = await readFile(path);
  const resolvedOptions = {
    ...options,
    filename: options.filename ?? basename(path),
    maxBytes,
  };
  const result = isZipInput(bytes, resolvedOptions.filename)
    ? importOfficialZipArchive(bytes, resolvedOptions)
    : importToRawEnvelopes(bytes, resolvedOptions);
  return {
    envelopes: result.envelopes,
    detectedFormat: result.detection.format,
    sourceMetadata: {
      detection: result.detection,
      provenance: result.provenance,
      warnings: result.warnings,
      ...("archive" in result ? { archive: result.archive } : {}),
    },
  };
}
