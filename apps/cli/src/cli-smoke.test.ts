import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_CAPTURE_EVENTS, DEFAULT_MAX_CAPTURE_RAW_BYTES } from "./ingest-server.js";

const execFileAsync = promisify(execFile);

describe("CLI bootstrap", () => {
  it("constructs the structured capture command and prints help", async () => {
    const packageRoot = new URL("..", import.meta.url);
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      "src/index.ts",
      "--help",
    ], {
      cwd: packageRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    expect(stderr).toBe("");
    expect(stdout).toContain("capture [options] <host> [command...]");
    expect(stdout).toContain("policy");
    expect(stdout).toContain("dataset");
  }, 20_000);

  it("reports the collector-backed capture defaults for wrapper and armed modes", async () => {
    const packageRoot = new URL("..", import.meta.url);
    const invokeHelp = (command: "capture" | "arm") => execFileAsync(process.execPath, [
      "--import",
      "tsx",
      "src/index.ts",
      command,
      "--help",
    ], {
      cwd: packageRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    const [capture, arm] = await Promise.all([invokeHelp("capture"), invokeHelp("arm")]);
    for (const result of [capture, arm]) {
      expect(result.stderr).toBe("");
      const compactHelp = result.stdout.replace(/\s+/gu, " ");
      expect(compactHelp).toContain(`default: "${DEFAULT_MAX_CAPTURE_EVENTS}"`);
      expect(compactHelp).toContain(`default: "${DEFAULT_MAX_CAPTURE_RAW_BYTES}"`);
    }
    expect(capture.stdout).toContain("--receipt <new-json-file>");
    expect(capture.stdout.replace(/\s+/gu, " ")).toContain("content-free terminal capture receipt");
    expect(arm.stdout).not.toContain("--receipt");
  }, 20_000);

  it("parses trajpack options after the host and stops a pinned DSH launch at policy preflight", async () => {
    const packageRoot = new URL("..", import.meta.url);
    const dshHome = await mkdtemp(join(tmpdir(), "trajpack-cli-dsh-"));
    const packageDirectory = join(dshHome, "profiles", "node_modules", "@deepseek-ai", "dsh");
    const marker = join(dshHome, "host-ran.txt");
    try {
      await mkdir(join(packageDirectory, "lib"), { recursive: true });
      await writeFile(join(packageDirectory, "package.json"), JSON.stringify({
        name: "@deepseek-ai/dsh",
        version: "0.1.0-rc.6",
        type: "module",
        bin: { dsh: "lib/bin.js" },
      }));
      await writeFile(join(packageDirectory, "lib", "bin.js"), [
        "import { writeFileSync } from 'node:fs';",
        "if (process.argv[2] === '--version') process.stdout.write('0.1.0-rc.6\\n');",
        "else writeFileSync(process.env.TRAJPACK_TEST_HOST_MARKER, 'ran', 'utf8');",
        "",
      ].join("\n"));

      let failure: unknown;
      try {
        await execFileAsync(process.execPath, [
          "--import",
          "tsx",
          "src/index.ts",
          "capture",
          "dsh",
          "--provider",
          "deepseek",
          "--account-type",
          "api",
          "--model",
          "deepseek-chat",
          "--interface-version",
          "deepseek-harness@0.1.0-rc.6/session-event/0",
          "--origin",
          "https://api.deepseek.com",
          "--input-rights",
          "owned",
          "--third-party",
          "none",
          "--source-license",
          "Apache-2.0",
          "--rights-holder",
          "local-researcher",
          "--",
          "dsh",
          "task-that-must-not-run",
        ], {
          cwd: packageRoot,
          encoding: "utf8",
          windowsHide: true,
          env: { ...process.env, DSH_HOME: dshHome, TRAJPACK_TEST_HOST_MARKER: marker },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        stderr: expect.stringContaining("Capture blocked by policy"),
      });
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(dshHome, { recursive: true, force: true });
    }
  }, 20_000);

  it("requires a real evidence file for policy overrides", async () => {
    const packageRoot = new URL("..", import.meta.url);
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      "--import",
      "tsx",
      "src/index.ts",
      "policy",
      "override",
      "--help",
    ], {
      cwd: packageRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    expect(stderr).toBe("");
    expect(stdout).toContain("--evidence-kind <kind>");
    expect(stdout).toContain("--evidence-file <path>");
    expect(stdout).not.toContain("--evidence <reference>");
  }, 20_000);

  it("keeps research safety boundaries visible in command help", async () => {
    const packageRoot = new URL("..", import.meta.url);
    const invokeHelp = (...command: string[]) => execFileAsync(process.execPath, [
      "--import",
      "tsx",
      "src/index.ts",
      ...command,
      "--help",
    ], {
      cwd: packageRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    const [root, imported, validate, plan, exported] = await Promise.all([
      invokeHelp(),
      invokeHelp("import"),
      invokeHelp("validate"),
      invokeHelp("dataset", "plan"),
      invokeHelp("export"),
    ]);
    for (const result of [root, imported, validate, plan, exported]) expect(result.stderr).toBe("");
    const compact = (value: string) => value.replace(/\s+/gu, " ");
    expect(compact(root.stdout)).toContain("capture/import -> policy explain -> review -> dataset plan -> export -> validate");
    expect(compact(imported.stdout)).toContain("recognized shape is not provider authentication");
    expect(compact(imported.stdout)).toContain("lineage-only permission reference; does not clear a gate");
    expect(compact(validate.stdout)).toContain("does not re-open managed vaults or attest current training authorization");
    expect(compact(plan.stdout)).toContain("--group-map must cover every selected");
    expect(compact(exported.stdout)).toContain("dataset build freezes its mode");
  }, 30_000);
});
