import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, safeStringify } from "./format.js";

describe("format helpers", () => {
  it("serializes shared references fully and only marks true cycles as circular", () => {
    const shared = { value: 1 };
    const dag = { a: shared, b: shared };
    const parsed = JSON.parse(safeStringify(dag)) as { a: { value: number }; b: { value: number } };
    expect(parsed.a).toEqual({ value: 1 });
    expect(parsed.b).toEqual({ value: 1 });

    const cycle: Record<string, unknown> = { name: "root" };
    cycle.self = cycle;
    const parsedCycle = JSON.parse(safeStringify(cycle)) as { name: string; self: unknown };
    expect(parsedCycle.name).toBe("root");
    expect(parsedCycle.self).toBe("[Circular]");
  });

  it("formats byte and duration magnitudes without crashing", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(3 * 1_048_576)).toBe("3.0 MiB");
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(500)).toBe("500 ms");
    expect(formatDuration(2500)).toBe("2.5 s");
  });
});
