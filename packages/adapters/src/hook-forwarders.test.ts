import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

interface Forwarder {
  host: "codex" | "claude_code" | "gemini_cli";
  path: string;
  stdout: string;
}

const FORWARDERS: Forwarder[] = [
  {
    host: "codex",
    path: fileURLToPath(new URL("../../../plugins/trajpack/scripts/forward-hook.mjs", import.meta.url)),
    stdout: "",
  },
  {
    host: "claude_code",
    path: fileURLToPath(new URL("../../../plugins/claude-code/scripts/forward-hook.mjs", import.meta.url)),
    stdout: "",
  },
  {
    host: "gemini_cli",
    path: fileURLToPath(new URL("../../../plugins/trajpack-gemini/scripts/forward-hook.mjs", import.meta.url)),
    stdout: '{"suppressOutput":true}\n',
  },
];

const temporaryRoots: string[] = [];
const serverClosers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(serverClosers.splice(0).map((close) => close()));
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function isolatedEnvironment(): Promise<{ environment: NodeJS.ProcessEnv; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "trajpack-hook-forwarder-test-"));
  temporaryRoots.push(root);
  const environment = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    LOCALAPPDATA: join(root, "local-app-data"),
    XDG_RUNTIME_DIR: join(root, "xdg-runtime"),
  };
  delete environment.TRAJPACK_CAPTURE_TOKEN;
  delete environment.TRAJPACK_COLLECTOR_URL;
  return { environment, root };
}

function runForwarder(
  forwarder: Forwarder,
  environment: NodeJS.ProcessEnv,
  payload: Record<string, unknown>,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [forwarder.path], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    const stdout: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({
      code,
      stderr: Buffer.concat(stderr).toString("utf8"),
      stdout: Buffer.concat(stdout).toString("utf8"),
    }));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function listeningServer(status: number): Promise<{
  close: () => Promise<void>;
  requests: () => number;
  url: string;
}> {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    request.resume();
    response.setHeader("location", "/redirect-target");
    response.writeHead(status, { "content-type": "text/plain" });
    response.end("COLLECTOR_RESPONSE_BODY_MUST_NOT_BE_LOGGED");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("unexpected server address");
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await closeServer(server);
  };
  serverClosers.push(close);
  return {
    close,
    requests: () => requestCount,
    url: `http://127.0.0.1:${address.port}/v1/hooks/events`,
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function runtimeDirectory(forwarder: Forwarder, environment: NodeJS.ProcessEnv): string {
  if (forwarder.host === "gemini_cli") return join(environment.HOME!, ".trajpack", "runtime");
  if (process.platform === "win32") return join(environment.LOCALAPPDATA!, "trajpack", "runtime");
  return join(environment.XDG_RUNTIME_DIR!, `trajpack-${process.getuid?.() ?? "user"}`);
}

async function assertNoCapturedContent(root: string, marker: string): Promise<void> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    expect(await readFile(path, "utf8")).not.toContain(marker);
  }
}

describe("native hook forwarders", () => {
  it.each(FORWARDERS)("keeps $host unarmed capture silent and content-free", async (forwarder) => {
    const { environment, root } = await isolatedEnvironment();
    const marker = `UNARMED_${forwarder.host}_CONTENT`;

    const result = await runForwarder(forwarder, environment, {
      cwd: process.cwd(),
      hook_event_name: "UserPromptSubmit",
      prompt: marker,
    });

    expect(result).toEqual({ code: 0, stderr: "", stdout: forwarder.stdout });
    await assertNoCapturedContent(root, marker);
  });

  it.each(FORWARDERS)("keeps $host collector-offline capture a silent no-op", async (forwarder) => {
    const { environment, root } = await isolatedEnvironment();
    const closedServer = await listeningServer(204);
    const url = closedServer.url;
    await closedServer.close();
    environment.TRAJPACK_COLLECTOR_URL = url;
    environment.TRAJPACK_CAPTURE_TOKEN = "one-session-token";
    const marker = `OFFLINE_${forwarder.host}_CONTENT`;

    const result = await runForwarder(forwarder, environment, {
      cwd: process.cwd(),
      hook_event_name: "UserPromptSubmit",
      prompt: marker,
    });

    expect(result).toEqual({ code: 0, stderr: "", stdout: forwarder.stdout });
    await assertNoCapturedContent(root, marker);
  });

  it.each(FORWARDERS)("keeps $host expired arms silent and does not forward or spool", async (forwarder) => {
    const { environment, root } = await isolatedEnvironment();
    const collector = await listeningServer(204);
    const runtime = runtimeDirectory(forwarder, environment);
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(runtime, 0o700);
    const descriptor = join(runtime, `arm-${forwarder.host}.json`);
    await writeFile(descriptor, JSON.stringify({
      version: 1,
      host: forwarder.host,
      url: collector.url,
      token: "expired-token",
      cwd: process.cwd(),
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    }), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(descriptor, 0o600);
    const marker = `EXPIRED_${forwarder.host}_CONTENT`;

    const result = await runForwarder(forwarder, environment, {
      cwd: process.cwd(),
      hook_event_name: "UserPromptSubmit",
      prompt: marker,
    });

    expect(result).toEqual({ code: 0, stderr: "", stdout: forwarder.stdout });
    expect(collector.requests()).toBe(0);
    await assertNoCapturedContent(root, marker);
    await collector.close();
  });

  it.each(FORWARDERS)("accepts a successful $host collector response", async (forwarder) => {
    const { environment } = await isolatedEnvironment();
    const collector = await listeningServer(204);
    environment.TRAJPACK_COLLECTOR_URL = collector.url;
    environment.TRAJPACK_CAPTURE_TOKEN = "one-session-token";

    const result = await runForwarder(forwarder, environment, {
      cwd: process.cwd(),
      hook_event_name: "SessionStart",
    });

    expect(result).toEqual({ code: 0, stderr: "", stdout: forwarder.stdout });
    expect(collector.requests()).toBe(1);
    await collector.close();
  });

  it.each(FORWARDERS)("signals a non-2xx $host collector response without leaking content", async (forwarder) => {
    const { environment, root } = await isolatedEnvironment();
    const collector = await listeningServer(409);
    environment.TRAJPACK_COLLECTOR_URL = collector.url;
    environment.TRAJPACK_CAPTURE_TOKEN = "one-session-token";
    const marker = `REJECTED_${forwarder.host}_CONTENT`;

    const result = await runForwarder(forwarder, environment, {
      cwd: process.cwd(),
      hook_event_name: "UserPromptSubmit",
      prompt: marker,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe(forwarder.stdout);
    expect(result.stderr).toBe(`trajpack ${forwarder.host} hook: collector rejected the event with HTTP 409\n`);
    expect(result.stderr).not.toContain(marker);
    expect(result.stderr).not.toContain("COLLECTOR_RESPONSE_BODY_MUST_NOT_BE_LOGGED");
    expect(collector.requests()).toBe(1);
    await assertNoCapturedContent(root, marker);
    await collector.close();
  });

  it.each(FORWARDERS)("does not follow a rejecting $host collector redirect", async (forwarder) => {
    const { environment } = await isolatedEnvironment();
    const collector = await listeningServer(302);
    environment.TRAJPACK_COLLECTOR_URL = collector.url;
    environment.TRAJPACK_CAPTURE_TOKEN = "one-session-token";

    const result = await runForwarder(forwarder, environment, {
      cwd: process.cwd(),
      hook_event_name: "SessionStart",
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe(forwarder.stdout);
    expect(result.stderr).toContain("HTTP 302");
    expect(collector.requests()).toBe(1);
    await collector.close();
  });
});
