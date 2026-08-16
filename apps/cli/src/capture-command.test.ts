import { describe, expect, it } from "vitest";

import {
  authoritativeCaptureArguments,
  assertDeepSeekHarnessVersionReport,
  captureChildEnvironment,
  observedRepoCommit,
  scrubHostEnvironment,
} from "./capture-command.js";

describe("capture child environment", () => {
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
});
