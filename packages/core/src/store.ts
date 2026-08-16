import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TraceBundle } from "@trajpack/schema";
import { sha256 } from "./canonical.js";
import { defaultPaths, type TrajpackPaths } from "./paths.js";
import { readBundle, writeBundle } from "./vault.js";

const TRACE_ID = /^[a-f0-9]{32}$/;

async function ensureManagedDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Managed trajpack path must be a real directory");
  }
  await chmod(path, 0o700).catch((error: NodeJS.ErrnoException) => {
    if (process.platform !== "win32") throw error;
  });
}

export function vaultPath(traceId: string, paths: TrajpackPaths = defaultPaths()): string {
  if (!TRACE_ID.test(traceId)) throw new Error("Invalid trace id");
  return join(paths.vault, `${traceId}.trajpack`);
}

export async function listTraceIds(paths: TrajpackPaths = defaultPaths()): Promise<string[]> {
  await ensureManagedDirectory(paths.vault);
  const entries = await readdir(paths.vault, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".trajpack") && TRACE_ID.test(entry.name.slice(0, -9)))
    .map((entry) => entry.name.slice(0, -9))
    .sort();
}

export async function loadTrace(traceId: string, passphrase: string, paths: TrajpackPaths = defaultPaths()): Promise<TraceBundle> {
  return readBundle(vaultPath(traceId, paths), passphrase);
}

export async function saveNewTrace(bundle: TraceBundle, passphrase: string, paths: TrajpackPaths = defaultPaths()): Promise<string> {
  await ensureManagedDirectory(paths.vault);
  const target = vaultPath(bundle.manifest.trace_id, paths);
  try {
    await stat(target);
    throw new Error(`Trace already exists: ${bundle.manifest.trace_id}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeBundle(target, passphrase, bundle);
  return target;
}

export async function replaceTrace(bundle: TraceBundle, passphrase: string, paths: TrajpackPaths = defaultPaths()): Promise<void> {
  await ensureManagedDirectory(paths.vault);
  const target = vaultPath(bundle.manifest.trace_id, paths);
  const next = `${target}.next`;
  const backup = `${target}.backup`;
  await rm(next, { force: true });
  await rm(backup, { force: true });
  await writeBundle(next, passphrase, bundle);
  await readBundle(next, passphrase);
  await rename(target, backup);
  try {
    await rename(next, target);
    await rm(backup, { force: true });
  } catch (error) {
    await rename(backup, target).catch(() => undefined);
    throw error;
  } finally {
    await rm(next, { force: true });
  }
}

export async function deleteTrace(traceId: string, paths: TrajpackPaths = defaultPaths()): Promise<string> {
  const target = vaultPath(traceId, paths);
  await ensureManagedDirectory(paths.tombstones);
  const tombstone = join(paths.tombstones, `${traceId}.json`);
  const pattern = new RegExp(`^${traceId}\\.trajpack(?:\\.(?:next|backup)(?:\\.\\d+\\.\\d+\\.tmp)?|\\.\\d+\\.\\d+\\.tmp)?$`);
  await ensureManagedDirectory(paths.vault);
  const entries = await readdir(paths.vault, { withFileTypes: true });
  const artifacts = entries.filter((entry) => pattern.test(entry.name));
  if (artifacts.some((entry) => entry.isDirectory())) throw new Error("Managed trace artifact unexpectedly became a directory");
  const exact = artifacts.find((entry) => entry.name === `${traceId}.trajpack` && entry.isFile())
    ?? artifacts.find((entry) => entry.isFile());
  if (artifacts.some((entry) => entry.name === `${traceId}.trajpack` && !entry.isFile())) {
    throw new Error("Managed trace artifact is not a regular file");
  }
  const existingTombstone = await readFile(tombstone, "utf8").then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (!existingTombstone) {
    if (!exact) throw new Error(`Trace does not exist: ${traceId}`);
    const encrypted = await readFile(join(paths.vault, exact.name));
    await writeFile(tombstone, `${JSON.stringify({
      trace_id: traceId,
      deleted_at: new Date().toISOString(),
      encrypted_artifact_sha256: sha256(encrypted),
      removed_managed_artifacts: artifacts.map((entry) => entry.name).sort(),
      warning: "Managed descendants must be regenerated; external plaintext copies cannot be recalled.",
    })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  await Promise.all(artifacts.map((entry) => rm(join(paths.vault, entry.name), { force: true })));
  return tombstone;
}
