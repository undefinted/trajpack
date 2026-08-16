import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
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

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Vault parent must be a real directory, not a symlink or junction");
  }
  await chmod(path, 0o700).catch((error: NodeJS.ErrnoException) => {
    // Windows ACLs do not implement POSIX modes; creation still uses the
    // process owner and all vault files themselves are opened as 0600.
    if (process.platform !== "win32") throw error;
  });
}

async function readBoundedRegularFile(path: string): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Vault path must be a regular file");
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_VAULT_FILE_BYTES) {
      throw new Error(`Vault exceeds the ${MAX_VAULT_FILE_BYTES}-byte read limit`);
    }
    if ((before.dev !== opened.dev || before.ino !== opened.ino) && before.ino !== 0 && opened.ino !== 0) {
      throw new Error("Vault file changed while it was being opened");
    }
    const bytes = await handle.readFile();
    if (bytes.length !== opened.size || bytes.length > MAX_VAULT_FILE_BYTES) {
      throw new Error("Vault file changed while it was being read");
    }
    return bytes;
  } finally {
    await handle.close();
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

  private constructor(
    targetPath: string,
    temporaryPath: string,
    header: VaultHeader,
    private readonly handle: Awaited<ReturnType<typeof open>>,
    private readonly state: unknown,
    private readonly key: Uint8Array,
  ) {
    this.targetPath = targetPath;
    this.temporaryPath = temporaryPath;
    this.header = header;
  }

  static async create(targetPath: string, passphrase: string): Promise<VaultWriter> {
    await sodium.ready;
    if (passphrase.length < 12) throw new Error("Vault passphrase must contain at least 12 characters");
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
      await handle.write(Buffer.concat([MAGIC, uint32(encodedHeader.length), encodedHeader]));
      return new VaultWriter(targetPath, temporaryPath, header, handle, init.state, key);
    } catch (error) {
      if (key) sodium.memzero(key);
      await handle.close().catch(() => undefined);
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async append(record: VaultRecord): Promise<void> {
    const plaintext = Buffer.from(`${canonicalJson(record)}\n`, "utf8");
    if (plaintext.length > MAX_FRAME_BYTES - sodium.crypto_secretstream_xchacha20poly1305_ABYTES) {
      throw new Error("Vault record exceeds the maximum encrypted frame size");
    }
    const encrypted = sodium.crypto_secretstream_xchacha20poly1305_push(
      this.state as never,
      plaintext,
      null,
      sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
    );
    await this.handle.write(Buffer.concat([uint32(encrypted.length), Buffer.from(encrypted)]));
  }

  async finalize(): Promise<void> {
    try {
      const finalFrame = sodium.crypto_secretstream_xchacha20poly1305_push(
        this.state as never,
        new Uint8Array(),
        null,
        sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL,
      );
      await this.handle.write(Buffer.concat([uint32(finalFrame.length), Buffer.from(finalFrame)]));
      await this.handle.sync();
      await this.handle.close();
      await rename(this.temporaryPath, this.targetPath);
    } finally {
      sodium.memzero(this.key);
    }
  }

  async abort(): Promise<void> {
    sodium.memzero(this.key);
    await this.handle.close().catch(() => undefined);
    await rm(this.temporaryPath, { force: true });
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

export async function readBundle(path: string, passphrase: string): Promise<TraceBundle> {
  await sodium.ready;
  const bytes = await readBoundedRegularFile(path);
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Not a trajpack vault file");
  let offset = MAGIC.length;
  if (bytes.length < offset + 4) throw new Error("Truncated trajpack header");
  const headerLength = bytes.readUInt32BE(offset);
  offset += 4;
  if (headerLength <= 0 || headerLength > MAX_HEADER_BYTES || bytes.length < offset + headerLength) {
    throw new Error("Invalid trajpack header length");
  }
  const header = JSON.parse(bytes.subarray(offset, offset + headerLength).toString("utf8")) as VaultHeader;
  offset += headerLength;
  if (header.format !== "trajpack/1" || header.kdf.algorithm !== "argon2id13"
    || header.cipher.algorithm !== "xchacha20poly1305-secretstream") throw new Error("Unsupported trajpack format");
  if (!Number.isSafeInteger(header.kdf.opslimit) || !Number.isSafeInteger(header.kdf.memlimit)
    || header.kdf.opslimit < sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE
    || header.kdf.opslimit > sodium.crypto_pwhash_OPSLIMIT_MODERATE
    || header.kdf.memlimit < sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE
    || header.kdf.memlimit > sodium.crypto_pwhash_MEMLIMIT_MODERATE) {
    throw new Error("Vault KDF parameters are outside supported safety bounds");
  }
  const salt = sodium.from_base64(header.kdf.salt, sodium.base64_variants.ORIGINAL);
  if (salt.length !== sodium.crypto_pwhash_SALTBYTES) throw new Error("Invalid vault KDF salt");
  const key = await deriveKey(passphrase, salt, header.kdf.opslimit, header.kdf.memlimit);
  const streamHeader = sodium.from_base64(header.cipher.header, sodium.base64_variants.ORIGINAL);
  if (streamHeader.length !== sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES) throw new Error("Invalid vault stream header");
  const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(streamHeader, key);
  const records: VaultRecord[] = [];
  let sawFinal = false;
  try {
    while (offset < bytes.length) {
      if (bytes.length < offset + 4) throw new Error("Truncated encrypted frame length");
      const frameLength = bytes.readUInt32BE(offset);
      offset += 4;
      if (frameLength <= 0 || frameLength > MAX_FRAME_BYTES || bytes.length < offset + frameLength) {
        throw new Error("Invalid encrypted frame length");
      }
      const frame = bytes.subarray(offset, offset + frameLength);
      offset += frameLength;
      const pulled = sodium.crypto_secretstream_xchacha20poly1305_pull(state, frame, null);
      if (!pulled) throw new Error("Vault authentication failed");
      if (pulled.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL) {
        sawFinal = true;
        if (offset !== bytes.length) throw new Error("Unexpected data after final vault frame");
        break;
      }
      const line = Buffer.from(pulled.message).toString("utf8").trimEnd();
      records.push(JSON.parse(line) as VaultRecord);
    }
  } finally {
    sodium.memzero(key);
  }
  if (!sawFinal) throw new Error("Vault is missing its authenticated final frame");
  const manifests = records.filter((record): record is Extract<VaultRecord, { kind: "manifest" }> => record.kind === "manifest");
  const manifest = manifests.at(-1)?.value;
  if (!manifest) throw new Error("Vault contains no manifest");
  const bundle = assertTraceBundle({
    manifest,
    raw: records.filter((record): record is Extract<VaultRecord, { kind: "raw" }> => record.kind === "raw").map((record) => record.value),
    events: records.filter((record): record is Extract<VaultRecord, { kind: "event" }> => record.kind === "event").map((record) => record.value),
  });
  const rawReasons = rawIntegrityReasons(bundle);
  if (rawReasons.length > 0) throw new Error(`Vault raw integrity failed: ${rawReasons.join(", ")}`);
  return bundle;
}
