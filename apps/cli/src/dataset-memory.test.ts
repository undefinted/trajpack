import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ loadTrace: vi.fn() }));
vi.mock("@trajpack/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@trajpack/core")>()),
  loadTrace: mocks.loadTrace,
}));

import { fixtureBundle } from "../../../packages/core/src/testing.js";
import { estimateResidentBytes, loadManagedBundlesBounded } from "./dataset-memory.js";

describe("dataset in-process memory budget", () => {
  it("estimates the complete bundle graph and fails before retaining an unbounded selection", async () => {
    const bundle = fixtureBundle("x".repeat(4096));
    const estimate = estimateResidentBytes(bundle);
    expect(estimate).toBeGreaterThan(4096);
    mocks.loadTrace.mockResolvedValue(bundle);
    await expect(loadManagedBundlesBounded(["a".repeat(32)], "passphrase", estimate - 1))
      .rejects.toThrow("in-process compilation budget");
    expect(await loadManagedBundlesBounded(["a".repeat(32)], "passphrase", estimate))
      .toHaveLength(1);
  });

  it("fails closed on an object graph that exceeds the node budget", () => {
    expect(() => estimateResidentBytes({ nested: [{ value: "x" }] }, 2))
      .toThrow("node budget");
  });
});
