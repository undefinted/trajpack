import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

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
  }, 20_000);
});
