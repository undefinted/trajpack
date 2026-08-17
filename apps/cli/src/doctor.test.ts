import { describe, expect, it } from "vitest";
import { collectDoctorReport, formatDoctorReport, probeExecutable } from "./doctor.js";

describe("trajpack doctor", () => {
  it("resolves the current Node executable through platform shims", () => {
    expect(probeExecutable("node")).toMatchObject({ found: true });
    expect(probeExecutable("node").version).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it("reports each native surface without claiming that executable discovery proves plugin installation", () => {
    const report = collectDoctorReport((executable) => ({
      found: executable !== "claude",
      version: executable === "dsh" ? "0.1.0-rc.5" : executable === "claude" ? null : "1.2.3",
    }), new Date("2026-08-17T00:00:00.000Z"));
    expect(report.native_agents.map((agent) => [agent.id, agent.compatibility])).toEqual([
      ["codex", "available"],
      ["claude", "missing_executable"],
      ["gemini", "available"],
      ["dsh", "version_mismatch"],
    ]);
    expect(report.web_and_imports.every((entry) => entry.automatic_commercial_dom_capture === false)).toBe(true);
    expect(report.native_agents.every((entry) => entry.plugin_installation === "not_verified")).toBe(true);
    expect(report.boundaries.join(" ")).toContain("does not prove");
    expect(formatDoctorReport(report)).toContain("official/manual import only");
  });
});
