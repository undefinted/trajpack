import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve, win32 } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Host } from "@trajpack/schema";
import {
  canonicalJson,
  consentReceipt,
  createManifest,
  defaultPaths,
  evaluateGate,
  privatePathHmac,
  sha256,
} from "@trajpack/core";
import { classifyJsonLine, DEEPSEEK_HARNESS_INTERFACE_VERSION } from "@trajpack/adapters";
import { CaptureLimitError, CaptureSession } from "./capture-session.js";
import {
  DEFAULT_MAX_CAPTURE_EVENTS,
  DEFAULT_MAX_CAPTURE_RAW_BYTES,
  MAX_CONFIGURABLE_CAPTURE_EVENTS,
  MAX_CONFIGURABLE_CAPTURE_RAW_BYTES,
  startIngestServer,
} from "./ingest-server.js";
import { readPassphrase } from "./secret.js";
import { resolveSourceOptions, type SourceCliOptions } from "./source-options.js";

const HOSTS: Record<string, Host> = {
  codex: "codex",
  claude: "claude_code",
  gemini: "gemini_cli",
  dsh: "deepseek_harness",
};

const DEFAULT_COMMAND: Record<string, string> = { codex: "codex", claude: "claude", gemini: "gemini", dsh: "dsh" };

const WINDOWS_CAPTURE_SHIMS = new Set(["codex", "claude", "gemini", "dsh"]);
const WINDOWS_BATCH_EXTENSIONS = new Set([".cmd", ".bat"]);
const WINDOWS_EXECUTABLE_EXTENSIONS = new Set([".exe", ".com", ".cmd", ".bat"]);
const WINDOWS_CMD_META = /([()\][%!^"`<>&|;, *?])/gu;

export interface CaptureProcessLaunch {
  command: string;
  args: string[];
  windowsVerbatimArguments: boolean;
  resolvedExecutable: string;
  viaCommandProcessor: boolean;
}

function windowsShimName(value: string): string {
  const extension = extname(value).toLowerCase();
  const name = basename(value).slice(0, extension.length === 0 ? undefined : -extension.length);
  return name.toLowerCase();
}

function safeWindowsCommandProcessor(environment: NodeJS.ProcessEnv): string {
  const configured = environment.ComSpec;
  if (typeof configured === "string" && configured.length > 0
    && !/[\u0000-\u001f\u007f]/u.test(configured)
    && win32.basename(configured).toLowerCase() === "cmd.exe") {
    return configured;
  }
  const systemRoot = environment.SystemRoot;
  return typeof systemRoot === "string" && systemRoot.length > 0
    && !/[\u0000-\u001f\u007f]/u.test(systemRoot)
    ? win32.join(systemRoot, "System32", "cmd.exe")
    : "cmd.exe";
}

function escapeWindowsCommand(value: string): string {
  return value.replace(WINDOWS_CMD_META, "^$1");
}

function escapeWindowsArgument(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Windows batch capture arguments cannot contain control characters");
  }
  // Quote for CommandLineToArgvW, then escape cmd.exe metacharacters twice:
  // once for our command processor and once for the npm/pnpm .cmd shim.
  let escaped = value.replace(/(\\*)"/gu, "$1$1\\\"");
  escaped = escaped.replace(/(\\*)$/u, "$1$1");
  escaped = `"${escaped}"`;
  escaped = escaped.replace(WINDOWS_CMD_META, "^$1");
  return escaped.replace(WINDOWS_CMD_META, "^$1");
}

/**
 * Build the fixed cmd.exe invocation required for a trusted npm/pnpm batch
 * shim. The command and every argument are escaped separately; no caller text
 * is interpolated as an unescaped shell fragment.
 */
export function windowsBatchLaunch(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): CaptureProcessLaunch {
  const extension = extname(executable).toLowerCase();
  if (!WINDOWS_BATCH_EXTENSIONS.has(extension) || !WINDOWS_CAPTURE_SHIMS.has(windowsShimName(executable))) {
    throw new Error("Windows batch capture is restricted to codex, claude, gemini, or dsh shims");
  }
  if (executable.length === 0 || /[\u0000-\u001f\u007f]/u.test(executable)) {
    throw new Error("Windows capture shim path is invalid");
  }
  const shellCommand = [
    escapeWindowsCommand(executable),
    ...args.map((argument) => escapeWindowsArgument(argument)),
  ].join(" ");
  return {
    command: safeWindowsCommandProcessor(environment),
    args: ["/d", "/v:off", "/s", "/c", `"${shellCommand}"`],
    windowsVerbatimArguments: true,
    resolvedExecutable: executable,
    viaCommandProcessor: true,
  };
}

function pathLikeWindowsExecutable(value: string): boolean {
  return isAbsolute(value) || value.includes("\\") || value.includes("/");
}

function locateWindowsCaptureExecutable(
  executable: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): string {
  const requestedName = windowsShimName(executable);
  const extension = extname(executable).toLowerCase();
  if (pathLikeWindowsExecutable(executable)) return resolve(cwd, executable);
  if (!WINDOWS_CAPTURE_SHIMS.has(requestedName)) return executable;
  if (extension.length > 0 && !WINDOWS_EXECUTABLE_EXTENSIONS.has(extension)) return executable;
  const located = spawnSync("where.exe", [executable], {
    cwd,
    env: scrubHostEnvironment(environment),
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 10_000,
  });
  if (located.status !== 0 || located.error !== undefined) return executable;
  const candidates = String(located.stdout ?? "")
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0
      && !/[\u0000-\u001f\u007f]/u.test(candidate)
      && isAbsolute(candidate)
      && WINDOWS_EXECUTABLE_EXTENSIONS.has(extname(candidate).toLowerCase())
      && windowsShimName(candidate) === requestedName);
  return candidates[0] ?? executable;
}

/** Resolve a capture command without enabling a general-purpose shell. */
export function captureProcessLaunch(
  executable: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): CaptureProcessLaunch {
  if (platform !== "win32") {
    return {
      command: executable,
      args: [...args],
      windowsVerbatimArguments: false,
      resolvedExecutable: executable,
      viaCommandProcessor: false,
    };
  }
  const resolvedExecutable = locateWindowsCaptureExecutable(executable, cwd, environment);
  const extension = extname(resolvedExecutable).toLowerCase();
  if (WINDOWS_BATCH_EXTENSIONS.has(extension)) {
    return windowsBatchLaunch(resolvedExecutable, args, environment);
  }
  return {
    command: resolvedExecutable,
    args: [...args],
    windowsVerbatimArguments: false,
    resolvedExecutable,
    viaCommandProcessor: false,
  };
}

/** Expand a leading `~` so `--cwd "~/proj"` resolves to the user home instead of a literal `~/proj` directory. */
function resolveCwd(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return resolve(value);
}

export interface CaptureCommandOptions extends SourceCliOptions {
  cwd?: string;
  maxEvents?: string | number;
  maxRawBytes?: string | number;
  drainMs?: string | number;
}

export interface CollectorChildEnvironment {
  url: string;
  token: string;
  host: Host;
}

export function scrubHostEnvironment(baseEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...baseEnvironment };
  delete environment.TRAJPACK_PASSPHRASE;
  delete environment.TRAJPACK_COLLECTOR_URL;
  delete environment.TRAJPACK_CAPTURE_TOKEN;
  delete environment.TRAJPACK_CAPTURE_HOST;
  return environment;
}

export function captureChildEnvironment(
  baseEnvironment: NodeJS.ProcessEnv,
  collector: CollectorChildEnvironment,
): NodeJS.ProcessEnv {
  const environment = scrubHostEnvironment(baseEnvironment);
  environment.TRAJPACK_COLLECTOR_URL = collector.url;
  environment.TRAJPACK_CAPTURE_TOKEN = collector.token;
  environment.TRAJPACK_CAPTURE_HOST = collector.host;
  return environment;
}

export function assertPinnedDeepSeekHarness(executable: string, cwd: string, environment: NodeJS.ProcessEnv): void {
  const pinned = /deepseek-harness@([^/]+)\//.exec(DEEPSEEK_HARNESS_INTERFACE_VERSION)?.[1];
  if (!pinned) throw new Error("Invalid pinned DeepSeek Harness interface version");
  const launch = captureProcessLaunch(executable, ["--version"], cwd, environment);
  const result = spawnSync(launch.command, launch.args, {
    cwd,
    env: scrubHostEnvironment(environment),
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
    timeout: 10_000,
  });
  const reported = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  assertDeepSeekHarnessVersionReport(reported, result.status);
}

export function observedRepoCommit(cwd: string, environment: NodeJS.ProcessEnv): string | null {
  const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd,
    env: scrubHostEnvironment(environment),
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 5_000,
  });
  const commit = result.status === 0 ? String(result.stdout ?? "").trim() : "";
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(commit) ? commit.toLowerCase() : null;
}

export function assertDeepSeekHarnessVersionReport(reported: string, status: number | null): void {
  const pinned = /deepseek-harness@([^/]+)\//.exec(DEEPSEEK_HARNESS_INTERFACE_VERSION)?.[1];
  if (!pinned) throw new Error("Invalid pinned DeepSeek Harness interface version");
  const exact = new RegExp(`(?:^|\\s)${pinned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`);
  if (status !== 0 || !exact.test(reported)) {
    throw new Error(`DeepSeek Harness compatibility check failed: expected exact ${pinned}; status=${String(status)}; report_sha256=${sha256(reported)}`);
  }
}

export function authoritativeCaptureArguments(host: Host, supplied: string[]): string[] {
  const args = [...supplied];
  if (host === "codex") {
    if (!args.includes("exec")) {
      throw new Error("Codex wrapper capture requires the official `codex exec --json` surface; use `trajpack arm codex` for an interactive client");
    }
    if (!args.includes("--json")) args.push("--json");
  } else if (host === "claude_code") {
    const outputIndex = args.indexOf("--output-format");
    if (outputIndex >= 0 && args[outputIndex + 1] !== "stream-json") {
      throw new Error("Claude wrapper capture requires --output-format stream-json");
    }
    if (outputIndex < 0) args.push("--output-format", "stream-json");
    if (!args.includes("--verbose")) args.push("--verbose");
    if (!args.includes("-p") && !args.includes("--print")) args.unshift("--print");
  }
  return args;
}

export function splitUtf8Lines(
  onLine: (line: string) => void,
  limits: { maxLineBytes: number; maxTotalBytes: number },
  onViolation: (reason: string) => void,
): { push(chunk: Buffer): void; flush(): void } {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let totalBytes = 0;
  let violated = false;
  const violate = (reason: string) => {
    if (violated) return;
    violated = true;
    pending = "";
    onViolation(reason);
  };
  const consume = (text: string) => {
    if (violated) return;
    pending += text;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const encodedLine = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (Buffer.byteLength(encodedLine, "utf8") > limits.maxLineBytes) {
        violate("CAPTURE_STDOUT_LINE_LIMIT_EXCEEDED");
        return;
      }
      const line = encodedLine.replace(/\r$/, "");
      if (line.trim()) onLine(line);
    }
    if (Buffer.byteLength(pending, "utf8") > limits.maxLineBytes) {
      violate("CAPTURE_STDOUT_LINE_LIMIT_EXCEEDED");
    }
  };
  return { push: (chunk: Buffer) => {
    if (violated) return;
    totalBytes += chunk.byteLength;
    if (totalBytes > limits.maxTotalBytes) {
      violate("CAPTURE_STDOUT_BYTE_LIMIT_EXCEEDED");
      return;
    }
    consume(decoder.write(chunk));
  }, flush: () => {
    if (violated) return;
    consume(decoder.end());
    if (!violated && pending.trim()) onLine(pending.replace(/\r$/, ""));
    pending = "";
  } };
}

export async function consumeUtf8StreamWithBackpressure(
  source: AsyncIterable<Buffer | string>,
  splitter: { push(chunk: Buffer): void; flush(): void },
  waitForIngest: () => Promise<unknown>,
): Promise<void> {
  for await (const chunk of source) {
    splitter.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
    // Do not request the next pipe chunk until every complete line from this
    // chunk is durably appended to the encrypted temporary vault.
    await waitForIngest();
  }
  splitter.flush();
  await waitForIngest();
}

function captureLimit(value: string | number | undefined, fallback: number, maximum: number, label: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

function captureDrainMs(value: string | number | undefined): number {
  const parsed = value === undefined ? 500 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 5_000) {
    throw new Error("--drain-ms must be an integer from 0 to 5000");
  }
  return parsed;
}

async function writeArmDescriptor(path: string, contents: string): Promise<void> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isFile() || details.size > 16 * 1024
      || (process.platform !== "win32"
        && (details.uid !== process.getuid?.() || (details.mode & 0o077) !== 0))) {
      throw new Error(`Unsafe or malformed existing arm descriptor: ${path}`);
    }
    const existing = JSON.parse(await readFile(path, "utf8")) as { expires_at?: unknown };
    if (typeof existing.expires_at !== "string" || Date.parse(existing.expires_at) > Date.now()) {
      throw new Error(`An active arm descriptor already exists: ${path}`);
    }
    await rm(path, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(path, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function ensurePrivateRuntimeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error(`Unsafe runtime directory: ${path}`);
  if (process.platform !== "win32") {
    if (details.uid !== process.getuid?.()) throw new Error(`Runtime directory is not owned by this user: ${path}`);
    await chmod(path, 0o700);
    const secured = await lstat(path);
    if ((secured.mode & 0o077) !== 0) throw new Error(`Runtime directory permissions are too broad: ${path}`);
  }
}

export function armRuntimeDirectory(host: Host): string {
  // Gemini's extension sandbox documents HOME as a safe inherited variable,
  // but may filter LOCALAPPDATA/XDG_RUNTIME_DIR. A home-relative capability
  // path keeps the wrapper and extension aligned without persistent settings.
  return host === "gemini_cli"
    ? join(homedir(), ".trajpack", "runtime")
    : defaultPaths().runtime;
}

export async function runCapture(hostName: string, words: string[], options: CaptureCommandOptions): Promise<number> {
  const host = HOSTS[hostName];
  if (!host) throw new Error(`Unsupported host: ${hostName}`);
  const cwd = resolveCwd(options.cwd ?? process.cwd());
  const maxEvents = captureLimit(options.maxEvents, DEFAULT_MAX_CAPTURE_EVENTS, MAX_CONFIGURABLE_CAPTURE_EVENTS, "--max-events");
  const maxRawBytes = captureLimit(options.maxRawBytes, DEFAULT_MAX_CAPTURE_RAW_BYTES, MAX_CONFIGURABLE_CAPTURE_RAW_BYTES, "--max-raw-bytes");
  const drainMs = captureDrainMs(options.drainMs);
  if (maxEvents < 2 || maxRawBytes < 2) {
    throw new Error("Wrapper capture budgets must be at least 2 so stdout and hook channels each fail closed independently");
  }
  const executable = words[0] ?? DEFAULT_COMMAND[hostName];
  if (!executable) throw new Error(`No executable is configured for host ${hostName}`);
  const args = authoritativeCaptureArguments(host, words.slice(1));
  if (host === "deepseek_harness") assertPinnedDeepSeekHarness(executable, cwd, process.env);
  const resolved = await resolveSourceOptions(host, options);
  const repoCommit = observedRepoCommit(cwd, process.env);
  const manifest = createManifest({
    source: resolved.source,
    accountType: resolved.accountType,
    rights: resolved.rights,
    consentReceipt: consentReceipt(host, cwd),
    consentPurposes: [...new Set(["archive", "research", "capture", ...(options.consentPurpose ?? [])])],
    cwdHmac: privatePathHmac(cwd),
    repoCommit,
    terms: resolved.terms,
    ...(resolved.permissionEvidence === undefined ? {} : { permissionEvidence: resolved.permissionEvidence }),
    ...(options.writtenPermission === undefined ? {} : { writtenPermissionRef: options.writtenPermission }),
    ...(options.targetModelOwner === undefined ? {} : { targetModelOwner: options.targetModelOwner }),
    ...(options.targetProduct === undefined ? {} : { targetProduct: options.targetProduct }),
    ...(options.competitive === undefined ? {} : { competitive: options.competitive }),
    ...(options.region === undefined ? {} : { contractingRegion: options.region }),
  });
  const preflight = evaluateGate({ manifest, raw: [], events: [] }, "automatic_capture");
  if (!preflight.allowed) throw new Error(`Capture blocked by policy: ${preflight.reasonCodes.join(", ")}`);
  let passphrase = await readPassphrase();
  const session = await CaptureSession.create(host, manifest, passphrase, undefined, {
    maxRawEvents: maxEvents,
    maxRawBytes,
  });
  passphrase = "";
  const token = randomBytes(32).toString("base64url");
  let child: ChildProcess | undefined;
  let captureViolation: string | null = null;
  const violate = (reason: string) => {
    if (captureViolation !== null) return;
    captureViolation = reason;
    child?.kill();
  };
  // Wrapper stdout and plugin hooks share the configured capture budget in two
  // conservative channel allocations so their combined worst case remains
  // below the encrypted vault read bound.
  const stdoutMaxEvents = Math.max(1, Math.floor(maxEvents / 2));
  const hookMaxEvents = Math.max(1, maxEvents - stdoutMaxEvents);
  const equalHookBytes = Math.max(1, maxRawBytes - Math.floor(maxRawBytes / 2));
  // A 64 MiB opaque Claude transcript expands to roughly 86 MiB as Base64.
  // Preserve enough hook budget for that documented artifact while keeping
  // the aggregate wrapper budget unchanged.
  const hookMaxBytes = host === "claude_code"
    ? Math.min(maxRawBytes - 1, Math.max(equalHookBytes, 96 * 1024 * 1024))
    : equalHookBytes;
  const stdoutMaxBytes = Math.max(1, maxRawBytes - hookMaxBytes);
  const server = await startIngestServer({
    host,
    token,
    session,
    expectedCwd: cwd,
    maxEvents: hookMaxEvents,
    maxTotalRawBytes: hookMaxBytes,
    onLimitExceeded: violate,
  });
  // Gemini CLI intentionally sanitizes extension environments. Use the same
  // private, cwd-bound descriptor as one-shot arm so the extension can obtain
  // the ephemeral collector capability without a persistent setting or
  // keychain secret. The descriptor is removed when this wrapper exits.
  const wrapperDescriptor = host === "gemini_cli"
    ? join(armRuntimeDirectory(host), `arm-${host}.json`)
    : null;
  let wrapperDescriptorWritten = false;
  let rawSequence = 0;
  let ingestQueue: Promise<unknown> = Promise.resolve();
  try {
    if (wrapperDescriptor !== null) {
      await ensurePrivateRuntimeDirectory(armRuntimeDirectory(host));
      await writeArmDescriptor(wrapperDescriptor, `${canonicalJson({
        version: 1,
        host,
        url: `${server.url}/v1/hooks/events`,
        token,
        cwd,
        expires_at: new Date(Date.now() + 12 * 60 * 60 * 1_000).toISOString(),
      })}\n`);
      wrapperDescriptorWritten = true;
    }
    const childEnvironment = captureChildEnvironment(process.env, {
      url: `${server.url}/v1/hooks/events`,
      token,
      host,
    });
    const launch = captureProcessLaunch(executable, args, cwd, childEnvironment);
    const spawned = spawn(launch.command, launch.args, {
      cwd,
      env: childEnvironment,
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    }) as ChildProcess;
    child = spawned;
    const parse = splitUtf8Lines((line) => {
      const envelope = classifyJsonLine(host, line, rawSequence);
      if (!envelope) return;
      if (rawSequence >= stdoutMaxEvents) {
        violate("CAPTURE_STDOUT_EVENT_LIMIT_EXCEEDED");
        return;
      }
      rawSequence += 1;
      ingestQueue = ingestQueue
        .then(() => session.ingest(envelope))
        .catch((error: unknown) => {
          if (error instanceof CaptureLimitError) violate(error.reason);
          throw error;
        });
    }, { maxLineBytes: 20 * 1024 * 1024, maxTotalBytes: stdoutMaxBytes }, violate);
    let suppressedStderrBytes = 0;
    const stdoutTask = (spawned.stdout
      ? consumeUtf8StreamWithBackpressure(spawned.stdout, parse, () => ingestQueue)
      : Promise.resolve()).catch((error: unknown) => {
      if (error instanceof CaptureLimitError) violate(error.reason);
      else violate("CAPTURE_STORAGE_FAILURE");
      throw error;
    });
    spawned.stderr?.on("data", (chunk: Buffer) => { suppressedStderrBytes += chunk.length; });
    const exitTask = new Promise<number>((resolveExit, reject) => {
      spawned.once("error", reject);
      spawned.once("close", (code: number | null, signal: NodeJS.Signals | null) => resolveExit(code ?? (signal ? 1 : 0)));
    });
    const [exitResult, stdoutResult] = await Promise.allSettled([exitTask, stdoutTask]);
    if (stdoutResult.status === "rejected") {
      if (stdoutResult.reason instanceof CaptureLimitError) violate(stdoutResult.reason.reason);
      else violate("CAPTURE_STORAGE_FAILURE");
      throw stdoutResult.reason;
    }
    if (exitResult.status === "rejected") throw exitResult.reason;
    const exitCode = exitResult.value;
    if (drainMs > 0) await new Promise<void>((resolveDrain) => setTimeout(resolveDrain, drainMs));
    await server.close();
    captureViolation ??= server.limitViolation();
    if (captureViolation !== null) throw new Error(`Capture aborted by hard limit: ${captureViolation}`);
    const bundle = await session.finalize();
    if (suppressedStderrBytes > 0) {
      process.stderr.write(`trajpack: suppressed ${suppressedStderrBytes} bytes of host stderr to avoid plaintext logging\n`);
    }
    process.stderr.write(`trajpack: encrypted trace ${bundle.manifest.trace_id}; review=${bundle.manifest.review.automated_checks}\n`);
    return exitCode;
  } catch (error) {
    await server.close().catch(() => undefined);
    await session.abort();
    throw error;
  } finally {
    if (wrapperDescriptorWritten && wrapperDescriptor !== null) {
      await rm(wrapperDescriptor, { force: true });
    }
  }
}

function parseTtl(value: string): number {
  const match = /^(\d+)(s|m|h)$/.exec(value);
  if (!match) throw new Error("TTL must look like 30s, 10m, or 1h");
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount)) throw new Error("TTL amount is out of range");
  const multiplier = match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000;
  const ttl = amount * multiplier;
  // Bound the product so `new Date(Date.now() + ttl).toISOString()` cannot
  // overflow into an Invalid Date and crash the arm command.
  if (!Number.isSafeInteger(ttl) || ttl < 1_000 || ttl > 24 * 60 * 60 * 1_000) {
    throw new Error("TTL must be between 1s and 24h");
  }
  return ttl;
}

export interface ArmCommandOptions extends SourceCliOptions {
  nextSession?: boolean;
  cwd?: string;
  ttl?: string;
  maxEvents?: string | number;
  maxRawBytes?: string | number;
  drainMs?: string | number;
}

export async function runArm(hostName: string, options: ArmCommandOptions): Promise<void> {
  if (!options.nextSession) throw new Error("v1 requires --next-session");
  const host = HOSTS[hostName];
  if (host !== "codex" && host !== "claude_code" && host !== "gemini_cli") {
    throw new Error("arm supports codex, claude, or gemini");
  }
  const cwd = resolveCwd(options.cwd ?? process.cwd());
  const maxEvents = captureLimit(options.maxEvents, DEFAULT_MAX_CAPTURE_EVENTS, MAX_CONFIGURABLE_CAPTURE_EVENTS, "--max-events");
  const maxRawBytes = captureLimit(options.maxRawBytes, DEFAULT_MAX_CAPTURE_RAW_BYTES, MAX_CONFIGURABLE_CAPTURE_RAW_BYTES, "--max-raw-bytes");
  const drainMs = captureDrainMs(options.drainMs);
  const resolved = await resolveSourceOptions(host, options);
  resolved.source.capture_method = "official_hook";
  resolved.source.fidelity = "B";
  const manifest = createManifest({
    source: resolved.source,
    accountType: resolved.accountType,
    rights: resolved.rights,
    consentReceipt: consentReceipt(host, cwd),
    consentPurposes: [...new Set(["archive", "research", "capture", ...(options.consentPurpose ?? [])])],
    cwdHmac: privatePathHmac(cwd),
    repoCommit: observedRepoCommit(cwd, process.env),
    terms: resolved.terms,
    ...(resolved.permissionEvidence === undefined ? {} : { permissionEvidence: resolved.permissionEvidence }),
    ...(options.writtenPermission === undefined ? {} : { writtenPermissionRef: options.writtenPermission }),
    ...(options.targetModelOwner === undefined ? {} : { targetModelOwner: options.targetModelOwner }),
    ...(options.targetProduct === undefined ? {} : { targetProduct: options.targetProduct }),
    ...(options.competitive === undefined ? {} : { competitive: options.competitive }),
    ...(options.region === undefined ? {} : { contractingRegion: options.region }),
  });
  const preflight = evaluateGate({ manifest, raw: [], events: [] }, "automatic_capture");
  if (!preflight.allowed) throw new Error(`Capture blocked by policy: ${preflight.reasonCodes.join(", ")}`);
  let passphrase = await readPassphrase();
  const session = await CaptureSession.create(host, manifest, passphrase, undefined, {
    maxRawEvents: maxEvents,
    maxRawBytes,
  });
  passphrase = "";
  const token = randomBytes(32).toString("base64url");
  let ended = false;
  let endCapture!: () => void;
  const finished = new Promise<void>((resolveFinished) => { endCapture = resolveFinished; });
  const descriptorRuntime = armRuntimeDirectory(host);
  const descriptor = join(descriptorRuntime, `arm-${host}.json`);
  const ttl = parseTtl(options.ttl ?? "10m");
  let server: Awaited<ReturnType<typeof startIngestServer>> | undefined;
  let descriptorWritten = false;
  let timeout: NodeJS.Timeout | undefined;
  const stop = () => endCapture();
  try {
    server = await startIngestServer({
      host,
      token,
      session,
      expectedCwd: cwd,
      bindNextSession: true,
      onSessionEnd: () => { ended = true; endCapture(); },
      maxEvents,
      maxTotalRawBytes: maxRawBytes,
      onLimitExceeded: () => endCapture(),
    });
    await ensurePrivateRuntimeDirectory(descriptorRuntime);
    await writeArmDescriptor(descriptor, `${canonicalJson({
      version: 1,
      host,
      url: `${server.url}/v1/hooks/events`,
      token,
      cwd,
      expires_at: new Date(Date.now() + ttl).toISOString(),
    })}\n`);
    descriptorWritten = true;
    process.stderr.write(`trajpack: armed ${host} in ${cwd}; waiting up to ${options.ttl ?? "10m"}\n`);
    timeout = setTimeout(endCapture, ttl);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await finished;
    if (drainMs > 0) await new Promise<void>((resolveDrain) => setTimeout(resolveDrain, drainMs));
    // Seal the listener first and wait for requests already in flight. Only
    // then is the hard-limit state stable enough to decide whether publishing
    // the vault is allowed.
    await server.close();
    const limitViolation = server.limitViolation();
    if (limitViolation !== null) throw new Error(`Capture aborted by hard limit: ${limitViolation}`);
    const bundle = await session.finalize();
    process.stderr.write(`trajpack: encrypted trace ${bundle.manifest.trace_id}; ended=${ended}; review=${bundle.manifest.review.automated_checks}\n`);
  } catch (error) {
    await session.abort();
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await server?.close().catch(() => undefined);
    if (descriptorWritten) await rm(descriptor, { force: true });
  }
}
