import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDoctorReport, formatDoctorReport, inspectDshProfile, probeExecutable } from "./doctor.js";

describe("trajpack doctor", () => {
  it("resolves the current Node executable through platform shims", () => {
    expect(probeExecutable("node")).toMatchObject({ found: true });
    expect(probeExecutable("node").version).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it("reports each native surface without claiming that executable discovery proves plugin installation", () => {
    const report = collectDoctorReport((executable) => ({
      found: executable !== "claude",
      version: executable === "dsh" ? "0.1.0-rc.5" : executable === "claude" ? null : "1.2.3",
    }), new Date("2026-08-17T00:00:00.000Z"), (profile) => ({
      profile,
      plugin_installation: "manifest_verified",
      harness_version: "0.1.0-rc.6",
    }));
    expect(report.native_agents.map((agent) => [agent.id, agent.compatibility])).toEqual([
      ["codex", "available"],
      ["claude", "missing_executable"],
      ["gemini", "available"],
      ["dsh", "version_mismatch"],
    ]);
    expect(report.web_and_imports.every((entry) => entry.automatic_commercial_dom_capture === false)).toBe(true);
    expect(report.web_and_imports).toContainEqual(expect.objectContaining({
      product: "DeepSeek Harness session",
      fidelity: "B",
    }));
    expect(report.native_agents.find((entry) => entry.id === "dsh")?.plugin_installation).toBe("manifest_verified");
    expect(report.native_agents.filter((entry) => entry.id !== "dsh")
      .every((entry) => entry.plugin_installation === "not_checked")).toBe(true);
    expect(report.boundaries.join(" ")).toContain("does not prove");
    expect(report.boundaries.join(" ")).toContain("not provider authentication");
    expect(formatDoctorReport(report)).toContain("official/manual import only");

    const profileOnly = collectDoctorReport(
      () => ({ found: false, version: null }),
      new Date("2026-08-17T00:00:00.000Z"),
      (profile) => ({
        profile,
        plugin_installation: "manifest_verified",
        harness_version: "0.1.0-rc.6",
      }),
    );
    expect(profileOnly.native_agents.find((entry) => entry.id === "dsh")?.compatibility)
      .toBe("available_via_profile");
  });

  it("verifies a pinned DSH profile from bounded manifests without booting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-doctor-dsh-"));
    try {
      const profile = join(root, "profiles", "research");
      await mkdir(join(profile, "node_modules", "@trajpack", "deepseek-harness-plugin"), { recursive: true });
      await mkdir(join(root, "profiles", "node_modules", "@deepseek-ai", "dsh"), { recursive: true });
      await writeFile(join(profile, "package.json"), JSON.stringify({
        dependencies: { "@trajpack/deepseek-harness-plugin": "link:fixture" },
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@trajpack/deepseek-harness-plugin"] } },
      }));
      await writeFile(join(profile, "node_modules", "@trajpack", "deepseek-harness-plugin", "package.json"), JSON.stringify({
        name: "@trajpack/deepseek-harness-plugin",
        trajpack: { deepseekHarnessVersion: "0.1.0-rc.6" },
      }));
      const runtimeManifest = join(root, "profiles", "node_modules", "@deepseek-ai", "dsh", "package.json");
      await writeFile(runtimeManifest, JSON.stringify({ version: "0.1.0-rc.6" }));
      expect(inspectDshProfile("research", root)).toEqual({
        profile: "research",
        plugin_installation: "manifest_verified",
        harness_version: "0.1.0-rc.6",
      });
      await writeFile(runtimeManifest, JSON.stringify({ version: "0.1.0-rc.7" }));
      expect(inspectDshProfile("research", root).plugin_installation).toBe("version_mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
