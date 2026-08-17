import { appendFile, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_VAULT_FILE_BYTES,
  MAX_VAULT_JSON_DEPTH,
  MAX_VAULT_JSON_NODES,
  MAX_VAULT_RECORDS,
  MAX_VAULT_WRITE_BYTES,
  VaultSizeLimitError,
  VaultWriter,
  writeBundle,
  readBundle,
} from "./vault.js";
import { fixtureBundle } from "./testing.js";

describe("encrypted vault", () => {
  it("round-trips without plaintext at rest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trajpack-vault-"));
    const path = join(directory, "trace.trajpack");
    const bundle = fixtureBundle("a secret prompt that must not leak");
    try {
      await writeBundle(path, "correct horse battery staple", bundle);
      const bytes = await readFile(path);
      expect(bytes.includes(Buffer.from("a secret prompt that must not leak"))).toBe(false);
      expect(await readBundle(path, "correct horse battery staple")).toEqual(bundle);
      await expect(readBundle(path, "this passphrase is incorrect")).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects oversized files before allocating or decrypting them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trajpack-vault-limit-"));
    const path = join(directory, "oversized.trajpack");
    try {
      await writeFile(path, "TRJPACK1\0");
      await truncate(path, MAX_VAULT_FILE_BYTES + 1);
      await expect(readBundle(path, "correct horse battery staple")).rejects.toThrow(/read limit/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reserves the final frame, never publishes an oversized vault, and produces a reopenable bounded vault", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trajpack-vault-writer-limit-"));
    const rejectedPath = join(directory, "rejected.trajpack");
    const acceptedPath = join(directory, "accepted.trajpack");
    const passphrase = "correct horse battery staple";
    const bundle = fixtureBundle("bounded writer sentinel");
    try {
      const constrained = await VaultWriter.create(rejectedPath, passphrase, { maxFileBytes: 1024 });
      await expect(constrained.append({ kind: "manifest", value: bundle.manifest }))
        .rejects.toBeInstanceOf(VaultSizeLimitError);
      await constrained.abort();
      await expect(stat(rejectedPath)).rejects.toMatchObject({ code: "ENOENT" });

      const writer = await VaultWriter.create(acceptedPath, passphrase, { maxFileBytes: 64 * 1024 });
      await writer.append({ kind: "manifest", value: bundle.manifest });
      for (const envelope of bundle.raw) await writer.append({ kind: "raw", value: envelope });
      for (const event of bundle.events) await writer.append({ kind: "event", value: event });
      await writer.finalize();
      expect((await stat(acceptedPath)).size).toBeLessThanOrEqual(64 * 1024);
      expect((await stat(acceptedPath)).size).toBeLessThan(MAX_VAULT_FILE_BYTES);
      expect((await readBundle(acceptedPath, passphrase))).toEqual(bundle);
      expect(MAX_VAULT_WRITE_BYTES).toBe(MAX_VAULT_FILE_BYTES - 1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("streams frames with strict record, JSON depth, and JSON node limits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trajpack-vault-reader-limits-"));
    const path = join(directory, "bounded.trajpack");
    const passphrase = "correct horse battery staple";
    const bundle = fixtureBundle("reader boundary sentinel");
    try {
      await writeBundle(path, passphrase, bundle);
      // fixtureBundle is encoded as exactly one manifest and one event record.
      expect(await readBundle(path, passphrase, { maxRecords: 2 })).toEqual(bundle);
      await expect(readBundle(path, passphrase, { maxRecords: 1 })).rejects.toThrow(/record count/u);
      await expect(readBundle(path, passphrase, { maxJsonDepth: 1 })).rejects.toThrow(/nesting depth/u);
      await expect(readBundle(path, passphrase, { maxJsonNodes: 1 })).rejects.toThrow(/node limit/u);
      await expect(readBundle(path, passphrase, { maxRecords: MAX_VAULT_RECORDS + 1 })).rejects.toThrow(/maxRecords/u);
      await expect(readBundle(path, passphrase, { maxJsonDepth: MAX_VAULT_JSON_DEPTH + 1 })).rejects.toThrow(/maxJsonDepth/u);
      await expect(readBundle(path, passphrase, { maxJsonNodes: MAX_VAULT_JSON_NODES + 1 })).rejects.toThrow(/maxJsonNodes/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects oversized frame lengths, truncated frames, and authenticated trailing data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trajpack-vault-frame-bounds-"));
    const original = join(directory, "original.trajpack");
    const oversizedLength = join(directory, "oversized-frame.trajpack");
    const truncated = join(directory, "truncated-frame.trajpack");
    const trailing = join(directory, "trailing-data.trajpack");
    const passphrase = "correct horse battery staple";
    try {
      await writeBundle(original, passphrase, fixtureBundle("frame boundary sentinel"));
      const bytes = await readFile(original);
      const magicBytes = Buffer.byteLength("TRJPACK1\0", "ascii");
      const headerLength = bytes.readUInt32BE(magicBytes);
      const firstFrameLengthOffset = magicBytes + 4 + headerLength;

      const maliciousLength = Buffer.from(bytes);
      maliciousLength.writeUInt32BE(0xffff_ffff, firstFrameLengthOffset);
      await writeFile(oversizedLength, maliciousLength);
      await expect(readBundle(oversizedLength, passphrase)).rejects.toThrow(/frame length/u);

      await writeFile(truncated, bytes.subarray(0, bytes.length - 1));
      await expect(readBundle(truncated, passphrase)).rejects.toThrow(/Truncated encrypted frame/u);

      await writeFile(trailing, bytes);
      await appendFile(trailing, Buffer.from([0x00]));
      await expect(readBundle(trailing, passphrase)).rejects.toThrow(/Unexpected data after final/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects truncated and overflowing header lengths before key derivation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trajpack-vault-header-bounds-"));
    const truncated = join(directory, "truncated-header.trajpack");
    const overflowing = join(directory, "overflowing-header.trajpack");
    const magic = Buffer.from("TRJPACK1\0", "ascii");
    const length = Buffer.alloc(4);
    try {
      length.writeUInt32BE(100, 0);
      await writeFile(truncated, Buffer.concat([magic, length, Buffer.from("{}", "utf8")]));
      await expect(readBundle(truncated, "correct horse battery staple")).rejects.toThrow(/Truncated trajpack header/u);

      length.writeUInt32BE(0xffff_ffff, 0);
      await writeFile(overflowing, Buffer.concat([magic, length]));
      await expect(readBundle(overflowing, "correct horse battery staple")).rejects.toThrow(/header length/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked vault file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trajpack-vault-link-"));
    const actual = join(directory, "actual.trajpack");
    const linked = join(directory, "linked.trajpack");
    try {
      await writeBundle(actual, "correct horse battery staple", fixtureBundle());
      await symlink(actual, linked, "file");
      await expect(readBundle(linked, "correct horse battery staple")).rejects.toThrow(/regular file/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
