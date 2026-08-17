import { describe, expect, it } from "vitest";
import {
  datasetBuildSchema,
  datasetArtifactPathSchema,
  datasetExampleSchema,
  datasetManifestSchema,
  decisionStatusSchema,
  migrateTraceBundle,
  reasoningMetadataSchema,
} from "./index.js";

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

  it("validates deterministic dataset build scopes", () => {
    const build = {
      record_type: "dataset_build",
      schema_version: "dataset-build/0.1",
      name: "research-set",
      policy_version: "policy/fixture",
      mode: "training_competitive_distillation",
      target: { model_owner: "lab", product: "student" },
      compiler_versions: {
        view: "trace-full-view/0.2",
        quality: "trajectory-quality/0.1",
        dedupe: "canonical-training-view+shingle-jaccard/0.3",
      },
      split_policy: {
        algorithm: "sha256-group-threshold-v1",
        seed: "paper-1",
        ratios_bp: { train: 8000, validation: 1000, test: 1000 },
      },
      traces: [{
        trace_id: "a".repeat(32),
        split_group_id: "b".repeat(64),
        group_basis: "explicit_hmac",
        source_bundle_sha256: "c".repeat(64),
        approval_scope_sha256: "d".repeat(64),
        eligibility_decision_id: "decision",
      }],
    };
    expect(datasetBuildSchema.parse(build).quality_profile).toBe("research_strict");
    expect(() => datasetBuildSchema.parse({ ...build, target: null })).toThrow("exact target");
    expect(() => datasetBuildSchema.parse({
      ...build,
      traces: [...build.traces, ...build.traces],
    })).toThrow("cannot contain a trace more than once");
  });

  it("rejects misaligned or non-assistant loss masks", () => {
    const base = {
      id: "example",
      trace_id: "a".repeat(32),
      source_event_ids: ["event"],
      messages: [{ role: "user", content: "hello" }],
      tools: [],
      assistant_loss_mask: [true],
      training_targets: [],
      reward: null,
      verifier: null,
      metadata: {},
    };
    expect(() => datasetExampleSchema.parse(base)).toThrow("Only assistant messages");
    expect(() => datasetExampleSchema.parse({ ...base, assistant_loss_mask: [] })).toThrow("one-to-one");
    expect(() => datasetExampleSchema.parse({
      ...base,
      assistant_loss_mask: [false],
      reward: 1,
    })).toThrow("Reward and verifier");
  });

  it("rejects unsafe or ambiguous dataset inventories", () => {
    for (const unsafe of ["../secret", "/absolute", "C:/windows", "a\\b", "a//b", "a/./b", "a/../b", "a\u0000b"]) {
      expect(() => datasetArtifactPathSchema.parse(unsafe)).toThrow("POSIX-relative");
    }
    expect(datasetArtifactPathSchema.parse("splits/train/dataset.jsonl")).toBe("splits/train/dataset.jsonl");
    const entry = {
      trace_id: "a".repeat(32),
      split: "train",
      split_group_id: "b".repeat(64),
      source_bundle_sha256: "c".repeat(64),
      approval_scope_sha256: "d".repeat(64),
      eligibility_decision_id: "decision",
      selected_bundle_sha256: "e".repeat(64),
      example_ids: ["example-1"],
    };
    const manifest = {
      record_type: "dataset_manifest",
      schema_version: "dataset/0.1",
      dataset_id: "f".repeat(64),
      name: "research-set",
      created_at: "2026-08-16T00:00:00.000Z",
      format: "hf-trl",
      mapping_version: "mapping",
      mode: "training_competitive_distillation",
      target: { model_owner: "lab", product: "student" },
      policy_version: "policy/fixture",
      view_recipe: "trace_full",
      quality_profile: "research_strict",
      compiler_versions: {
        view: "trace-full-view/0.2",
        quality: "trajectory-quality/0.1",
        dedupe: "canonical-training-view+shingle-jaccard/0.3",
      },
      split_policy: {
        algorithm: "sha256-group-threshold-v1",
        seed: "paper-1",
        ratios_bp: { train: 8000, validation: 1000, test: 1000 },
      },
      entries: [entry],
      splits: {
        train: { traces: 1, examples: 1 },
        validation: { traces: 0, examples: 0 },
        test: { traces: 0, examples: 0 },
      },
      artifacts: [{ path: "selection.json", sha256: "0".repeat(64), bytes: 1 }],
    };
    expect(datasetManifestSchema.parse(manifest).entries).toHaveLength(1);
    expect(() => datasetManifestSchema.parse({ ...manifest, entries: [entry, entry] })).toThrow("trace ids must be unique");
    expect(() => datasetManifestSchema.parse({
      ...manifest,
      entries: [entry, { ...entry, trace_id: "1".repeat(32) }],
    })).toThrow("example ids must be globally unique");
    expect(() => datasetManifestSchema.parse({
      ...manifest,
      artifacts: [...manifest.artifacts, ...manifest.artifacts],
    })).toThrow("artifact paths must be unique");
  });
});
