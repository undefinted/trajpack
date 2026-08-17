import { execFile } from "node:child_process";
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
