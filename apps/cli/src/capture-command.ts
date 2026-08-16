import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
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
import { CaptureSession } from "./capture-session.js";
import { startIngestServer } from "./ingest-server.js";
import { readPassphrase } from "./secret.js";
import { resolveSourceOptions, type SourceCliOptions } from "./source-options.js";

const HOSTS: Record<string, Host> = {
  codex: "codex",
  claude: "claude_code",
  dsh: "deepseek_harness",
};

const DEFAULT_COMMAND: Record<string, string> = { codex: "codex", claude: "claude", dsh: "dsh" };

export interface CaptureCommandOptions extends SourceCliOptions {
  cwd?: string;
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
  const result = spawnSync(executable, ["--version"], {
    cwd,
    env: scrubHostEnvironment(environment),
    encoding: "utf8",
    windowsHide: true,
    shell: false,
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

function splitLines(onLine: (line: string) => void): { push(chunk: Buffer): void; flush(): void } {
  let pending = "";
  const drain = () => {
    if (pending.trim()) onLine(pending.replace(/\r$/, ""));
    pending = "";
  };
  return { push: (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      if (line.trim()) onLine(line);
    }
  }, flush: drain };
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

export async function runCapture(hostName: string, words: string[], options: CaptureCommandOptions): Promise<number> {
  const host = HOSTS[hostName];
  if (!host) throw new Error(`Unsupported host: ${hostName}`);
  const cwd = resolve(options.cwd ?? process.cwd());
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
  const session = await CaptureSession.create(host, manifest, passphrase);
  passphrase = "";
  const token = randomBytes(32).toString("base64url");
  const server = await startIngestServer({ host, token, session, expectedCwd: cwd });
  let rawSequence = 0;
  let ingestQueue: Promise<unknown> = Promise.resolve();
  try {
    const child = spawn(executable, args, {
      cwd,
      env: captureChildEnvironment(process.env, {
        url: `${server.url}/v1/hooks/events`,
        token,
        host,
      }),
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    }) as ChildProcess;
    const parse = splitLines((line) => {
      const envelope = classifyJsonLine(host, line, rawSequence++);
      if (envelope) ingestQueue = ingestQueue.then(() => session.ingest(envelope));
    });
    let suppressedStderrBytes = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      parse.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => { suppressedStderrBytes += chunk.length; });
    const exitCode = await new Promise<number>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (code: number | null, signal: NodeJS.Signals | null) => resolveExit(code ?? (signal ? 1 : 0)));
    });
    parse.flush();
    await ingestQueue;
    await server.close();
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
  }
}

function parseTtl(value: string): number {
  const match = /^(\d+)(s|m|h)$/.exec(value);
  if (!match) throw new Error("TTL must look like 30s, 10m, or 1h");
  const amount = Number(match[1]);
  const multiplier = match[2] === "s" ? 1_000 : match[2] === "m" ? 60_000 : 3_600_000;
  return amount * multiplier;
}

export interface ArmCommandOptions extends SourceCliOptions {
  nextSession?: boolean;
  cwd?: string;
  ttl?: string;
}

export async function runArm(hostName: string, options: ArmCommandOptions): Promise<void> {
  if (!options.nextSession) throw new Error("v1 requires --next-session");
  const host = HOSTS[hostName];
  if (host !== "codex" && host !== "claude_code") throw new Error("arm supports codex or claude");
  const cwd = resolve(options.cwd ?? process.cwd());
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
  const session = await CaptureSession.create(host, manifest, passphrase);
  passphrase = "";
  const token = randomBytes(32).toString("base64url");
  let ended = false;
  let endCapture!: () => void;
  const finished = new Promise<void>((resolveFinished) => { endCapture = resolveFinished; });
  const paths = defaultPaths();
  const descriptor = join(paths.runtime, `arm-${host}.json`);
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
    });
    await ensurePrivateRuntimeDirectory(paths.runtime);
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
