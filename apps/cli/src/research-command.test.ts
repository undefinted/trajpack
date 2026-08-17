import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  derive: vi.fn(),
  rows: vi.fn(),
  load: vi.fn(),
  passphrase: vi.fn(),
}));

vi.mock("@trajpack/core", () => ({
  deriveResearchAnalytics: mocks.derive,
  toTraceLabWorkloadRows: mocks.rows,
}));
vi.mock("./dataset-memory.js", () => ({ loadManagedBundlesBounded: mocks.load }));
vi.mock("./secret.js", () => ({ readPassphrase: mocks.passphrase }));

import { runResearchAnalyze } from "./research-command.js";

describe("research analysis command", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.passphrase.mockResolvedValue("test-passphrase");
    mocks.load.mockResolvedValue([{ manifest: { trace_id: "a".repeat(32) } }]);
  });

  it("accepts only unique managed trace ids before decrypting anything", async () => {
    await expect(runResearchAnalyze(["not-a-trace"])).rejects.toThrow("exact managed trace ids");
    await expect(runResearchAnalyze(["a".repeat(32), "a".repeat(32)]))
      .rejects.toThrow("must be unique");
    expect(mocks.passphrase).not.toHaveBeenCalled();
  });

  it("emits the aggregate summary from approved managed bundles", async () => {
    const summary = { schema_version: "research-analytics/0.1", privacy: { content_values_emitted: false } };
    mocks.derive.mockReturnValue(summary);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runResearchAnalyze(["a".repeat(32)], { format: "summary" });

    expect(mocks.load).toHaveBeenCalledWith(["a".repeat(32)], "test-passphrase");
    expect(mocks.derive).toHaveBeenCalledWith(expect.objectContaining({ kind: "approved_bundles" }));
    expect(output).toHaveBeenCalledWith(`${JSON.stringify(summary, null, 2)}\n`);
    output.mockRestore();
  });

  it("writes one content-free TraceLab-derived JSON object per line", async () => {
    mocks.rows.mockReturnValue([
      { round_id: "round_1", _trajpack: { mapping_kind: "lossy_derived", content_values_emitted: false } },
      { round_id: "round_2", _trajpack: { mapping_kind: "lossy_derived", content_values_emitted: false } },
    ]);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runResearchAnalyze(["a".repeat(32)], { format: "tracelab-jsonl" });

    const written = String(output.mock.calls[0]?.[0]);
    expect(written.trim().split("\n")).toHaveLength(2);
    expect(written).toContain('"mapping_kind":"lossy_derived"');
    expect(written).not.toContain("prompt");
    output.mockRestore();
  });
});
