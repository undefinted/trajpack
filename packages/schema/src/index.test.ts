import { describe, expect, it } from "vitest";
import { decisionStatusSchema, migrateTraceBundle, reasoningMetadataSchema } from "./index.js";

describe("schema primitives", () => {
  it("accepts only explicit policy states", () => {
    expect(decisionStatusSchema.parse("allow")).toBe("allow");
    expect(() => decisionStatusSchema.parse("maybe")).toThrow();
  });

  it("does not expose a hidden chain-of-thought label", () => {
    expect(
      reasoningMetadataSchema.parse({
        representation: "provider_summary",
        provider_claim: "reasoning_summary",
        source_field: "summary",
        visibility: "user_visible",
      }).representation,
    ).toBe("provider_summary");
    expect(() => reasoningMetadataSchema.parse({ representation: "raw_chain_of_thought" })).toThrow();
  });

  it("rejects historical or future bundles unless an explicit migration exists", () => {
    expect(() => migrateTraceBundle({ manifest: { schema_version: "trajectory/0.0" }, events: [] }))
      .toThrow("No explicit trajectory migration is registered");
    expect(() => migrateTraceBundle({ manifest: { schema_version: "trajectory/0.2" }, events: [] }))
      .toThrow("No explicit trajectory migration is registered");
  });
});
