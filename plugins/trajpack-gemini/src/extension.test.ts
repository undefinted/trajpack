import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const FORWARDER = fileURLToPath(new URL("../scripts/forward-hook.mjs", import.meta.url));
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function isolatedEnvironment(): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(join(tmpdir(), "trajpack-gemini-extension-test-"));
  temporaryRoots.push(root);
  const environment = { ...process.env };
  delete environment.TRAJPACK_CAPTURE_TOKEN;
  delete environment.TRAJPACK_COLLECTOR_URL;
  environment.HOME = root;
  environment.USERPROFILE = root;
  return environment;
}

function runtimeDirectory(environment: NodeJS.ProcessEnv): string {
  return join(process.platform === "win32" ? environment.USERPROFILE! : environment.HOME!, ".trajpack", "runtime");
}

function runForwarder(
  environment: NodeJS.ProcessEnv,
  payload: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [FORWARDER], { env: environment, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("exit", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
    child.stdin.end(JSON.stringify(payload));
  });
}

describe("Gemini CLI extension", () => {
  it("uses the official root manifest and documented hook vocabulary", async () => {
    const manifest = JSON.parse(await readFile(join(ROOT, "gemini-extension.json"), "utf8")) as Record<string, unknown>;
    const hooks = JSON.parse(await readFile(join(ROOT, "hooks", "hooks.json"), "utf8")) as {
      hooks: Record<string, unknown>;
    };
    expect(manifest).toMatchObject({ name: "trajpack-gemini", version: "0.1.0" });
    expect(manifest).not.toHaveProperty("hooks");
    expect(Object.keys(hooks.hooks).sort()).toEqual([
      "AfterAgent",
      "AfterModel",
      "AfterTool",
      "BeforeAgent",
      "BeforeModel",
      "BeforeTool",
      "BeforeToolSelection",
      "Notification",
      "PreCompress",
      "SessionEnd",
      "SessionStart",
    ]);
  });

  it("is a silent content no-op when not explicitly armed", async () => {
    const environment = await isolatedEnvironment();
    const secret = "UNARMED_PROMPT_MUST_NOT_BE_WRITTEN";
    const result = spawnSync(process.execPath, [FORWARDER], {
      env: environment,
      input: JSON.stringify({ hook_event_name: "BeforeAgent", cwd: process.cwd(), prompt: secret }),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe('{"suppressOutput":true}\n');
    await expect(readFile(join(runtimeDirectory(environment), "content-spool"), "utf8")).rejects.toThrow();
  });

  it("forwards an armed record only to the authenticated loopback endpoint", async () => {
    const environment = await isolatedEnvironment();
    let finishChild!: (value: { stdout: string; stderr: string; code: number | null }) => void;
    const childDone = new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
      finishChild = resolve;
    });
    const received = new Promise<{ headers: Record<string, string | string[] | undefined>; body: string }>((resolve) => {
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          response.writeHead(204);
          response.end();
          resolve({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
          server.close();
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("unexpected server address");
        environment.TRAJPACK_COLLECTOR_URL = `http://127.0.0.1:${address.port}/ingest`;
        environment.TRAJPACK_CAPTURE_TOKEN = "one-session-token";
        const child = spawn(process.execPath, [FORWARDER], { env: environment, stdio: ["pipe", "pipe", "pipe"] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.on("exit", (code) => {
          finishChild({
            code,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        });
        child.stdin.end(JSON.stringify({
          session_id: "gemini-session",
          hook_event_name: "BeforeTool",
          cwd: process.cwd(),
          tool_name: "read_file",
          tool_input: { path: "README.md" },
        }));
      });
    });

    const request = await received;
    const result = await childDone;
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe('{"suppressOutput":true}\n');
    expect(request.headers.authorization).toBe("Bearer one-session-token");
    expect(request.headers["x-trajpack-host"]).toBe("gemini_cli");
    expect(request.headers["x-trajpack-interface"]).toBe("gemini-cli-hook/1");
    expect(JSON.parse(request.body)).toMatchObject({ hook_event_name: "BeforeTool", tool_name: "read_file" });
  });

  it("uses the private cwd-bound arm descriptor when Gemini sanitizes extension env", async () => {
    const environment = await isolatedEnvironment();
    delete environment.TRAJPACK_CAPTURE_TOKEN;
    delete environment.TRAJPACK_COLLECTOR_URL;
    const runtime = runtimeDirectory(environment);
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(runtime, 0o700);

    let requests = 0;
    let resolveFirst!: (value: { authorization: string | null; body: string }) => void;
    const firstRequest = new Promise<{ authorization: string | null; body: string }>((resolve) => {
      resolveFirst = resolve;
    });
    const server = createServer((request, response) => {
      requests += 1;
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        response.writeHead(204);
        response.end();
        if (requests === 1) resolveFirst({
          authorization: request.headers.authorization ?? null,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("unexpected server address");
    const descriptor = join(runtime, "arm-gemini_cli.json");
    await writeFile(descriptor, JSON.stringify({
      version: 1,
      host: "gemini_cli",
      url: `http://127.0.0.1:${address.port}/v1/hooks/events`,
      token: "descriptor-token",
      cwd: process.cwd(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(descriptor, 0o600);

    const matching = await runForwarder(environment, {
      session_id: "gemini-descriptor-session",
      hook_event_name: "BeforeAgent",
      cwd: process.cwd(),
      prompt: "visible prompt",
    });
    const received = await firstRequest;
    expect(matching).toEqual({ code: 0, stderr: "", stdout: '{"suppressOutput":true}\n' });
    expect(received.authorization).toBe("Bearer descriptor-token");
    expect(JSON.parse(received.body)).toMatchObject({ hook_event_name: "BeforeAgent" });

    const mismatched = await runForwarder(environment, {
      session_id: "gemini-other-cwd",
      hook_event_name: "BeforeAgent",
      cwd: join(process.cwd(), "not-the-armed-workspace"),
      prompt: "must not forward",
    });
    expect(mismatched).toEqual({ code: 0, stderr: "", stdout: '{"suppressOutput":true}\n' });
    expect(requests).toBe(1);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
});
