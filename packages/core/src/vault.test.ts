import { mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_VAULT_FILE_BYTES, writeBundle, readBundle } from "./vault.js";
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
