import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, parse, sep } from "node:path";
import type sodiumTypes from "libsodium-wrappers-sumo";
import type { RawEnvelope, TraceBundle, TraceManifest, TrajectoryEvent } from "@trajpack/schema";
import { assertTraceBundle } from "@trajpack/schema";
import { canonicalJson } from "./canonical.js";
import { rawIntegrityReasons } from "./integrity.js";

const MAGIC = Buffer.from("TRJPACK1\0", "ascii");
const sodium = createRequire(import.meta.url)("libsodium-wrappers-sumo") as typeof sodiumTypes;
const MAX_HEADER_BYTES = 64 * 1024;
// One provider event is one authenticated secretstream frame. This bound fits
// the 64 MiB opaque Claude artifact after Base64 expansion while still
// rejecting unbounded or malformed frame lengths during reads.
const MAX_FRAME_BYTES = 96 * 1024 * 1024;
// Vaults are intentionally bounded before any whole-file allocation. A
// single opaque transcript is capped at 64 MiB; this leaves ample room for
// normalized events while preventing an attacker-controlled import from
// forcing an unbounded read into the reviewer process.
export const MAX_VAULT_FILE_BYTES = 512 * 1024 * 1024;
// Writers reserve one byte below the reader's inclusive bound. Every append
// also reserves the authenticated final frame, so a successfully published
// vault is guaranteed to remain readable by this implementation.
export const MAX_VAULT_WRITE_BYTES = MAX_VAULT_FILE_BYTES - 1;
export const MAX_VAULT_RECORDS = 1_000_000;
export const MAX_VAULT_JSON_DEPTH = 64;
export const MAX_VAULT_JSON_NODES = 1_000_000;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function finalFrameBytes(): number {
  return 4 + sodium.crypto_secretstream_xchacha20poly1305_ABYTES;
}

export class VaultSizeLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Vault would exceed the ${limit}-byte write limit`);
    this.name = "VaultSizeLimitError";
  }
}

export interface VaultWriterOptions {
  /** Primarily useful for constrained callers and boundary tests. */
  maxFileBytes?: number;
  /**
   * Coalesce encrypted frames before issuing a filesystem write. The buffer
   * contains ciphertext only and is bounded independently of provider input.
   */
  flushBytes?: number;
}

const DEFAULT_VAULT_FLUSH_BYTES = 1024 * 1024;
const MAX_VAULT_FLUSH_BYTES = 8 * 1024 * 1024;

export interface VaultReaderOptions {
  /** Limits may only tighten, never raise, the format safety bounds. */
  maxRecords?: number;
  maxJsonDepth?: number;
  maxJsonNodes?: number;
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, null);
    if (result.bytesWritten <= 0) throw new Error("Vault write made no progress");
    offset += result.bytesWritten;
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await assertRealDirectoryPath(path, "Vault parent");
  await chmod(path, 0o700).catch((error: NodeJS.ErrnoException) => {
    // Windows ACLs do not implement POSIX modes; creation still uses the
    // process owner and all vault files themselves are opened as 0600.
    if (process.platform !== "win32") throw error;
  });
}

/**
 * Reject not only a symlink at the final component but any symlink/junction
 * ancestor. `mkdir(recursive)` and `lstat` both follow intermediate symlinks,
 * so without this walk a redirected parent would silently relocate the whole
 * encrypted store to an attacker-controlled location.
 *
 * macOS ships a small set of root-level platform symlinks (/tmp -> /private/tmp,
 * /var -> /private/var, /etc -> /private/etc) that legitimately appear above
 * `tmpdir()`; those are tolerated, while any caller-controlled link below them
 * is still rejected.
 */
const SYSTEM_ALIAS_ROOTS = new Set(process.platform === "win32" ? [] : ["/tmp", "/var", "/etc"]);

async function assertRealDirectoryPath(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory, not a symlink or junction`);
  }
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const component = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (component?.isSymbolicLink() && !SYSTEM_ALIAS_ROOTS.has(current)) {
      throw new Error(`${label} contains a symbolic-link or junction ancestor: ${current}`);
    }
  }
}

async function syncParentDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Node does not provide a portable directory handle that can be flushed on
    // Windows. The encrypted file itself is still fsynced before rename.
    if (process.platform === "win32" && ["EACCES", "EBADF", "EISDIR", "EINVAL", "ENOSYS", "EPERM", "UNKNOWN"].includes(code ?? "")) {
      return;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

class BoundedVaultReader {
  private offset = 0;

  private constructor(
    private readonly handle: Awaited<ReturnType<typeof open>>,
    private readonly size: number,
    private readonly dev: number,
    private readonly ino: number,
  ) {}

  static async create(path: string): Promise<BoundedVaultReader> {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error("Vault path must be a regular file");
    const handle = await open(path, "r");
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || !Number.isSafeInteger(opened.size) || opened.size < 0
        || opened.size > MAX_VAULT_FILE_BYTES) {
        throw new Error(`Vault exceeds the ${MAX_VAULT_FILE_BYTES}-byte read limit`);
      }
      if ((before.dev !== opened.dev || before.ino !== opened.ino) && before.ino !== 0 && opened.ino !== 0) {
        throw new Error("Vault file changed while it was being opened");
      }
      return new BoundedVaultReader(handle, opened.size, opened.dev, opened.ino);
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }

  get remaining(): number {
    return this.size - this.offset;
  }

  async readExact(length: number, truncatedMessage: string): Promise<Buffer> {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) {
      throw new Error(truncatedMessage);
    }
    const output = Buffer.allocUnsafe(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = await this.handle.read(output, filled, length - filled, this.offset + filled);
      if (bytesRead <= 0) throw new Error(truncatedMessage);
      filled += bytesRead;
    }
    this.offset += length;
    return output;
  }

  async verifyUnchanged(): Promise<void> {
    if (this.offset !== this.size) throw new Error("Vault contains unread trailing data");
    const after = await this.handle.stat();
    if (!after.isFile() || after.size !== this.size
      || ((after.dev !== this.dev || after.ino !== this.ino) && this.ino !== 0 && after.ino !== 0)) {
      throw new Error("Vault file changed while it was being read");
    }
  }

  async close(): Promise<void> {
    await this.handle.close();
  }
}

function boundedReaderLimit(value: number | undefined, hardLimit: number, label: string): number {
  if (value === undefined) return hardLimit;
  if (!Number.isSafeInteger(value) || value < 1 || value > hardLimit) {
    throw new Error(`${label} must be from 1 to ${hardLimit}`);
  }
  return value;
}

function assertJsonStructure(text: string, maxDepth: number, maxNodes: number, label: string): void {
  let depth = 0;
  let nodes = 1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }
    if (character === "\"") {
      inString = true;
      nodes += 1;
    } else if (character === "{" || character === "[") {
      depth += 1;
      nodes += 1;
      if (depth > maxDepth) throw new Error(`${label} exceeds the JSON nesting depth limit`);
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0) throw new Error(`${label} has invalid JSON structure`);
    } else if (character === ",") {
      nodes += 1;
    }
    if (nodes > maxNodes) throw new Error(`${label} exceeds the JSON node limit`);
  }
  if (inString || depth !== 0) throw new Error(`${label} has invalid JSON structure`);
}

function decodeJson(
  bytes: Uint8Array,
  maxDepth: number,
  maxNodes: number,
  label: string,
): unknown {
  let text: string;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  assertJsonStructure(text, maxDepth, maxNodes, label);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

export type VaultRecord =
  | { kind: "manifest"; value: TraceManifest }
  | { kind: "raw"; value: RawEnvelope }
  | { kind: "event"; value: TrajectoryEvent };

export interface VaultHeader {
  format: "trajpack/1";
  kdf: {
    algorithm: "argon2id13";
    salt: string;
    opslimit: number;
    memlimit: number;
  };
  cipher: {
    algorithm: "xchacha20poly1305-secretstream";
    header: string;
  };
  created_at: string;
}

function uint32(value: number): Buffer {
  const output = Buffer.allocUnsafe(4);
  output.writeUInt32BE(value, 0);
  return output;
}

async function deriveKey(passphrase: string, salt: Uint8Array, opslimit: number, memlimit: number): Promise<Uint8Array> {
  if (passphrase.length < 12) throw new Error("Vault passphrase must contain at least 12 characters");
  await sodium.ready;
  return sodium.crypto_pwhash(
    sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES,
    passphrase,
    salt,
    opslimit,
    memlimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  );
}

export class VaultWriter {
  readonly targetPath: string;
  readonly temporaryPath: string;
  readonly header: VaultHeader;
  private recordsWritten = 0;
  private bufferedFrames: Buffer[] = [];
  private bufferedBytes = 0;
  private operationQueue: Promise<void> = Promise.resolve();
  private operationFailure: unknown = null;
  private closing = false;

  private constructor(
    targetPath: string,
    temporaryPath: string,
    header: VaultHeader,
    private readonly handle: Awaited<ReturnType<typeof open>>,
    private readonly state: unknown,
    private readonly key: Uint8Array,
    private readonly maxFileBytes: number,
    private readonly flushBytes: number,
    private bytesWritten: number,
  ) {
    this.targetPath = targetPath;
    this.temporaryPath = temporaryPath;
    this.header = header;
  }

  static async create(
    targetPath: string,
    passphrase: string,
    options: VaultWriterOptions = {},
  ): Promise<VaultWriter> {
    await sodium.ready;
    if (passphrase.length < 12) throw new Error("Vault passphrase must contain at least 12 characters");
    const maxFileBytes = options.maxFileBytes ?? MAX_VAULT_WRITE_BYTES;
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > MAX_VAULT_WRITE_BYTES) {
      throw new Error(`Vault writer maxFileBytes must be from 1 to ${MAX_VAULT_WRITE_BYTES}`);
    }
    const flushBytes = options.flushBytes ?? DEFAULT_VAULT_FLUSH_BYTES;
    if (!Number.isSafeInteger(flushBytes) || flushBytes < 1 || flushBytes > MAX_VAULT_FLUSH_BYTES) {
      throw new Error(`Vault writer flushBytes must be from 1 to ${MAX_VAULT_FLUSH_BYTES}`);
    }
    await ensurePrivateDirectory(dirname(targetPath));
    const temporaryPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    let key: Uint8Array | undefined;
    try {
      const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
      const opslimit = sodium.crypto_pwhash_OPSLIMIT_MODERATE;
      const memlimit = sodium.crypto_pwhash_MEMLIMIT_MODERATE;
      key = await deriveKey(passphrase, salt, opslimit, memlimit);
      const init = sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
      const header: VaultHeader = {
        format: "trajpack/1",
        kdf: {
          algorithm: "argon2id13",
          salt: sodium.to_base64(salt, sodium.base64_variants.ORIGINAL),
          opslimit,
          memlimit,
        },
        cipher: {
          algorithm: "xchacha20poly1305-secretstream",
          header: sodium.to_base64(init.header, sodium.base64_variants.ORIGINAL),
        },
        created_at: new Date().toISOString(),
      };
      const encodedHeader = Buffer.from(canonicalJson(header), "utf8");
      const preamble = Buffer.concat([MAGIC, uint32(encodedHeader.length), encodedHeader]);
      if (preamble.length + finalFrameBytes() > maxFileBytes) throw new VaultSizeLimitError(maxFileBytes);
      await writeAll(handle, preamble);
      return new VaultWriter(
        targetPath,
        temporaryPath,
        header,
        handle,
        init.state,
        key,
        maxFileBytes,
        flushBytes,
        preamble.length,
      );
    } catch (error) {
      if (key) sodium.memzero(key);
      await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operationQueue.then(async () => {
      if (this.operationFailure !== null) throw this.operationFailure;
      await operation();
    });
    this.operationQueue = result.catch((error: unknown) => {
      if (this.operationFailure === null) this.operationFailure = error;
    });
    return result;
  }

  private async flushBufferedFrames(): Promise<void> {
    if (this.bufferedBytes === 0) return;
    const frames = this.bufferedFrames;
    const bytes = this.bufferedBytes;
    this.bufferedFrames = [];
    this.bufferedBytes = 0;
    await writeAll(this.handle, frames.length === 1 ? frames[0]! : Buffer.concat(frames, bytes));
    this.bytesWritten += bytes;
  }

  private async appendExclusive(record: VaultRecord): Promise<void> {
    if (this.recordsWritten >= MAX_VAULT_RECORDS) throw new Error("Vault exceeds the record count limit");
    const encoded = `${canonicalJson(record)}\n`;
    assertJsonStructure(encoded, MAX_VAULT_JSON_DEPTH, MAX_VAULT_JSON_NODES, "Vault record");
    const plaintext = Buffer.from(encoded, "utf8");
    if (plaintext.length > MAX_FRAME_BYTES - sodium.crypto_secretstream_xchacha20poly1305_ABYTES) {
      throw new Error("Vault record exceeds the maximum encrypted frame size");
    }
    const encrypted = sodium.crypto_secretstream_xchacha20poly1305_push(
      this.state as never,
      plaintext,
      null,
      sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
    );
    const frame = Buffer.concat([uint32(encrypted.length), Buffer.from(encrypted)]);
    if (this.bytesWritten + this.bufferedBytes + frame.length + finalFrameBytes() > this.maxFileBytes) {
      throw new VaultSizeLimitError(this.maxFileBytes);
    }
    // A large provider frame is still accepted up to the independent frame
    // bound, but it is never retained alongside an already-full batch.
    if (this.bufferedBytes > 0 && this.bufferedBytes + frame.length > this.flushBytes) {
      await this.flushBufferedFrames();
    }
    this.bufferedFrames.push(frame);
    this.bufferedBytes += frame.length;
    this.recordsWritten += 1;
    if (this.bufferedBytes >= this.flushBytes) await this.flushBufferedFrames();
  }

  async append(record: VaultRecord): Promise<void> {
    if (this.closing) throw new Error("Vault writer is closing");
    return this.enqueue(() => this.appendExclusive(record));
  }

  async finalize(): Promise<void> {
    if (this.closing) throw new Error("Vault writer is closing");
    this.closing = true;
    try {
      await this.operationQueue;
      if (this.operationFailure !== null) throw this.operationFailure;
      await this.flushBufferedFrames();
      const finalFrame = sodium.crypto_secretstream_xchacha20poly1305_push(
        this.state as never,
        new Uint8Array(),
        null,
        sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL,
      );
      const encodedFinalFrame = Buffer.concat([uint32(finalFrame.length), Buffer.from(finalFrame)]);
      if (this.bytesWritten + encodedFinalFrame.length > this.maxFileBytes) {
        throw new VaultSizeLimitError(this.maxFileBytes);
      }
      await writeAll(this.handle, encodedFinalFrame);
      this.bytesWritten += encodedFinalFrame.length;
      await this.handle.sync();
      const metadata = await this.handle.stat();
      if (metadata.size !== this.bytesWritten || metadata.size > this.maxFileBytes) {
        throw new VaultSizeLimitError(this.maxFileBytes);
      }
      await this.handle.close();
      await rename(this.temporaryPath, this.targetPath);
      await syncParentDirectory(dirname(this.targetPath));
    } finally {
      sodium.memzero(this.key);
    }
  }

  async abort(): Promise<void> {
    this.closing = true;
    await this.operationQueue.catch(() => undefined);
    this.bufferedFrames = [];
    this.bufferedBytes = 0;
    sodium.memzero(this.key);
    await this.handle.close().catch(() => undefined);
    await rm(this.temporaryPath, { force: true });
    await syncParentDirectory(dirname(this.temporaryPath));
  }
}

export async function writeBundle(targetPath: string, passphrase: string, bundle: TraceBundle): Promise<void> {
  const writer = await VaultWriter.create(targetPath, passphrase);
  try {
    await writer.append({ kind: "manifest", value: bundle.manifest });
    for (const envelope of bundle.raw) await writer.append({ kind: "raw", value: envelope });
    for (const event of bundle.events) await writer.append({ kind: "event", value: event });
    await writer.finalize();
  } catch (error) {
    await writer.abort();
    throw error;
  }
}

export async function readBundle(
  path: string,
  passphrase: string,
  options: VaultReaderOptions = {},
): Promise<TraceBundle> {
  await sodium.ready;
  const maxRecords = boundedReaderLimit(options.maxRecords, MAX_VAULT_RECORDS, "Vault maxRecords");
  const maxJsonDepth = boundedReaderLimit(options.maxJsonDepth, MAX_VAULT_JSON_DEPTH, "Vault maxJsonDepth");
  const maxJsonNodes = boundedReaderLimit(options.maxJsonNodes, MAX_VAULT_JSON_NODES, "Vault maxJsonNodes");
  const reader = await BoundedVaultReader.create(path);
  let key: Uint8Array | undefined;
  let manifest: TraceManifest | undefined;
  const raw: RawEnvelope[] = [];
  const events: TrajectoryEvent[] = [];
  let recordCount = 0;
  let sawFinal = false;
  try {
    const magic = await reader.readExact(MAGIC.length, "Truncated trajpack magic");
    if (!magic.equals(MAGIC)) throw new Error("Not a trajpack vault file");
    const encodedHeaderLength = await reader.readExact(4, "Truncated trajpack header length");
    const headerLength = encodedHeaderLength.readUInt32BE(0);
    if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES) throw new Error("Invalid trajpack header length");
    const encodedHeader = await reader.readExact(headerLength, "Truncated trajpack header");
    const parsedHeader = decodeJson(
      encodedHeader,
      MAX_VAULT_JSON_DEPTH,
      MAX_VAULT_JSON_NODES,
      "Vault header",
    );
    if (typeof parsedHeader !== "object" || parsedHeader === null || Array.isArray(parsedHeader)) {
      throw new Error("Unsupported trajpack format");
    }
    const headerRecord = parsedHeader as Record<string, unknown>;
    const kdf = headerRecord.kdf;
    const cipher = headerRecord.cipher;
    if (headerRecord.format !== "trajpack/1"
      || typeof headerRecord.created_at !== "string"
      || typeof kdf !== "object" || kdf === null || Array.isArray(kdf)
      || typeof cipher !== "object" || cipher === null || Array.isArray(cipher)) {
      throw new Error("Unsupported trajpack format");
    }
    const kdfRecord = kdf as Record<string, unknown>;
    const cipherRecord = cipher as Record<string, unknown>;
    if (kdfRecord.algorithm !== "argon2id13"
      || cipherRecord.algorithm !== "xchacha20poly1305-secretstream"
      || typeof kdfRecord.salt !== "string"
      || typeof kdfRecord.opslimit !== "number"
      || typeof kdfRecord.memlimit !== "number"
      || typeof cipherRecord.header !== "string") {
      throw new Error("Unsupported trajpack format");
    }
    const header = parsedHeader as VaultHeader;
    if (!Number.isSafeInteger(header.kdf.opslimit) || !Number.isSafeInteger(header.kdf.memlimit)
      || header.kdf.opslimit < sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE
      || header.kdf.opslimit > sodium.crypto_pwhash_OPSLIMIT_MODERATE
      || header.kdf.memlimit < sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE
      || header.kdf.memlimit > sodium.crypto_pwhash_MEMLIMIT_MODERATE) {
      throw new Error("Vault KDF parameters are outside supported safety bounds");
    }
    let salt: Uint8Array;
    let streamHeader: Uint8Array;
    try {
      salt = sodium.from_base64(header.kdf.salt, sodium.base64_variants.ORIGINAL);
      streamHeader = sodium.from_base64(header.cipher.header, sodium.base64_variants.ORIGINAL);
    } catch {
      throw new Error("Invalid vault header encoding");
    }
    if (salt.length !== sodium.crypto_pwhash_SALTBYTES) throw new Error("Invalid vault KDF salt");
    if (streamHeader.length !== sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES) {
      throw new Error("Invalid vault stream header");
    }
    key = await deriveKey(passphrase, salt, header.kdf.opslimit, header.kdf.memlimit);
    const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(streamHeader, key);

    while (reader.remaining > 0) {
      const encodedFrameLength = await reader.readExact(4, "Truncated encrypted frame length");
      const frameLength = encodedFrameLength.readUInt32BE(0);
      if (frameLength <= 0 || frameLength > MAX_FRAME_BYTES) throw new Error("Invalid encrypted frame length");
      const frame = await reader.readExact(frameLength, "Truncated encrypted frame");
      const pulled = sodium.crypto_secretstream_xchacha20poly1305_pull(state, frame, null);
      if (!pulled) throw new Error("Vault authentication failed");
      if (pulled.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL) {
        if (pulled.message.length !== 0) throw new Error("Vault final frame must be empty");
        sawFinal = true;
        if (reader.remaining !== 0) throw new Error("Unexpected data after final vault frame");
        break;
      }
      if (pulled.tag !== sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE) {
        throw new Error("Unsupported vault frame tag");
      }
      recordCount += 1;
      if (recordCount > maxRecords) throw new Error("Vault exceeds the record count limit");
      const parsedRecord = decodeJson(pulled.message, maxJsonDepth, maxJsonNodes, "Vault record");
      if (typeof parsedRecord !== "object" || parsedRecord === null || Array.isArray(parsedRecord)) {
        throw new Error("Invalid vault record");
      }
      const record = parsedRecord as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, "value")) throw new Error("Invalid vault record");
      if (record.kind === "manifest") {
        manifest = record.value as TraceManifest;
      } else if (record.kind === "raw") {
        raw.push(record.value as RawEnvelope);
      } else if (record.kind === "event") {
        events.push(record.value as TrajectoryEvent);
      } else {
        throw new Error("Invalid vault record kind");
      }
    }
    if (!sawFinal) throw new Error("Vault is missing its authenticated final frame");
    await reader.verifyUnchanged();
  } finally {
    if (key) sodium.memzero(key);
    await reader.close();
  }
  if (!manifest) throw new Error("Vault contains no manifest");
  const bundle = assertTraceBundle({ manifest, raw, events });
  const rawReasons = rawIntegrityReasons(bundle);
  if (rawReasons.length > 0) throw new Error(`Vault raw integrity failed: ${rawReasons.join(", ")}`);
  return bundle;
}
