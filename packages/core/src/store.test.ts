import { access, copyFile, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TrajpackPaths } from "./paths.js";
import { deleteTrace, listTraceIds, loadTrace, replaceTrace, saveNewTrace } from "./store.js";
import { fixtureBundle } from "./testing.js";
import { writeBundle } from "./vault.js";

function fixturePaths(root: string): TrajpackPaths {
  return {
    data: root,
    vault: join(root, "vault"),
    runtime: join(root, "runtime"),
    tombstones: join(root, "tombstones"),
  };
}

async function missing(path: string): Promise<boolean> {
  return stat(path).then(() => false, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return true;
    throw error;
  });
}

describe("vault store", () => {
  it("saves, replaces, lists, and tombstones an exact trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-store-"));
    const paths = fixturePaths(root);
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

  it("prunes stale writer temp files when listing traces", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-store-stale-temp-"));
    const paths = fixturePaths(root);
    const bundle = fixtureBundle();
    const passphrase = "correct horse battery staple";
    try {
      await saveNewTrace(bundle, passphrase, paths);
      const stale = join(paths.vault, `${bundle.manifest.trace_id}.trajpack.123.456.tmp`);
      await writeFile(stale, "stale-remnant");
      expect(await listTraceIds(paths)).toEqual([bundle.manifest.trace_id]);
      await expect(access(stale)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("recovers and lists a trace when a crash left only the backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-store-backup-recovery-"));
    const paths = fixturePaths(root);
    const bundle = fixtureBundle("backup generation");
    const passphrase = "correct horse battery staple";
    const target = join(paths.vault, `${bundle.manifest.trace_id}.trajpack`);
    const backup = `${target}.backup`;
    try {
      await saveNewTrace(bundle, passphrase, paths);
      await rename(target, backup);

      expect(await listTraceIds(paths)).toEqual([bundle.manifest.trace_id]);
      expect((await loadTrace(bundle.manifest.trace_id, passphrase, paths)).events).toEqual(bundle.events);
      expect(await missing(target)).toBe(false);
      expect(await missing(backup)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("prefers a verified next generation when target is missing and keeps backup until promotion", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-store-next-recovery-"));
    const paths = fixturePaths(root);
    const previous = fixtureBundle("previous generation");
    const nextBundle = fixtureBundle("next generation");
    nextBundle.manifest.review.notes = "next generation won";
    const passphrase = "correct horse battery staple";
    const target = join(paths.vault, `${previous.manifest.trace_id}.trajpack`);
    const next = `${target}.next`;
    const backup = `${target}.backup`;
    try {
      await saveNewTrace(previous, passphrase, paths);
      await rename(target, backup);
      await writeBundle(next, passphrase, nextBundle);

      const recovered = await loadTrace(previous.manifest.trace_id, passphrase, paths);
      expect(recovered.manifest.review.notes).toBe("next generation won");
      expect(await missing(target)).toBe(false);
      expect(await missing(next)).toBe(true);
      expect(await missing(backup)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it("keeps a verified target authoritative over an uncommitted next generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-store-target-priority-"));
    const paths = fixturePaths(root);
    const current = fixtureBundle("current generation");
    current.manifest.review.notes = "current target won";
    const uncommitted = fixtureBundle("uncommitted generation");
    uncommitted.manifest.review.notes = "uncommitted next lost";
    const passphrase = "correct horse battery staple";
    const target = join(paths.vault, `${current.manifest.trace_id}.trajpack`);
    const next = `${target}.next`;
    try {
      await saveNewTrace(current, passphrase, paths);
      await writeBundle(next, passphrase, uncommitted);

      const recovered = await loadTrace(current.manifest.trace_id, passphrase, paths);
      expect(recovered.manifest.review.notes).toBe("current target won");
      expect(await missing(next)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);

  it("recovers from a corrupt target without deleting a valid backup first", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-store-corrupt-target-"));
    const paths = fixturePaths(root);
    const bundle = fixtureBundle("recoverable backup");
    const passphrase = "correct horse battery staple";
    const target = join(paths.vault, `${bundle.manifest.trace_id}.trajpack`);
    const backup = `${target}.backup`;
    try {
      await saveNewTrace(bundle, passphrase, paths);
      await copyFile(target, backup);
      await writeFile(target, "corrupt target");

      expect((await loadTrace(bundle.manifest.trace_id, passphrase, paths)).events).toEqual(bundle.events);
      expect(await missing(target)).toBe(false);
      expect(await missing(backup)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails closed and preserves every artifact when no candidate authenticates", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-store-no-valid-candidate-"));
    const paths = fixturePaths(root);
    const bundle = fixtureBundle("must not replace corrupt state");
    const passphrase = "correct horse battery staple";
    const target = join(paths.vault, `${bundle.manifest.trace_id}.trajpack`);
    const next = `${target}.next`;
    const backup = `${target}.backup`;
    try {
      await saveNewTrace(bundle, passphrase, paths);
      await writeFile(target, "corrupt target");
      await writeFile(next, "corrupt next");
      await writeFile(backup, "corrupt backup");
      const before = await Promise.all([target, next, backup].map((path) => readFile(path)));

      await expect(loadTrace(bundle.manifest.trace_id, passphrase, paths)).rejects.toThrow(/no recoverable/u);
      await expect(replaceTrace(bundle, passphrase, paths)).rejects.toThrow(/no recoverable/u);
      const after = await Promise.all([target, next, backup].map((path) => readFile(path)));
      expect(after).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("fails closed on a candidate whose authenticated manifest belongs to another trace", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-store-conflict-"));
    const paths = fixturePaths(root);
    const bundle = fixtureBundle("authoritative target");
    const foreign = fixtureBundle("foreign next");
    foreign.manifest.trace_id = "fedcba9876543210fedcba9876543210";
    foreign.events = foreign.events.map((event) => ({ ...event, trace_id: foreign.manifest.trace_id }));
    const passphrase = "correct horse battery staple";
    const target = join(paths.vault, `${bundle.manifest.trace_id}.trajpack`);
    const next = `${target}.next`;
    try {
      await saveNewTrace(bundle, passphrase, paths);
      await writeBundle(next, passphrase, foreign);

      await expect(loadTrace(bundle.manifest.trace_id, passphrase, paths)).rejects.toThrow(/belongs to another trace/u);
      expect(await missing(target)).toBe(false);
      expect(await missing(next)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});
