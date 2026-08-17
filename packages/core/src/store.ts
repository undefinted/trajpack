import { chmod, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { TraceBundle } from "@trajpack/schema";
import { sha256 } from "./canonical.js";
import { defaultPaths, type TrajpackPaths } from "./paths.js";
import { readBundle, writeBundle } from "./vault.js";

const TRACE_ID = /^[a-f0-9]{32}$/;
const TRACE_ARTIFACT = /^([a-f0-9]{32})\.trajpack(?:\.(next|backup))?$/;

type RecoveryCandidateKind = "target" | "next" | "backup";

interface RecoveryCandidate {
  kind: RecoveryCandidateKind;
  path: string;
  exists: boolean;
  valid: boolean;
  bundle?: TraceBundle;
}

/**
 * Directory fsync is the durability barrier for rename/unlink transactions on
 * POSIX filesystems. Windows does not expose a portable directory-fsync API to
 * Node, so the known unsupported errors are tolerated there only; file data is
 * still flushed by VaultWriter before publication.
 */
async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && ["EACCES", "EBADF", "EISDIR", "EINVAL", "ENOSYS", "EPERM", "UNKNOWN"].includes(code ?? "")) {
      return;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

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

function candidatePaths(traceId: string, paths: TrajpackPaths): Record<RecoveryCandidateKind, string> {
  const target = vaultPath(traceId, paths);
  return { target, next: `${target}.next`, backup: `${target}.backup` };
}

async function inspectCandidate(
  kind: RecoveryCandidateKind,
  path: string,
  traceId: string,
  passphrase: string,
): Promise<RecoveryCandidate> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind, path, exists: false, valid: false };
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Vault recovery ${kind} candidate must be a real regular file`);
  }
  try {
    const bundle = await readBundle(path, passphrase);
    if (bundle.manifest.trace_id !== traceId) {
      throw new Error(`Vault recovery conflict: ${kind} candidate belongs to another trace`);
    }
    return { kind, path, exists: true, valid: true, bundle };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Vault recovery conflict:")) throw error;
    return { kind, path, exists: true, valid: false };
  }
}

async function inspectCandidates(
  traceId: string,
  passphrase: string,
  paths: TrajpackPaths,
): Promise<Record<RecoveryCandidateKind, RecoveryCandidate>> {
  const candidates = candidatePaths(traceId, paths);
  // Inspection is deliberately sequential: Argon2id verification is memory
  // intensive and parallel recovery must not multiply its memory requirement.
  const target = await inspectCandidate("target", candidates.target, traceId, passphrase);
  const next = await inspectCandidate("next", candidates.next, traceId, passphrase);
  const backup = await inspectCandidate("backup", candidates.backup, traceId, passphrase);
  return { target, next, backup };
}

async function removeSidecarsAfterDurableTarget(
  candidates: Record<RecoveryCandidateKind, RecoveryCandidate>,
  paths: TrajpackPaths,
): Promise<void> {
  let changed = false;
  for (const candidate of [candidates.next, candidates.backup]) {
    if (!candidate.exists) continue;
    await rm(candidate.path, { force: true });
    changed = true;
  }
  if (changed) await syncDirectory(paths.vault);
}

/**
 * Recover a replace transaction without ever deleting the only candidate that
 * authenticated with the supplied key. The durable target is authoritative;
 * otherwise a staged next generation wins over the rollback backup.
 */
async function recoverTrace(
  traceId: string,
  passphrase: string,
  paths: TrajpackPaths,
): Promise<TraceBundle> {
  await ensureManagedDirectory(paths.vault);
  const candidates = await inspectCandidates(traceId, passphrase, paths);

  if (candidates.target.valid && candidates.target.bundle) {
    await removeSidecarsAfterDurableTarget(candidates, paths);
    return candidates.target.bundle;
  }

  const source = candidates.next.valid
    ? candidates.next
    : candidates.backup.valid
      ? candidates.backup
      : undefined;
  if (!source?.bundle) {
    // This also covers a wrong passphrase. Never clean up candidates when none
    // authenticate, because one of them may be the last recoverable copy.
    throw new Error(`Trace has no recoverable encrypted artifact: ${traceId}`);
  }

  if (candidates.target.exists) {
    // The selected source has already authenticated. Removing an unreadable
    // target cannot remove the last valid generation, and is needed on Windows
    // where rename does not replace an existing destination.
    await rm(candidates.target.path, { force: true });
    await syncDirectory(paths.vault);
  }

  await rename(source.path, candidates.target.path);
  await syncDirectory(paths.vault);
  const recovered = await readBundle(candidates.target.path, passphrase);
  if (recovered.manifest.trace_id !== traceId) {
    throw new Error("Vault recovery conflict after promotion");
  }

  await removeSidecarsAfterDurableTarget(candidates, paths);
  return recovered;
}

export async function listTraceIds(paths: TrajpackPaths = defaultPaths()): Promise<string[]> {
  await ensureManagedDirectory(paths.vault);
  const entries = await readdir(paths.vault, { withFileTypes: true });
  const traceIds = new Set<string>();
  for (const entry of entries) {
    const match = TRACE_ARTIFACT.exec(entry.name);
    if (!match) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error("Managed trace artifact must be a real regular file");
    }
    traceIds.add(match[1]!);
  }
  return [...traceIds].sort();
}

export async function loadTrace(traceId: string, passphrase: string, paths: TrajpackPaths = defaultPaths()): Promise<TraceBundle> {
  if (!TRACE_ID.test(traceId)) throw new Error("Invalid trace id");
  return recoverTrace(traceId, passphrase, paths);
}

export async function saveNewTrace(bundle: TraceBundle, passphrase: string, paths: TrajpackPaths = defaultPaths()): Promise<string> {
  await ensureManagedDirectory(paths.vault);
  const target = vaultPath(bundle.manifest.trace_id, paths);
  const candidates = candidatePaths(bundle.manifest.trace_id, paths);
  const artifacts = await Promise.all(Object.values(candidates).map(async (candidate) => lstat(candidate).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  )));
  if (artifacts.some(Boolean)) {
    // A backup-only or next-only crash state is still an existing trace. First
    // recover it, then report the collision; corrupt/foreign artifacts fail
    // closed and remain untouched.
    await recoverTrace(bundle.manifest.trace_id, passphrase, paths);
    throw new Error(`Trace already exists: ${bundle.manifest.trace_id}`);
  }
  await writeBundle(target, passphrase, bundle);
  return target;
}

export async function replaceTrace(bundle: TraceBundle, passphrase: string, paths: TrajpackPaths = defaultPaths()): Promise<void> {
  await ensureManagedDirectory(paths.vault);
  const target = vaultPath(bundle.manifest.trace_id, paths);
  const next = `${target}.next`;
  const backup = `${target}.backup`;
  // Resolve any previous crash before starting a new generation. In
  // particular, never delete .next/.backup before proving target is valid.
  await recoverTrace(bundle.manifest.trace_id, passphrase, paths);
  await writeBundle(next, passphrase, bundle);
  const staged = await readBundle(next, passphrase);
  if (staged.manifest.trace_id !== bundle.manifest.trace_id) {
    throw new Error("Staged replacement belongs to another trace");
  }
  await rename(target, backup);
  await syncDirectory(paths.vault);
  try {
    await rename(next, target);
    await syncDirectory(paths.vault);
    const published = await readBundle(target, passphrase);
    if (published.manifest.trace_id !== bundle.manifest.trace_id) {
      throw new Error("Published replacement belongs to another trace");
    }
    await rm(backup, { force: true });
    await syncDirectory(paths.vault);
  } catch (error) {
    // Re-run the same deterministic state machine. It either publishes the
    // verified next generation or restores the verified backup, without
    // erasing the last authentic copy.
    await recoverTrace(bundle.manifest.trace_id, passphrase, paths).catch(() => undefined);
    throw error;
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
    const handle = await open(tombstone, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({
        trace_id: traceId,
        deleted_at: new Date().toISOString(),
        encrypted_artifact_sha256: sha256(encrypted),
        removed_managed_artifacts: artifacts.map((entry) => entry.name).sort(),
        warning: "Managed descendants must be regenerated; external plaintext copies cannot be recalled.",
      })}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(paths.tombstones);
  }
  await Promise.all(artifacts.map((entry) => rm(join(paths.vault, entry.name), { force: true })));
  if (artifacts.length > 0) await syncDirectory(paths.vault);
  return tombstone;
}
