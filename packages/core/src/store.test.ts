import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TrajpackPaths } from "./paths.js";
import { deleteTrace, listTraceIds, loadTrace, replaceTrace, saveNewTrace } from "./store.js";
import { fixtureBundle } from "./testing.js";

describe("vault store", () => {
  it("saves, replaces, lists, and tombstones an exact trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-store-"));
    const paths: TrajpackPaths = {
      data: root,
      vault: join(root, "vault"),
      runtime: join(root, "runtime"),
      tombstones: join(root, "tombstones"),
    };
    const bundle = fixtureBundle();
    const passphrase = "correct horse battery staple";
    try {
      await saveNewTrace(bundle, passphrase, paths);
      expect(await listTraceIds(paths)).toEqual([bundle.manifest.trace_id]);
      bundle.manifest.review.notes = "reviewed";
      await replaceTrace(bundle, passphrase, paths);
      expect((await loadTrace(bundle.manifest.trace_id, passphrase, paths)).manifest.review.notes).toBe("reviewed");
      const backup = join(paths.vault, `${bundle.manifest.trace_id}.trajpack.backup`);
      const crashedTemporary = join(paths.vault, `${bundle.manifest.trace_id}.trajpack.next.123.456.tmp`);
      await writeFile(backup, "encrypted-remnant");
      await writeFile(crashedTemporary, "encrypted-remnant");
      await deleteTrace(bundle.manifest.trace_id, paths);
      expect(await listTraceIds(paths)).toEqual([]);
      await expect(access(backup)).rejects.toThrow();
      await expect(access(crashedTemporary)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
