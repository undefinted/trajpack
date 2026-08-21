import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  authoritativeCaptureArguments,
  armRuntimeDirectory,
  assertDeepSeekHarnessVersionReport,
  captureChildEnvironment,
  captureProcessLaunch,
  consumeUtf8StreamWithBackpressure,
  splitUtf8Lines,
  observedRepoCommit,
  scrubHostEnvironment,
  windowsBatchLaunch,
} from "./capture-command.js";

describe("capture child environment", () => {
  it("uses a home-relative Gemini arm path that survives extension environment sanitization", () => {
    expect(armRuntimeDirectory("gemini_cli")).toBe(join(homedir(), ".trajpack", "runtime"));
  });

  it("removes the vault passphrase before injecting one-time collector credentials", () => {
    const base = {
      PATH: "test-path",
      TRAJPACK_PASSPHRASE: "must-not-reach-host",
      TRAJPACK_COLLECTOR_URL: "http://127.0.0.1:1/stale",
      TRAJPACK_CAPTURE_TOKEN: "stale-token",
      TRAJPACK_CAPTURE_HOST: "claude_code",
    } satisfies NodeJS.ProcessEnv;

    const child = captureChildEnvironment(base, {
      url: "http://127.0.0.1:34567/v1/hooks/events",
      token: "one-time-token",
      host: "codex",
    });

    expect(child).toEqual({
      PATH: "test-path",
      TRAJPACK_COLLECTOR_URL: "http://127.0.0.1:34567/v1/hooks/events",
      TRAJPACK_CAPTURE_TOKEN: "one-time-token",
      TRAJPACK_CAPTURE_HOST: "codex",
    });
    expect(base.TRAJPACK_PASSPHRASE).toBe("must-not-reach-host");
  });

  it("removes stale collector capabilities from non-capture probes", () => {
    expect(scrubHostEnvironment({
      PATH: "test-path",
      TRAJPACK_PASSPHRASE: "secret",
      TRAJPACK_COLLECTOR_URL: "http://127.0.0.1:1",
      TRAJPACK_CAPTURE_TOKEN: "token",
      TRAJPACK_CAPTURE_HOST: "codex",
    })).toEqual({ PATH: "test-path" });
  });

  it("accepts only the pinned DeepSeek Harness release report", () => {
    expect(() => assertDeepSeekHarnessVersionReport("dsh 0.1.0-rc.6", 0)).not.toThrow();
    expect(() => assertDeepSeekHarnessVersionReport("dsh 0.1.0-rc.5", 0)).toThrow("expected exact 0.1.0-rc.6");
    expect(() => assertDeepSeekHarnessVersionReport("dsh 0.1.0-rc.6", 1)).toThrow("compatibility check failed");
  });

  it("uses a fixed command processor contract only for allowlisted Windows shims", () => {
    const launch = windowsBatchLaunch("dsh.cmd", [
      "--prompt",
      "literal & whoami | echo %PATH% ^ !value!",
      "quote\"inside",
    ], { ComSpec: "C:\\Windows\\System32\\cmd.exe" });

    expect(launch).toMatchObject({
      command: "C:\\Windows\\System32\\cmd.exe",
      windowsVerbatimArguments: true,
      resolvedExecutable: "dsh.cmd",
      viaCommandProcessor: true,
    });
    expect(launch.args.slice(0, 4)).toEqual(["/d", "/v:off", "/s", "/c"]);
    expect(launch.args[4]).toContain("^^^&");
    expect(launch.args[4]).toContain("^^^|");
    expect(launch.args[4]).not.toContain(" & whoami ");
    expect(() => windowsBatchLaunch("arbitrary.cmd", ["safe"])).toThrow("restricted");
    expect(() => windowsBatchLaunch("dsh.cmd", ["safe\r\necho injected"])).toThrow("control characters");
  });

  it("keeps non-Windows capture launches shell-free", () => {
    expect(captureProcessLaunch("claude", ["--print", "hello & goodbye"], process.cwd(), {}, "linux"))
      .toEqual({
        command: "claude",
        args: ["--print", "hello & goodbye"],
        windowsVerbatimArguments: false,
        resolvedExecutable: "claude",
        viaCommandProcessor: false,
      });
  });

  it.skipIf(process.platform !== "win32")(
    "passes metacharacters literally through a real allowlisted Windows .cmd shim",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "trajpack-capture-shim-"));
      const shim = join(directory, "dsh.cmd");
      const output = join(directory, "argv.json");
      const sentinel = join(directory, "PWNED.txt");
      const argumentsToPreserve = [
        output,
        "plain argument",
        "alpha & echo injected>PWNED.txt",
        "%PATH%",
        "caret^value",
        "bang!value!",
        "quote\"inside",
        "(parenthesized)|pipe",
      ];
      const node = process.execPath.replace(/"/gu, "\"\"");
      const script = [
        "@echo off",
        `@\"${node}\" -e \"require('fs').writeFileSync(process.argv[1],JSON.stringify(process.argv.slice(2)),'utf8')\" %*`,
        "",
      ].join("\r\n");
      try {
        await writeFile(shim, script, { encoding: "utf8", flag: "wx" });
        const launch = captureProcessLaunch(shim, argumentsToPreserve, directory, process.env);
        const result = spawnSync(launch.command, launch.args, {
          cwd: directory,
          env: process.env,
          encoding: "utf8",
          shell: false,
          windowsHide: true,
          windowsVerbatimArguments: launch.windowsVerbatimArguments,
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
        expect(JSON.parse(await readFile(output, "utf8"))).toEqual(argumentsToPreserve.slice(1));
        await expect(stat(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("forces authoritative Codex and Claude structured streams", () => {
    expect(authoritativeCaptureArguments("codex", ["exec", "fix tests"]))
      .toEqual(["exec", "fix tests", "--json"]);
    expect(() => authoritativeCaptureArguments("codex", ["fix tests"]))
      .toThrow("codex exec --json");
    expect(authoritativeCaptureArguments("claude_code", ["fix tests"]))
      .toEqual(["--print", "fix tests", "--output-format", "stream-json", "--verbose"]);
    expect(() => authoritativeCaptureArguments("claude_code", ["--output-format", "json"]))
      .toThrow("requires --output-format stream-json");
  });

  it("records only a validated Git object id", () => {
    const commit = observedRepoCommit(process.cwd(), process.env);
    expect(commit === null || /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commit)).toBe(true);
  });

  it("decodes UTF-8 correctly when a multibyte character crosses stdout chunks", () => {
    const lines: string[] = [];
    const violations: string[] = [];
    const expected = '{"type":"message","text":"跨块中文🙂"}';
    const bytes = Buffer.from(`${expected}\n`, "utf8");
    const emojiStart = bytes.indexOf(Buffer.from("🙂", "utf8"));
    const splitter = splitUtf8Lines(
      (line) => lines.push(line),
      { maxLineBytes: 1024, maxTotalBytes: 4096 },
      (reason) => violations.push(reason),
    );

    splitter.push(bytes.subarray(0, emojiStart + 2));
    splitter.push(bytes.subarray(emojiStart + 2));
    splitter.flush();

    expect(lines).toEqual([expected]);
    expect(violations).toEqual([]);
  });

  it("applies the stdout line bound per decoded line rather than per chunk", () => {
    const lines: string[] = [];
    const violations: string[] = [];
    const splitter = splitUtf8Lines(
      (line) => lines.push(line),
      { maxLineBytes: 4, maxTotalBytes: 64 },
      (reason) => violations.push(reason),
    );
    splitter.push(Buffer.from("one\ntwo\n", "utf8"));
    splitter.flush();
    expect(lines).toEqual(["one", "two"]);
    expect(violations).toEqual([]);
  });

  it("does not pull the next stdout chunk until current lines are durably ingested", async () => {
    const lines: string[] = [];
    let releaseFirst!: () => void;
    let observeFirst!: () => void;
    const firstObserved = new Promise<void>((resolve) => { observeFirst = resolve; });
    let ingestQueue: Promise<void> = Promise.resolve();
    let requestedSecondChunk = false;
    const splitter = splitUtf8Lines((line) => {
      lines.push(line);
      if (lines.length === 1) {
        ingestQueue = new Promise<void>((resolve) => { releaseFirst = resolve; });
        observeFirst();
      } else {
        ingestQueue = Promise.resolve();
      }
    }, { maxLineBytes: 1024, maxTotalBytes: 4096 }, (reason) => {
      throw new Error(reason);
    });
    async function* fastProducer(): AsyncGenerator<Buffer> {
      yield Buffer.from("first\n", "utf8");
      requestedSecondChunk = true;
      yield Buffer.from("second\n", "utf8");
    }

    const consuming = consumeUtf8StreamWithBackpressure(fastProducer(), splitter, () => ingestQueue);
    await firstObserved;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requestedSecondChunk).toBe(false);
    releaseFirst();
    await consuming;
    expect(requestedSecondChunk).toBe(true);
    expect(lines).toEqual(["first", "second"]);
  });
});
