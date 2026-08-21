import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatasetBuild, TraceBundle } from "@trajpack/schema";
import {
  POLICY_VERSION,
  CURRENT_DATASET_COMPILER_VERSIONS,
  approvalFingerprint,
  canonicalJson,
  createApprovalScope,
  datasetCompilerVersionsForRecipe,
  exportApprovedDataset,
  explicitGroupId,
  sha256,
} from "@trajpack/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureBundle } from "../../../packages/core/src/testing.js";
import { runValidate } from "./commands.js";

const temporaryDirectories: string[] = [];

async function rebindChecksums(root: string, changedInput: string | string[]): Promise<void> {
  const changedPaths = Array.isArray(changedInput) ? changedInput : [changedInput];
  const manifestPath = join(root, "dataset-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    artifacts: Array<{ path: string; sha256: string; bytes: number }>;
  };
  for (const changedPath of changedPaths) {
    const changed = await readFile(join(root, ...changedPath.split("/")));
    const artifact = manifest.artifacts.find((entry) => entry.path === changedPath);
    if (!artifact) throw new Error(`Missing fixture artifact ${changedPath}`);
    artifact.sha256 = sha256(changed);
    artifact.bytes = changed.byteLength;
  }
  await writeFile(manifestPath, `${canonicalJson(manifest)}\n`);
  const checksums = new Map((await readFile(join(root, "checksums.txt"), "utf8"))
    .split(/\r?\n/u).filter(Boolean).map((line) => [line.slice(66), line.slice(0, 64)]));
  for (const changedPath of changedPaths) {
    checksums.set(changedPath, sha256(await readFile(join(root, ...changedPath.split("/")))));
  }
  checksums.set("dataset-manifest.json", sha256(await readFile(manifestPath)));
  await writeFile(join(root, "checksums.txt"), `${[...checksums.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([path, digest]) => `${digest}  ${path}`).join("\n")}\n`);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("dataset directory validation", () => {
  it("separates checksum integrity from current policy and detects tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-validate-"));
    temporaryDirectories.push(root);
    const bundle = fixtureBundle("dataset validation fixture content");
    const scope = bundle.manifest.review.approval_scope!;
    const build: DatasetBuild = {
      record_type: "dataset_build",
      schema_version: "dataset-build/0.2",
      name: "validation-fixture",
      policy_version: POLICY_VERSION,
      mode: "archive",
      target: null,
      view_recipe: "trace_full",
      view_recipe_version: "trace-full-view/0.2",
      quality_profile: "sft_basic",
      compiler_versions: CURRENT_DATASET_COMPILER_VERSIONS,
      split_policy: {
        algorithm: "sha256-group-threshold-v1",
        seed: "validation",
        ratios_bp: { train: 10_000, validation: 0, test: 0 },
      },
      traces: [{
        trace_id: bundle.manifest.trace_id,
        split_group_id: explicitGroupId("validation-group", Buffer.alloc(32, 0x44)),
        group_basis: "explicit_hmac",
        source_bundle_sha256: approvalFingerprint(bundle),
        approval_scope_sha256: sha256(canonicalJson(scope)),
        eligibility_decision_id: bundle.manifest.eligibility.local_archive.decision_id,
      }],
    };
    const output = join(root, "dataset");
    await exportApprovedDataset(build, [bundle], { format: "canonical", outputDirectory: output });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await runValidate(output), String(stdout.mock.calls.at(-1)?.[0])).toBe(true);
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining('"integrity_valid": true'));
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining('"self_consistent": true'));
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining('"training_eligibility_attestation_present": false'));
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining('"training_ready": false'));

    const auditPath = join(output, "dataset-audit.json");
    const originalAudit = JSON.parse(await readFile(auditPath, "utf8")) as {
      near_duplicate_scan: { threshold_bp: number };
    };
    await writeFile(auditPath, `${canonicalJson({
      ...originalAudit,
      near_duplicate_scan: { ...originalAudit.near_duplicate_scan, threshold_bp: 1 },
    })}\n`);
    await rebindChecksums(output, "dataset-audit.json");
    expect(await runValidate(output)).toBe(false);
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining("audit:near_scan_threshold"));
    await writeFile(auditPath, `${canonicalJson(originalAudit)}\n`);
    await rebindChecksums(output, "dataset-audit.json");
    expect(await runValidate(output)).toBe(true);

    const selectionPath = join(output, "selection.json");
    const selection = JSON.parse(await readFile(selectionPath, "utf8")) as DatasetBuild;
    await writeFile(selectionPath, `${canonicalJson({ ...selection, name: "renamed-after-export" })}\n`);
    await rebindChecksums(output, "selection.json");
    expect(await runValidate(output)).toBe(false);
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining('"integrity_valid": true'));
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining('"self_consistent": false'));
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining("manifest:name"));

    const eventsRelative = `splits/train/traces/${bundle.manifest.trace_id}/events.jsonl`;
    const eventsPath = join(output, ...eventsRelative.split("/"));
    const event = JSON.parse((await readFile(eventsPath, "utf8")).trim()) as {
      content: Array<{ value: string | null }>;
    };
    event.content[0]!.value = "tampered canonical selected view";
    await writeFile(eventsPath, `${canonicalJson(event)}\n`);
    await rebindChecksums(output, eventsRelative);
    expect(await runValidate(output)).toBe(false);
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining(`selected_bundle:${bundle.manifest.trace_id}`));

    await writeFile(join(output, "DATASET_CARD.md"), "tampered\n");
    expect(await runValidate(output)).toBe(false);
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining("DATASET_CARD.md"));

    await writeFile(join(output, "checksums.txt"), `${await readFile(join(output, "checksums.txt"), "utf8")}${"0".repeat(64)}  ../escape\n`);
    await expect(runValidate(output)).rejects.toThrow("unsafe or malformed path");
  });

  it("rederives stats and audit views after an attacker rebinds every checksum", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-rederive-"));
    temporaryDirectories.push(root);
    const bundle = fixtureBundle("dataset rederivation fixture content");
    const scope = bundle.manifest.review.approval_scope!;
    const build: DatasetBuild = {
      record_type: "dataset_build",
      schema_version: "dataset-build/0.2",
      name: "rederive-fixture",
      policy_version: POLICY_VERSION,
      mode: "archive",
      target: null,
      view_recipe: "trace_full",
      view_recipe_version: "trace-full-view/0.2",
      quality_profile: "sft_basic",
      compiler_versions: CURRENT_DATASET_COMPILER_VERSIONS,
      split_policy: {
        algorithm: "sha256-group-threshold-v1",
        seed: "rederive",
        ratios_bp: { train: 10_000, validation: 0, test: 0 },
      },
      traces: [{
        trace_id: bundle.manifest.trace_id,
        split_group_id: explicitGroupId("rederive-group", Buffer.alloc(32, 0x46)),
        group_basis: "explicit_hmac",
        source_bundle_sha256: approvalFingerprint(bundle),
        approval_scope_sha256: sha256(canonicalJson(scope)),
        eligibility_decision_id: bundle.manifest.eligibility.local_archive.decision_id,
      }],
    };
    const output = join(root, "dataset");
    await exportApprovedDataset(build, [bundle], { format: "canonical", outputDirectory: output });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const statsPath = join(output, "dataset-stats.json");
    const auditPath = join(output, "dataset-audit.json");
    const completePath = join(output, "COMPLETE");
    const originalStats = JSON.parse(await readFile(statsPath, "utf8")) as Record<string, unknown>;
    const originalAudit = JSON.parse(await readFile(auditPath, "utf8")) as Record<string, unknown>;
    const originalComplete = JSON.parse(await readFile(completePath, "utf8")) as Record<string, unknown>;

    const sourceTampering: Array<[string, (stats: Record<string, unknown>) => void]> = [
      ["provider", (stats) => { ((stats.sources as Record<string, unknown>).providers as Record<string, number>) = { spoofed: 1 }; }],
      ["model", (stats) => { ((stats.sources as Record<string, unknown>).models as Record<string, number>) = { "spoofed-model": 1 }; }],
      ["authenticity", (stats) => { ((stats.sources as Record<string, unknown>).authenticity as Record<string, number>) = { verified_native: 1 }; }],
    ];
    for (const [, mutate] of sourceTampering) {
      const stats = structuredClone(originalStats);
      mutate(stats);
      const complete = structuredClone(originalComplete);
      complete.stats_sha256 = sha256(canonicalJson(stats));
      await writeFile(statsPath, `${canonicalJson(stats)}\n`);
      await writeFile(completePath, `${canonicalJson(complete)}\n`);
      await rebindChecksums(output, ["dataset-stats.json", "COMPLETE"]);
      expect(await runValidate(output)).toBe(false);
      const result = String(stdout.mock.calls.at(-1)?.[0]);
      expect(result).toContain('"checksum_self_consistent": true');
      expect(result).toContain('"integrity_valid": false');
      expect(result).toContain("stats:derived_selected_views");
      await writeFile(statsPath, `${canonicalJson(originalStats)}\n`);
      await writeFile(completePath, `${canonicalJson(originalComplete)}\n`);
      await rebindChecksums(output, ["dataset-stats.json", "COMPLETE"]);
      expect(await runValidate(output)).toBe(true);
    }

    const audit = structuredClone(originalAudit) as {
      training_views: Array<{ view_sha256: string }>;
    } & Record<string, unknown>;
    audit.training_views[0]!.view_sha256 = "f".repeat(64);
    const complete = structuredClone(originalComplete);
    complete.audit_sha256 = sha256(canonicalJson(audit));
    await writeFile(auditPath, `${canonicalJson(audit)}\n`);
    await writeFile(completePath, `${canonicalJson(complete)}\n`);
    await rebindChecksums(output, ["dataset-audit.json", "COMPLETE"]);
    expect(await runValidate(output)).toBe(false);
    const auditResult = String(stdout.mock.calls.at(-1)?.[0]);
    expect(auditResult).toContain('"checksum_self_consistent": true');
    expect(auditResult).toContain('"integrity_valid": false');
    expect(auditResult).toContain("audit:derived_selected_views");

    const selection = JSON.parse(await readFile(join(output, "selection.json"), "utf8")) as Record<string, unknown>;
    (selection.compiler_versions as Record<string, unknown>).dedupe = "retired-dedupe/0.0";
    await writeFile(join(output, "selection.json"), `${canonicalJson(selection)}\n`);
    await rebindChecksums(output, "selection.json");
    expect(await runValidate(output)).toBe(false);
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining("compiler:selection_unsupported"));
  });

  it("binds native HF Parquet rows to JSONL examples and selected provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-validate-hf-"));
    temporaryDirectories.push(root);
    const bundle = fixtureBundle("HF validator fixture content");
    bundle.manifest.source.host = "manual_import";
    bundle.manifest.review.approval_scope = createApprovalScope(bundle, [
      "archive",
      "training_noncompetitive",
      "training_competitive_distillation",
      "redistribution",
    ]);
    const scope = bundle.manifest.review.approval_scope!;
    const build: DatasetBuild = {
      record_type: "dataset_build",
      schema_version: "dataset-build/0.2",
      name: "validation-hf-fixture",
      policy_version: POLICY_VERSION,
      mode: "training_competitive_distillation",
      target: { model_owner: "owner", product: "open-model" },
      view_recipe: "trace_full",
      view_recipe_version: "trace-full-view/0.2",
      quality_profile: "sft_basic",
      compiler_versions: CURRENT_DATASET_COMPILER_VERSIONS,
      split_policy: {
        algorithm: "sha256-group-threshold-v1",
        seed: "validation-hf",
        ratios_bp: { train: 10_000, validation: 0, test: 0 },
      },
      traces: [{
        trace_id: bundle.manifest.trace_id,
        split_group_id: explicitGroupId("validation-hf-group", Buffer.alloc(32, 0x45)),
        group_basis: "explicit_hmac",
        source_bundle_sha256: approvalFingerprint(bundle),
        approval_scope_sha256: sha256(canonicalJson(scope)),
        eligibility_decision_id: bundle.manifest.eligibility.training_competitive_distillation.decision_id,
      }],
    };
    const output = join(root, "dataset");
    await exportApprovedDataset(build, [bundle], { format: "hf-trl", outputDirectory: output });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await runValidate(output), String(stdout.mock.calls.at(-1)?.[0])).toBe(true);

    const jsonlPath = join(output, "splits", "train", "dataset.jsonl");
    const example = JSON.parse((await readFile(jsonlPath, "utf8")).trim()) as {
      messages: Array<Record<string, unknown>>;
    };
    example.messages[0]!.content = "tampered but structurally valid";
    await writeFile(jsonlPath, `${canonicalJson(example)}\n`);
    await rebindChecksums(output, "splits/train/dataset.jsonl");
    expect(await runValidate(output)).toBe(false);
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining("hf_parquet:train:row:"));

    const provenancePath = join(output, "lineage", "traces", bundle.manifest.trace_id, "provenance.json");
    const provenance = JSON.parse(await readFile(provenancePath, "utf8")) as {
      canonical_events: Array<{ content: Array<{ value: string | null }> }>;
    };
    provenance.canonical_events[0]!.content[0]!.value = "tampered selected provenance";
    await writeFile(provenancePath, `${canonicalJson(provenance)}\n`);
    await rebindChecksums(output, `lineage/traces/${bundle.manifest.trace_id}/provenance.json`);
    expect(await runValidate(output)).toBe(false);
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining(`selected_bundle:${bundle.manifest.trace_id}`));
  });

  it("validates the committed two-epoch DeepSeek dataset report without reopening raw capsules", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-validate-deepseek-"));
    temporaryDirectories.push(root);
    const fixturePath = new URL("../../../examples/deepseek-research-demo/artifacts/approved/approved.trace.json", import.meta.url);
    const bundle = JSON.parse(await readFile(fixturePath, "utf8")) as TraceBundle;
    const scope = bundle.manifest.review.approval_scope!;
    const build: DatasetBuild = {
      record_type: "dataset_build",
      schema_version: "dataset-build/0.2",
      name: "deepseek-two-epoch-validation",
      policy_version: POLICY_VERSION,
      mode: "training_competitive_distillation",
      target: { model_owner: "trajpack-demo", product: "local-research-student" },
      view_recipe: "deepseek_epoch_sft",
      view_recipe_version: "deepseek-exact-request-epoch-sft/0.1",
      quality_profile: "sft_basic",
      compiler_versions: datasetCompilerVersionsForRecipe("deepseek_epoch_sft"),
      split_policy: {
        algorithm: "sha256-group-threshold-v1",
        seed: "deepseek-two-epoch-validation",
        ratios_bp: { train: 10_000, validation: 0, test: 0 },
      },
      traces: [{
        trace_id: bundle.manifest.trace_id,
        split_group_id: explicitGroupId("deepseek-two-epoch", Buffer.alloc(32, 0x47)),
        group_basis: "explicit_hmac",
        source_bundle_sha256: approvalFingerprint(bundle),
        approval_scope_sha256: sha256(canonicalJson(scope)),
        eligibility_decision_id: bundle.manifest.eligibility.training_competitive_distillation.decision_id,
      }],
    };
    const output = join(root, "dataset");
    await exportApprovedDataset(build, [bundle], { format: "hf-trl", outputDirectory: output });
    const audit = JSON.parse(await readFile(join(output, "dataset-audit.json"), "utf8")) as {
      schema_version: string;
      training_views: unknown[];
      near_duplicate_scan: { record_count: number };
    };
    expect(audit).toMatchObject({
      schema_version: "dataset-audit/0.3",
      near_duplicate_scan: { record_count: 2 },
    });
    expect(audit.training_views).toHaveLength(2);

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await runValidate(output), String(stdout.mock.calls.at(-1)?.[0])).toBe(true);
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining("encrypted raw request epochs"));

    const reportRelative = `lineage/traces/${bundle.manifest.trace_id}/training-view-report.json`;
    const reportPath = join(output, ...reportRelative.split("/"));
    const report = JSON.parse(await readFile(reportPath, "utf8")) as {
      views: Array<{ metadata: Record<string, unknown> }>;
    };
    report.views[0]!.metadata.epoch_input_sha256 = "f".repeat(64);
    await writeFile(reportPath, `${canonicalJson(report)}\n`);
    await rebindChecksums(output, reportRelative);
    expect(await runValidate(output)).toBe(false);
    expect(stdout).toHaveBeenLastCalledWith(expect.stringContaining(`training_view_report:${bundle.manifest.trace_id}`));
  });
});
