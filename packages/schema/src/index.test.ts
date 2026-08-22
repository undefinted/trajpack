import { describe, expect, it } from "vitest";
import {
  consentSchema,
  contentPartSchema,
  datasetBuildSchema,
  datasetArtifactPathSchema,
  datasetExampleSchema,
  datasetManifestSchema,
  decisionStatusSchema,
  migrateDatasetBuild,
  migrateTraceBundle,
  reasoningMetadataSchema,
  termsSnapshotSchema,
  traceBundleSchema,
  trajectoryEventSchema,
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

  it("accepts only canonical UTC instants in terms snapshots", () => {
    const snapshot = {
      name: "Fixture terms",
      url: "https://example.test/terms",
      effective_at: "2026-08-22T00:00:00.000Z",
      retrieved_at: "2026-08-22T00:00:01.000Z",
      snapshot_sha256: "a".repeat(64),
      review_after: "2026-11-20T00:00:00.000Z",
    };
    expect(termsSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    for (const effectiveAt of [
      "2026-08-22T00:00:00Z",
      "2026-08-22T08:00:00.000+08:00",
      "2026-02-30T00:00:00.000Z",
      "2026-08-22T00:00:00.1234Z",
    ]) {
      expect(() => termsSnapshotSchema.parse({ ...snapshot, effective_at: effectiveAt })).toThrow();
    }
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
      schema_version: "dataset-build/0.2",
      name: "research-set",
      policy_version: "policy/fixture",
      mode: "training_competitive_distillation",
      target: { model_owner: "lab", product: "student" },
      view_recipe: "trace_full",
      view_recipe_version: "trace-full-view/0.2",
      compiler_versions: {
        view: "dataset-view-selector/0.3",
        training_view: null,
        quality: "trajectory-quality/0.1",
        dedupe: "compiled-example+canonical-shingle-jaccard/0.4",
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
    expect(datasetBuildSchema.parse({
      ...build,
      view_recipe: "deepseek_epoch_sft",
      view_recipe_version: "deepseek-exact-request-epoch-sft/0.1",
      compiler_versions: { ...build.compiler_versions, training_view: "training-view-compiler/0.2" },
    }).view_recipe)
      .toBe("deepseek_epoch_sft");
    expect(() => datasetBuildSchema.parse({
      ...build,
      mode: "archive",
      target: null,
      view_recipe: "answer_sft",
      view_recipe_version: "answer-sft/0.1",
      compiler_versions: { ...build.compiler_versions, training_view: "training-view-compiler/0.2" },
    })).toThrow("require a training dataset mode");
    expect(() => datasetBuildSchema.parse({
      ...build,
      traces: [...build.traces, ...build.traces],
    })).toThrow("cannot contain a trace more than once");
  });

  it("migrates historical trace_full dataset builds only through an explicit step", () => {
    const current = migrateDatasetBuild({
      record_type: "dataset_build",
      schema_version: "dataset-build/0.1",
      name: "legacy-set",
      policy_version: "policy/fixture",
      mode: "archive",
      target: null,
      view_recipe: "trace_full",
      quality_profile: "sft_basic",
      compiler_versions: {
        view: "trace-full-view/0.2",
        quality: "trajectory-quality/0.1",
        dedupe: "canonical-training-view+shingle-jaccard/0.3",
      },
      split_policy: {
        algorithm: "sha256-group-threshold-v1",
        seed: "legacy",
        ratios_bp: { train: 10000, validation: 0, test: 0 },
      },
      traces: [{
        trace_id: "a".repeat(32),
        split_group_id: "b".repeat(64),
        group_basis: "trace_fallback",
        source_bundle_sha256: "c".repeat(64),
        approval_scope_sha256: "d".repeat(64),
        eligibility_decision_id: "legacy-decision",
      }],
    });
    expect(current).toMatchObject({
      schema_version: "dataset-build/0.2",
      view_recipe_version: "trace-full-view/0.2",
      compiler_versions: { view: "dataset-view-selector/0.3", training_view: null },
    });
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

  it("rejects content parts with neither inline value nor a blob reference", () => {
    const part = {
      ordinal: 0,
      type: "text",
      mime_type: "text/plain",
      value: null,
      blob_ref: null,
      sha256: "0".repeat(64),
      sensitivity: "internal",
      redaction_status: "not_scanned",
      review_disposition: "include",
      reasoning: null,
      rights_override: null,
    };
    expect(contentPartSchema.safeParse(part).success).toBe(false);
    expect(contentPartSchema.safeParse({ ...part, value: "text" }).success).toBe(true);
    expect(contentPartSchema.safeParse({ ...part, blob_ref: "blob://ref" }).success).toBe(true);
  });

  it("requires at least one consent purpose", () => {
    const consent = {
      receipt_id: "receipt",
      subjects_scope: "single_user",
      purposes: [],
      active: true,
      captured_at: "2026-08-16T00:00:00.000Z",
      withdrawal_ref: null,
    };
    expect(consentSchema.safeParse(consent).success).toBe(false);
    expect(consentSchema.safeParse({ ...consent, purposes: ["archive"] }).success).toBe(true);
  });

  it("rejects events whose ended_at precedes started_at", () => {
    const event = {
      record_type: "event",
      event_id: "evt-1",
      trace_id: "a".repeat(32),
      span_id: "b".repeat(16),
      sequence: 0,
      started_at: "2026-08-16T00:00:05.000Z",
      ended_at: "2026-08-16T00:00:00.000Z",
      event_type: "message",
      actor: "assistant",
      status: "ok",
    };
    expect(trajectoryEventSchema.safeParse(event).success).toBe(false);
    expect(trajectoryEventSchema.safeParse({
      ...event,
      ended_at: "2026-08-16T00:00:05.000Z",
    }).success).toBe(true);
  });

  it("rejects empty, duplicate, and non-monotonic trace bundles", () => {
    const decision = (purposes: string[]) => ({
      status: "unknown" as const,
      purposes,
      reason_codes: [],
      basis: "test",
      target_model_owner: null,
      target_product: null,
      competitive_with_source: "unknown" as const,
      decision_id: "decision",
      decided_at: "2026-08-16T00:00:00.000Z",
      expires_at: "2099-01-01T00:00:00.000Z",
      reviewer: null,
      evidence_ref: null,
    });
    const manifest = {
      record_type: "trace_manifest",
      schema_version: "trajectory/0.1",
      trace_id: "a".repeat(32),
      created_at: "2026-08-16T00:00:00.000Z",
      source: {
        host: "manual_import",
        provider: "other",
        product: "p",
        surface: "manual_import",
        capture_method: "manual_copy",
        adapter_version: "0.1.0",
        interface_version: "generic_json",
        fidelity: "B",
      },
      account_contract: { account_type: "unknown", terms: [] },
      rights: {
        source_license_expression: "Apache-2.0",
        input_rights_basis: "owned",
        third_party_content: "none",
      },
      consent: {
        receipt_id: "receipt",
        subjects_scope: "single_user",
        purposes: ["archive"],
        active: true,
        captured_at: "2026-08-16T00:00:00.000Z",
      },
      eligibility: {
        local_archive: decision(["archive"]),
        automatic_capture: decision(["capture"]),
        training_noncompetitive: decision(["sft"]),
        training_competitive_distillation: decision(["distillation"]),
        redistribution: decision(["release"]),
      },
      privacy: {
        legal_basis: "test",
        storage_region: "local",
        retention_class: "test",
        redaction_policy_version: "redaction/0.1",
      },
      review: { automated_checks: "pending", human_approval: "pending" },
      lineage: { normalizer_version: "0.1.0" },
    };
    const event = (sequence: number, id = `evt-${sequence}`) => ({
      record_type: "event",
      event_id: id,
      trace_id: "a".repeat(32),
      span_id: (sequence + 1).toString(16).padStart(16, "0"),
      sequence,
      started_at: "2026-08-16T00:00:00.000Z",
      ended_at: null,
      event_type: "message",
      actor: "assistant",
      status: "ok",
    });

    expect(traceBundleSchema.safeParse({ manifest, events: [], raw: [] }).success).toBe(false);
    expect(traceBundleSchema.safeParse({ manifest, events: [event(0)], raw: [] }).success).toBe(true);
    expect(traceBundleSchema.safeParse({ manifest, events: [event(0), event(0, "evt-dup")], raw: [] }).success).toBe(false);
    expect(traceBundleSchema.safeParse({ manifest, events: [event(1), event(0)], raw: [] }).success).toBe(false);
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
      schema_version: "dataset/0.2",
      dataset_id: "f".repeat(64),
      name: "research-set",
      created_at: "2026-08-16T00:00:00.000Z",
      format: "hf-trl",
      mapping_version: "mapping",
      mode: "training_competitive_distillation",
      target: { model_owner: "lab", product: "student" },
      policy_version: "policy/fixture",
      view_recipe: "trace_full",
      view_recipe_version: "trace-full-view/0.2",
      quality_profile: "research_strict",
      compiler_versions: {
        view: "dataset-view-selector/0.3",
        training_view: null,
        quality: "trajectory-quality/0.1",
        dedupe: "compiled-example+canonical-shingle-jaccard/0.4",
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
