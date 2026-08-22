import { lstat, open } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Host } from "@trajpack/schema";
import { assertSafeOutputParent, canonicalJson } from "@trajpack/core";
import {
  CLAUDE_HOOK_INTERFACE,
  CLAUDE_STREAM_INTERFACE,
  CLAUDE_TRANSCRIPT_OPAQUE_INTERFACE_VERSION,
  CODEX_APP_SERVER_INTERFACE_VERSION,
  CODEX_HOOK_INTERFACE_VERSION,
  CODEX_JSONL_INTERFACE_VERSION,
  DEEPSEEK_HARNESS_INTERFACE_VERSION,
  GEMINI_CLI_HOOK_INTERFACE_VERSION,
} from "@trajpack/adapters";
import type { CaptureSessionStats } from "./capture-session.js";

export const CAPTURE_RECEIPT_SCHEMA = "trajpack/capture-receipt/0.1" as const;

export interface CaptureReceipt {
  schema: typeof CAPTURE_RECEIPT_SCHEMA;
  trace_id: string;
  terminal_at: string;
  host: Host;
  interface_version: string | null;
  status: "stored" | "aborted";
  reason: string;
  host_exit_code: number | null;
  raw_event_count: number;
  normalized_event_count: number | null;
  raw_bytes: number;
  raw_lineage_sha256: string;
}

export interface PreparedCaptureReceiptPath {
  /** Canonical, symlink-free parent observed before capture starts. */
  parent: string;
  /** A single JSON filename; never a caller-controlled path fragment. */
  leaf: string;
  /** Lexical parent revalidated when the terminal receipt is committed. */
  requestedParent: string;
  parentDevice: number;
  parentInode: number;
}

const RECEIPT_INTERFACES: Readonly<Partial<Record<Host, ReadonlySet<string>>>> = Object.freeze({
  codex: new Set([
    CODEX_JSONL_INTERFACE_VERSION,
    CODEX_HOOK_INTERFACE_VERSION,
    CODEX_APP_SERVER_INTERFACE_VERSION,
  ]),
  claude_code: new Set([
    CLAUDE_STREAM_INTERFACE,
    CLAUDE_HOOK_INTERFACE,
    CLAUDE_TRANSCRIPT_OPAQUE_INTERFACE_VERSION,
  ]),
  gemini_cli: new Set([GEMINI_CLI_HOOK_INTERFACE_VERSION]),
  deepseek_harness: new Set([DEEPSEEK_HARNESS_INTERFACE_VERSION]),
});
const UTC_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u;

function exactUtcInstant(value: string): boolean {
  const match = UTC_INSTANT.exec(value);
  if (match === null) return false;
  const date = new Date(value);
  const expected = match.slice(1, 7).map(Number);
  const observed = [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  ];
  return Number.isFinite(date.getTime())
    && observed.every((part, index) => part === expected[index]);
}

function comparable(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameIdentity(
  left: { dev: number; ino: number },
  right: { dev: number; ino: number },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function syncDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(path, "r");
    await directory.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32"
      || !["EACCES", "EBADF", "EISDIR", "EINVAL", "ENOSYS", "EPERM", "UNKNOWN"].includes(code ?? "")) {
      throw error;
    }
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

/** Validate a receipt destination without creating any artifact before capture terminates. */
export async function prepareCaptureReceiptPath(input: string): Promise<PreparedCaptureReceiptPath> {
  if (input.trim().length === 0 || extname(input).toLowerCase() !== ".json") {
    throw new Error("--receipt must name a new .json file");
  }
  const requested = resolve(input);
  const requestedParent = dirname(requested);
  const leaf = basename(requested);
  const parent = await assertSafeOutputParent(requestedParent);
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error("Capture receipt parent is not a real directory");
  }
  const target = join(parent, leaf);
  await lstat(target).then(
    () => { throw new Error(`Capture receipt already exists: ${target}`); },
    (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; },
  );
  return Object.freeze({
    parent,
    leaf,
    requestedParent,
    parentDevice: parentMetadata.dev,
    parentInode: parentMetadata.ino,
  });
}

/**
 * Commit one terminal, content-free receipt using an exclusive create. The
 * parent and opened file identities are checked again before any bytes are
 * written, closing ordinary symlink/junction and leaf-replacement races.
 */
export async function writeCaptureReceipt(
  destination: PreparedCaptureReceiptPath,
  receipt: CaptureReceipt,
): Promise<string> {
  const currentParent = await assertSafeOutputParent(destination.requestedParent);
  if (comparable(currentParent) !== comparable(destination.parent)) {
    throw new Error("Capture receipt parent changed after validation");
  }
  const parentBefore = await lstat(currentParent);
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) {
    throw new Error("Capture receipt parent is not a real directory");
  }
  if (parentBefore.dev !== destination.parentDevice || parentBefore.ino !== destination.parentInode) {
    throw new Error("Capture receipt parent changed after validation");
  }
  const target = join(currentParent, destination.leaf);
  const handle = await open(target, "wx", 0o600);
  try {
    const [opened, parentAfterOpen, targetAfterOpen] = await Promise.all([
      handle.stat(),
      lstat(currentParent),
      lstat(target),
    ]);
    if (!opened.isFile() || !targetAfterOpen.isFile() || targetAfterOpen.isSymbolicLink()
      || !sameIdentity(parentBefore, parentAfterOpen)
      || !sameIdentity(opened, targetAfterOpen)) {
      throw new Error("Capture receipt path changed during exclusive creation");
    }
    await handle.chmod(0o600).catch((error: NodeJS.ErrnoException) => {
      if (process.platform !== "win32") throw error;
    });
    await handle.writeFile(`${canonicalJson(receipt)}\n`, "utf8");
    await handle.sync();
    const [parentAfterWrite, targetAfterWrite] = await Promise.all([
      lstat(currentParent),
      lstat(target),
    ]);
    if (!sameIdentity(parentBefore, parentAfterWrite)
      || targetAfterWrite.isSymbolicLink()
      || !sameIdentity(opened, targetAfterWrite)) {
      throw new Error("Capture receipt path changed before commit completed");
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  await syncDirectory(currentParent);
  return target;
}

export function makeCaptureReceipt(input: {
  traceId: string;
  host: Host;
  interfaceVersion: string | null;
  status: CaptureReceipt["status"];
  reason: string;
  hostExitCode: number | null;
  stats: Readonly<CaptureSessionStats>;
  terminalAt?: string;
}): CaptureReceipt {
  if (!/^[a-f0-9]{32}$/u.test(input.traceId)) throw new Error("Capture receipt trace id is invalid");
  if (!/^[A-Z0-9_]{1,128}$/u.test(input.reason)) throw new Error("Capture receipt reason must be a stable code");
  if (input.hostExitCode !== null && !Number.isSafeInteger(input.hostExitCode)) {
    throw new Error("Capture receipt host exit code is invalid");
  }
  for (const [label, value] of [
    ["raw event count", input.stats.rawEvents],
    ["raw byte count", input.stats.rawBytes],
    ["normalized event count", input.stats.normalizedEvents],
  ] as const) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`Capture receipt ${label} is invalid`);
    }
  }
  if (!/^[a-f0-9]{64}$/u.test(input.stats.rawLineageSha256)) {
    throw new Error("Capture receipt raw lineage hash is invalid");
  }
  const terminalAt = input.terminalAt ?? new Date().toISOString();
  if (!exactUtcInstant(terminalAt)) throw new Error("Capture receipt terminal time must be a valid ISO-8601 UTC instant");
  // Interface versions may originate in CLI metadata. Retain only pinned
  // adapter identifiers (or a deterministic '+' composition of them), never
  // arbitrary caller text, in the plaintext receipt.
  const allowedInterfaces = RECEIPT_INTERFACES[input.host];
  const interfaceParts = input.interfaceVersion?.split("+") ?? [];
  const interfaceVersion = input.interfaceVersion !== null
    && input.interfaceVersion.length <= 1024
    && interfaceParts.length > 0
    && allowedInterfaces !== undefined
    && interfaceParts.every(value => allowedInterfaces.has(value))
    ? input.interfaceVersion
    : null;
  return Object.freeze({
    schema: CAPTURE_RECEIPT_SCHEMA,
    trace_id: input.traceId,
    terminal_at: terminalAt,
    host: input.host,
    interface_version: interfaceVersion,
    status: input.status,
    reason: input.reason,
    host_exit_code: input.hostExitCode,
    raw_event_count: input.stats.rawEvents,
    normalized_event_count: input.stats.normalizedEvents,
    raw_bytes: input.stats.rawBytes,
    raw_lineage_sha256: input.stats.rawLineageSha256,
  });
}
