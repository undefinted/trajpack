import { crc32 } from "node:zlib";
import { basename, posix } from "node:path";
import { Unzip, UnzipInflate } from "fflate";
import { importArchiveEntryToRawEnvelopes } from "./import.js";
import { sha256Bytes } from "./hash.js";
import type {
  ImportFormat,
  ImportOptions,
  ImportResult,
  ZipArchiveMetadata,
  ZipEntryProvenance,
  ZipSelectedEntryMetadata,
} from "./types.js";

export const DEFAULT_MAX_ARCHIVE_ENTRIES = 4_096;
export const DEFAULT_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_ARCHIVE_ENTRY_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_ARCHIVE_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const ZIP64_EXTRA_FIELD = 0x0001;
const AES_EXTRA_FIELD = 0x9901;
const ENCRYPTION_FLAGS = 0x0001 | 0x0040;
const UTF8_FLAG = 0x0800;
const DATA_DESCRIPTOR_FLAG = 0x0008;
const ALLOWED_GENERAL_FLAGS = 0x0002 | 0x0004 | DATA_DESCRIPTOR_FLAG | UTF8_FLAG;
const MAX_FILENAME_BYTES = 4_096;
const ZIP_READER_CHUNK_BYTES = 16 * 1024;

interface ZipLimits {
  maxArchiveBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxUncompressedBytes: number;
}

interface InspectedEntry {
  name: string;
  compressedBytes: number;
  uncompressedBytes: number;
  crc32: number;
  compression: number;
  localOffset: number;
  dataOffset: number;
  dataEnd: number;
  directory: boolean;
}

interface InspectedArchive {
  entries: InspectedEntry[];
  uncompressedBytes: number;
}

export interface OfficialZipImportResult extends ImportResult {
  archive: ZipArchiveMetadata;
}

function readU16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) throw new Error("Invalid ZIP: truncated 16-bit field");
  return view.getUint16(offset, true);
}

function readU32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) throw new Error("Invalid ZIP: truncated 32-bit field");
  return view.getUint32(offset, true);
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function limitsFromOptions(options: ImportOptions): ZipLimits {
  return {
    maxArchiveBytes: positiveLimit(options.maxBytes ?? DEFAULT_MAX_ARCHIVE_BYTES, "maxBytes"),
    maxEntries: positiveLimit(options.maxArchiveEntries ?? DEFAULT_MAX_ARCHIVE_ENTRIES, "maxArchiveEntries"),
    maxEntryBytes: positiveLimit(options.maxArchiveEntryBytes ?? DEFAULT_MAX_ARCHIVE_ENTRY_BYTES, "maxArchiveEntryBytes"),
    maxUncompressedBytes: positiveLimit(
      options.maxArchiveUncompressedBytes ?? DEFAULT_MAX_ARCHIVE_UNCOMPRESSED_BYTES,
      "maxArchiveUncompressedBytes",
    ),
  };
}

function findEndOfCentralDirectory(bytes: Uint8Array, view: DataView): number {
  if (bytes.byteLength < 22) throw new Error("Invalid ZIP: end-of-central-directory record is missing");
  const minimum = Math.max(0, bytes.byteLength - 22 - 65_535);
  for (let offset = bytes.byteLength - 22; offset >= minimum; offset -= 1) {
    if (readU32(view, offset) !== END_OF_CENTRAL_DIRECTORY) continue;
    const commentBytes = readU16(view, offset + 20);
    if (offset + 22 + commentBytes === bytes.byteLength) return offset;
  }
  throw new Error("Invalid ZIP: end-of-central-directory record is missing or trailing data is present");
}

function decodeEntryName(bytes: Uint8Array, utf8: boolean): string {
  if (!utf8 && bytes.some((value) => value > 0x7f)) {
    throw new Error("Unsafe ZIP: non-ASCII legacy entry names are not supported");
  }
  try {
    return new TextDecoder(utf8 ? "utf-8" : "ascii", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Unsafe ZIP: entry name is not valid text");
  }
}

function validateEntryPath(name: string): { directory: boolean; collisionKey: string } {
  if (name.length === 0 || name.length > MAX_FILENAME_BYTES) throw new Error("Unsafe ZIP: invalid entry name length");
  if (/[\u0000-\u001f\u007f]/u.test(name)) throw new Error("Unsafe ZIP: control character in entry name");
  if (name.includes("\\") || name.startsWith("/") || /^[a-z]:/iu.test(name)) {
    throw new Error(`Unsafe ZIP entry path: ${name}`);
  }
  const directory = name.endsWith("/");
  const withoutTrailingSlash = directory ? name.slice(0, -1) : name;
  const segments = withoutTrailingSlash.split("/");
  if (segments.length === 0 || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Unsafe ZIP entry path: ${name}`);
  }
  return { directory, collisionKey: name.normalize("NFC").toLowerCase() };
}

function validateExtraFields(extra: Uint8Array): void {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let offset = 0;
  while (offset < extra.byteLength) {
    if (offset + 4 > extra.byteLength) throw new Error("Invalid ZIP: truncated extra field");
    const type = readU16(view, offset);
    const size = readU16(view, offset + 2);
    offset += 4;
    if (offset + size > extra.byteLength) throw new Error("Invalid ZIP: truncated extra field payload");
    if (type === ZIP64_EXTRA_FIELD) throw new Error("Unsupported ZIP: ZIP64 entries are not accepted by the bounded importer");
    if (type === AES_EXTRA_FIELD) throw new Error("Unsafe ZIP: encrypted entries are not accepted");
    offset += size;
  }
}

function validateFileType(versionMadeBy: number, externalAttributes: number, directory: boolean, name: string): void {
  const origin = versionMadeBy >>> 8;
  const unixLike = origin === 3 || origin === 19;
  const unixMode = (externalAttributes >>> 16) & 0xffff;
  const fileType = unixMode & 0xf000;
  if (unixLike && fileType !== 0 && fileType !== 0x8000 && fileType !== 0x4000) {
    throw new Error(`Unsafe ZIP: symlink or special-file entry is not accepted: ${name}`);
  }
  if (unixLike && ((directory && fileType === 0x8000) || (!directory && fileType === 0x4000))) {
    throw new Error(`Unsafe ZIP: entry type does not match its path: ${name}`);
  }
  const dosAttributes = externalAttributes & 0xff;
  if ((dosAttributes & 0x08) !== 0) throw new Error(`Unsafe ZIP: volume-label entry is not accepted: ${name}`);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function inspectZip(bytes: Uint8Array, limits: ZipLimits): InspectedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(bytes, view);
  const disk = readU16(view, endOffset + 4);
  const centralDisk = readU16(view, endOffset + 6);
  const diskEntries = readU16(view, endOffset + 8);
  const entryCount = readU16(view, endOffset + 10);
  const centralBytes = readU32(view, endOffset + 12);
  const centralOffset = readU32(view, endOffset + 16);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) {
    throw new Error("Unsupported ZIP: multi-disk archives are not accepted");
  }
  if (entryCount === 0xffff || centralBytes === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("Unsupported ZIP: ZIP64 archives are not accepted by the bounded importer");
  }
  if (entryCount > limits.maxEntries) throw new Error(`ZIP archive exceeds the ${limits.maxEntries}-entry limit`);
  if (centralOffset + centralBytes !== endOffset || centralOffset > bytes.byteLength) {
    throw new Error("Invalid ZIP: central directory bounds are inconsistent");
  }

  const entries: InspectedEntry[] = [];
  const collisionKeys = new Set<string>();
  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (readU32(view, cursor) !== CENTRAL_DIRECTORY_HEADER) throw new Error("Invalid ZIP: central directory entry is missing");
    const versionMadeBy = readU16(view, cursor + 4);
    const flags = readU16(view, cursor + 8);
    const compression = readU16(view, cursor + 10);
    const expectedCrc32 = readU32(view, cursor + 16);
    const compressedBytes = readU32(view, cursor + 20);
    const uncompressedBytes = readU32(view, cursor + 24);
    const nameBytesLength = readU16(view, cursor + 28);
    const extraBytesLength = readU16(view, cursor + 30);
    const commentBytesLength = readU16(view, cursor + 32);
    const startDisk = readU16(view, cursor + 34);
    const externalAttributes = readU32(view, cursor + 38);
    const localOffset = readU32(view, cursor + 42);
    const recordEnd = cursor + 46 + nameBytesLength + extraBytesLength + commentBytesLength;
    if (recordEnd > endOffset) throw new Error("Invalid ZIP: truncated central directory entry");
    if (nameBytesLength === 0 || nameBytesLength > MAX_FILENAME_BYTES) {
      throw new Error("Unsafe ZIP: invalid entry name length");
    }
    if ((flags & ENCRYPTION_FLAGS) !== 0) throw new Error("Unsafe ZIP: encrypted entries are not accepted");
    if ((flags & ~ALLOWED_GENERAL_FLAGS) !== 0) throw new Error(`Unsupported ZIP: unsafe general-purpose flags on ${nameBytesLength}-byte entry name`);
    if (compression !== 0 && compression !== 8) throw new Error(`Unsupported ZIP compression method: ${compression}`);
    if (compression === 0 && (flags & 0x0006) !== 0) throw new Error("Invalid ZIP: compression tuning flags are set on a stored entry");
    if (startDisk !== 0) throw new Error("Unsupported ZIP: multi-disk entry is not accepted");
    if (compressedBytes === 0xffffffff || uncompressedBytes === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error("Unsupported ZIP: ZIP64 entries are not accepted by the bounded importer");
    }
    if (uncompressedBytes > limits.maxEntryBytes) {
      throw new Error(`ZIP entry exceeds the ${limits.maxEntryBytes}-byte per-entry limit`);
    }
    totalUncompressed += uncompressedBytes;
    if (!Number.isSafeInteger(totalUncompressed) || totalUncompressed > limits.maxUncompressedBytes) {
      throw new Error(`ZIP archive exceeds the ${limits.maxUncompressedBytes}-byte uncompressed limit`);
    }

    const encodedName = bytes.subarray(cursor + 46, cursor + 46 + nameBytesLength);
    const name = decodeEntryName(encodedName, (flags & UTF8_FLAG) !== 0);
    const { directory, collisionKey } = validateEntryPath(name);
    if (collisionKeys.has(collisionKey)) throw new Error(`Unsafe ZIP: duplicate or confusable entry path: ${name}`);
    collisionKeys.add(collisionKey);
    validateFileType(versionMadeBy, externalAttributes, directory, name);
    const extra = bytes.subarray(cursor + 46 + nameBytesLength, cursor + 46 + nameBytesLength + extraBytesLength);
    validateExtraFields(extra);
    if (directory && (compressedBytes !== 0 || uncompressedBytes !== 0)) {
      throw new Error(`Invalid ZIP: directory entry contains data: ${name}`);
    }

    if (readU32(view, localOffset) !== LOCAL_FILE_HEADER) throw new Error("Invalid ZIP: local file header is missing");
    const localFlags = readU16(view, localOffset + 6);
    const localCompression = readU16(view, localOffset + 8);
    const localCrc32 = readU32(view, localOffset + 14);
    const localCompressedBytes = readU32(view, localOffset + 18);
    const localUncompressedBytes = readU32(view, localOffset + 22);
    const localNameBytesLength = readU16(view, localOffset + 26);
    const localExtraBytesLength = readU16(view, localOffset + 28);
    const localHeaderEnd = localOffset + 30 + localNameBytesLength + localExtraBytesLength;
    if (localHeaderEnd > centralOffset) throw new Error("Invalid ZIP: truncated local file header");
    if (localFlags !== flags || localCompression !== compression) {
      throw new Error(`Invalid ZIP: local and central metadata disagree for ${name}`);
    }
    if ((localFlags & ENCRYPTION_FLAGS) !== 0) throw new Error("Unsafe ZIP: encrypted entries are not accepted");
    const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameBytesLength);
    if (!sameBytes(encodedName, localName)) throw new Error(`Invalid ZIP: local entry name disagrees for ${name}`);
    const localExtra = bytes.subarray(localOffset + 30 + localNameBytesLength, localHeaderEnd);
    validateExtraFields(localExtra);
    if ((flags & DATA_DESCRIPTOR_FLAG) === 0 && (
      localCrc32 !== expectedCrc32 ||
      localCompressedBytes !== compressedBytes ||
      localUncompressedBytes !== uncompressedBytes
    )) {
      throw new Error(`Invalid ZIP: local sizes or checksum disagree for ${name}`);
    }
    let dataEnd = localHeaderEnd + compressedBytes;
    if (dataEnd > centralOffset) throw new Error(`Invalid ZIP: compressed data is out of bounds for ${name}`);
    if ((flags & DATA_DESCRIPTOR_FLAG) !== 0) {
      let descriptorOffset = dataEnd;
      if (readU32(view, descriptorOffset) === 0x08074b50) descriptorOffset += 4;
      if (
        readU32(view, descriptorOffset) !== expectedCrc32 ||
        readU32(view, descriptorOffset + 4) !== compressedBytes ||
        readU32(view, descriptorOffset + 8) !== uncompressedBytes
      ) {
        throw new Error(`Invalid ZIP: data descriptor disagrees for ${name}`);
      }
      dataEnd = descriptorOffset + 12;
      if (dataEnd > centralOffset) throw new Error(`Invalid ZIP: data descriptor is out of bounds for ${name}`);
    }
    entries.push({
      name,
      compressedBytes,
      uncompressedBytes,
      crc32: expectedCrc32,
      compression,
      localOffset,
      dataOffset: localHeaderEnd,
      dataEnd,
      directory,
    });
    cursor = recordEnd;
  }
  if (cursor !== endOffset) throw new Error("Invalid ZIP: central directory size is inconsistent");

  const orderedRanges = entries
    .map((entry) => ({ start: entry.localOffset, end: entry.dataEnd, name: entry.name }))
    .sort((left, right) => left.start - right.start);
  for (let index = 1; index < orderedRanges.length; index += 1) {
    const previous = orderedRanges[index - 1];
    const current = orderedRanges[index];
    if (previous !== undefined && current !== undefined && previous.end > current.start) {
      throw new Error(`Invalid ZIP: overlapping local entries ${previous.name} and ${current.name}`);
    }
  }
  return { entries, uncompressedBytes: totalUncompressed };
}

function candidateDepthAllowed(name: string): boolean {
  return name.split("/").length <= 2;
}

function entryBasename(name: string): string {
  return posix.basename(name);
}

function selectStructuredCandidates(entries: InspectedEntry[]): InspectedEntry[] {
  const files = entries.filter((entry) => !entry.directory && candidateDepthAllowed(entry.name));
  const main = files.filter((entry) => entryBasename(entry.name) === "conversations.json");
  const jsonl = files.filter((entry) => entryBasename(entry.name) === "conversations.jsonl");
  const shards = files
    .map((entry) => ({ entry, match: /^conversations-(\d{3,6})\.json$/u.exec(entryBasename(entry.name)) }))
    .filter((candidate): candidate is { entry: InspectedEntry; match: RegExpExecArray } => candidate.match !== null);
  if (main.length > 1 || jsonl.length > 1) throw new Error("Ambiguous ZIP: multiple official conversation entries were found");
  if (main.length > 0 && shards.length > 0) {
    throw new Error("Ambiguous ZIP: both conversations.json and numbered conversation shards were found");
  }
  if (jsonl.length > 0 && (main.length > 0 || shards.length > 0)) {
    throw new Error("Ambiguous ZIP: both JSON and JSONL conversation entries were found");
  }
  if (main.length === 1) return main;
  if (jsonl.length === 1) return jsonl;
  if (shards.length === 0) return [];

  const directories = new Set(shards.map(({ entry }) => posix.dirname(entry.name)));
  if (directories.size !== 1) throw new Error("Ambiguous ZIP: numbered conversation shards span multiple directories");
  const sorted = shards.sort((left, right) => Number(left.match[1]) - Number(right.match[1]));
  const firstIndex = Number(sorted[0]?.match[1]);
  if (firstIndex !== 0) throw new Error("Invalid ZIP: numbered conversation shards must start at 000");
  for (let index = 0; index < sorted.length; index += 1) {
    if (Number(sorted[index]?.match[1]) !== index) {
      throw new Error("Invalid ZIP: numbered conversation shards must be contiguous and unique");
    }
  }
  return sorted.map(({ entry }) => entry);
}

function selectHtmlCandidate(entries: InspectedEntry[]): InspectedEntry[] {
  const candidates = entries.filter(
    (entry) => !entry.directory && candidateDepthAllowed(entry.name) && entryBasename(entry.name) === "chat.html",
  );
  if (candidates.length > 1) throw new Error("Ambiguous ZIP: multiple chat.html entries were found");
  return candidates;
}

function extractSelected(bytes: Uint8Array, selected: InspectedEntry[]): Map<string, Uint8Array> {
  const selectedByName = new Map(selected.map((entry) => [entry.name, entry]));
  const result = new Map<string, Uint8Array>();
  try {
    const reader = new Unzip((file) => {
      const expected = selectedByName.get(file.name);
      if (expected === undefined) return;
      if (
        (file.size !== undefined && file.size !== expected.compressedBytes) ||
        (file.originalSize !== undefined && file.originalSize !== expected.uncompressedBytes) ||
        file.compression !== expected.compression
      ) {
        throw new Error(`Invalid ZIP: reader metadata disagrees for ${file.name}`);
      }
      let actualBytes = 0;
      const chunks: Uint8Array[] = [];
      file.ondata = (error, chunk, final) => {
        if (error) throw error;
        if (chunk) {
          actualBytes += chunk.byteLength;
          if (actualBytes > expected.uncompressedBytes) {
            throw new Error(`Invalid ZIP: actual decoded data exceeds its declared size for ${file.name}`);
          }
          chunks.push(chunk.slice());
        }
        if (!final) return;
        if (actualBytes !== expected.uncompressedBytes) {
          throw new Error(`Invalid ZIP: decoded size mismatch for ${file.name}`);
        }
        const value = new Uint8Array(actualBytes);
        let offset = 0;
        for (const part of chunks) {
          value.set(part, offset);
          offset += part.byteLength;
        }
        if ((crc32(value) >>> 0) !== expected.crc32) throw new Error(`Invalid ZIP: checksum mismatch for ${file.name}`);
        result.set(file.name, value);
      };
      file.start();
    });
    reader.register(UnzipInflate);
    for (let offset = 0; offset < bytes.byteLength; offset += ZIP_READER_CHUNK_BYTES) {
      const end = Math.min(bytes.byteLength, offset + ZIP_READER_CHUNK_BYTES);
      reader.push(bytes.subarray(offset, end), end === bytes.byteLength);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown ZIP reader failure";
    throw new Error(`Invalid ZIP: selected entry could not be decoded (${message})`);
  }
  for (const entry of selected) {
    const value = result.get(entry.name);
    if (value === undefined) throw new Error(`Invalid ZIP: selected entry was not decoded: ${entry.name}`);
  }
  return result;
}

function ensureOfficialFormat(format: ImportFormat): void {
  if (format !== "chatgpt_official_json" && format !== "chatgpt_official_html" && format !== "claude_official_json") {
    throw new Error("ZIP conversation entry does not match a supported official ChatGPT or Claude export shape");
  }
}

export function hasZipSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  const signature = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  return signature === LOCAL_FILE_HEADER || signature === END_OF_CENTRAL_DIRECTORY || signature === 0x08074b50;
}

export function importOfficialZipArchive(input: Uint8Array, options: ImportOptions = {}): OfficialZipImportResult {
  const limits = limitsFromOptions(options);
  if (input.byteLength > limits.maxArchiveBytes) {
    throw new Error(`ZIP archive exceeds the ${limits.maxArchiveBytes}-byte compressed input limit`);
  }
  const inspected = inspectZip(input, limits);
  const archiveSha256 = sha256Bytes(input);
  let selected = selectStructuredCandidates(inspected.entries);
  let ignoredHtmlViewer = false;
  if (selected.length === 0) {
    selected = selectHtmlCandidate(inspected.entries);
  } else {
    ignoredHtmlViewer = selectHtmlCandidate(inspected.entries).length === 1;
  }
  if (selected.length === 0) {
    throw new Error("Unsupported ZIP: no unambiguous official conversations.json, numbered shard, conversations.jsonl, or chat.html entry was found");
  }

  const extracted = extractSelected(input, selected);
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  const importedResults = selected.map((entry, selectedIndex) => {
    const entryBytes = extracted.get(entry.name);
    if (entryBytes === undefined) throw new Error(`Invalid ZIP: missing selected entry ${entry.name}`);
    const provenance: ZipEntryProvenance = {
      container_format: "zip",
      archive_filename: options.filename ?? null,
      archive_sha256: archiveSha256,
      archive_entry_count: inspected.entries.length,
      selected_entry_name: entry.name,
      selected_entry_sha256: sha256Bytes(entryBytes),
      selected_entry_uncompressed_bytes: entry.uncompressedBytes,
      selected_entry_index: selectedIndex,
      selected_entry_count: selected.length,
    };
    const result = importArchiveEntryToRawEnvelopes(entryBytes, {
      ...options,
      filename: entryBasename(entry.name),
      capturedAt,
      maxBytes: limits.maxEntryBytes,
    }, provenance);
    ensureOfficialFormat(result.detection.format);
    return { entry, result };
  });

  const detectedFormats = new Set(importedResults.map(({ result }) => result.detection.format));
  if (detectedFormats.size !== 1) throw new Error("Ambiguous ZIP: selected entries describe different source products or formats");
  const detectedFormat = importedResults[0]?.result.detection.format;
  if (detectedFormat === undefined) throw new Error("Unsupported ZIP: no selected conversation data");
  if (selected.length > 1 && detectedFormat !== "chatgpt_official_json") {
    throw new Error("Unsupported ZIP: numbered multi-file exports are accepted only for validated ChatGPT conversation shards");
  }

  let sequence = 0;
  const envelopes = importedResults.flatMap(({ result }) => result.envelopes.map((envelope) => ({
    ...envelope,
    sequence: sequence++,
  })));
  const selectedEntries: ZipSelectedEntryMetadata[] = importedResults.map(({ entry, result }) => ({
    name: entry.name,
    sha256: result.provenance.original_sha256,
    compressed_bytes: entry.compressedBytes,
    uncompressed_bytes: entry.uncompressedBytes,
    detected_format: result.detection.format,
  }));
  const archive: ZipArchiveMetadata = {
    container_format: "zip",
    archive_filename: options.filename ?? null,
    archive_sha256: archiveSha256,
    archive_bytes: input.byteLength,
    archive_entry_count: inspected.entries.length,
    archive_uncompressed_bytes: inspected.uncompressedBytes,
    selected_entries: selectedEntries,
  };
  const first = importedResults[0]?.result;
  if (first === undefined) throw new Error("Unsupported ZIP: no selected conversation data");
  const warnings = [
    ...importedResults.flatMap(({ result }) => result.warnings),
    ...(ignoredHtmlViewer
      ? ["The archive's chat.html viewer was ignored because validated structured conversation JSON was available."]
      : []),
  ];
  return {
    detection: {
      ...first.detection,
      basis: `bounded ZIP import; ${selected.length} selected entry or shard(s); ${first.detection.basis}`,
    },
    provenance: first.provenance,
    envelopes,
    warnings,
    archive,
  };
}

export function isZipInput(bytes: Uint8Array, filename: string | undefined): boolean {
  return hasZipSignature(bytes) || (filename !== undefined && basename(filename).toLowerCase().endsWith(".zip"));
}
