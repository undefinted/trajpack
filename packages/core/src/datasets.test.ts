import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATASET_BUILD_VERSION, DATASET_VIEW_RECIPE_VERSIONS, type DatasetBuild, type TraceBundle } from "@trajpack/schema";
import { ParquetReader } from "@dsnp/parquetjs";
import { describe, expect, it } from "vitest";
import { approvalFingerprint, createApprovalScope, POLICY_VERSION } from "./policy.js";
import { canonicalJson, sha256 } from "./canonical.js";
import {
  DATASET_NEAR_DUPLICATE_CONFIG,
  computeDatasetId,
  datasetCompilerVersionsForRecipe,
  explicitGroupId,
  exportApprovedDataset,
  inspectDatasetBuild,
  inspectDatasetNearDuplicateFeatureSets,
  MAX_DATASET_STAGING_JSONL_BYTES,
  readDatasetJsonLines,
  splitForGroup,
  traceFallbackGroupId,
} from "./datasets.js";
import { fixtureBundle } from "./testing.js";

const GROUP_SECRET = Buffer.alloc(32, 0x42);
const HAS_HF_PYTHON = spawnSync("python", ["-c", "import datasets, pyarrow"], { stdio: "ignore" }).status === 0;

function distinctBundle(traceId: string, text: string, competitive = false): TraceBundle {
  const bundle = fixtureBundle(text);
  // Dataset mechanics are source-agnostic. Keep these fixtures off the
  // DeepSeek Harness path, whose HF/TRL contract requires an explicit recipe.
  bundle.manifest.source.host = "manual_import";
  bundle.manifest.trace_id = traceId;
  bundle.events = bundle.events.map((event, index) => ({
    ...event,
    trace_id: traceId,
    event_id: `event_${traceId}_${index}`,
    span_id: sha256(`span:${traceId}:${index}`).slice(0, 16),
    parent_span_id: null,
  }));
  bundle.manifest.eligibility.training_competitive_distillation.competitive_with_source = competitive ? "yes" : "no";
  bundle.manifest.review.approval_scope = createApprovalScope(bundle, [
    "archive",
    "training_noncompetitive",
    "training_competitive_distillation",
    "redistribution",
  ]);
  return bundle;
}

function reapprove(bundle: TraceBundle): void {
  bundle.manifest.review.approval_scope = createApprovalScope(bundle, [
    "archive",
    "training_noncompetitive",
    "training_competitive_distillation",
    "redistribution",
  ]);
}

function appendMessage(bundle: TraceBundle, text: string, suffix: string): void {
  const base = bundle.events[0]!;
  bundle.events.push({
    ...base,
    event_id: `event_${suffix}`,
    span_id: sha256(`span:${suffix}`).slice(0, 16),
    sequence: bundle.events.length,
    actor: "user",
    source_event_id: `source_${suffix}`,
    content: [{ ...base.content[0]!, value: text, sha256: sha256(text) }],
  });
}

function appendAssistantMessage(bundle: TraceBundle, text: string, suffix: string): void {
  appendMessage(bundle, text, suffix);
  bundle.events.at(-1)!.actor = "assistant";
}

function appendToolPair(bundle: TraceBundle, argument: string, result: string, suffix: string): void {
  const base = bundle.events[0]!;
  const callId = `call_${suffix}`;
  bundle.events.push({
    ...base,
    event_id: `tool_call_${suffix}`,
    span_id: sha256(`tool-call:${suffix}`).slice(0, 16),
    sequence: bundle.events.length,
    event_type: "tool.call",
    actor: "assistant",
    content: [],
    tool: { call_id: callId, name: "search", arguments: { q: argument }, result: null, exit_code: null },
  });
  bundle.events.push({
    ...base,
    event_id: `tool_result_${suffix}`,
    span_id: sha256(`tool-result:${suffix}`).slice(0, 16),
    sequence: bundle.events.length,
    event_type: "tool.result",
    actor: "tool",
    content: [],
    tool: { call_id: callId, name: "search", arguments: null, result, exit_code: 0 },
  });
}

function groupForSplit(policy: DatasetBuild["split_policy"], split: "train" | "test"): string {
  for (let index = 0; index < 100_000; index += 1) {
    const candidate = explicitGroupId(`forced:${split}:${index}`, GROUP_SECRET);
    if (splitForGroup(policy, candidate) === split) return candidate;
  }
  throw new Error(`Unable to find deterministic ${split} fixture group`);
}

function branchingBundle(traceId: string, uniqueAnswer: string): TraceBundle {
  const bundle = distinctBundle(traceId, "shared branch prompt", true);
  const root = bundle.events[0]!;
  root.actor = "user";
  root.source_session_id = `session-${traceId}`;
  root.metadata.source_parent_message_id = null;
  const answer = (value: string, suffix: string, sequence: number) => {
    const event = structuredClone(root);
    event.event_id = `branch-${traceId}-${suffix}`;
    event.span_id = sha256(`branch:${traceId}:${suffix}`).slice(0, 16);
    event.parent_span_id = root.span_id;
    event.sequence = sequence;
    event.actor = "assistant" as const;
    event.source_event_id = `source-${traceId}-${suffix}`;
    event.content[0]!.value = value;
    event.content[0]!.sha256 = sha256(value);
    event.metadata.source_parent_message_id = root.event_id;
    return event;
  };
  bundle.events = [root, answer("shared branch answer", "shared", 1), answer(uniqueAnswer, "unique", 2)];
  reapprove(bundle);
  return bundle;
}

function buildFor(
  bundles: TraceBundle[],
  overrides: Partial<DatasetBuild> = {},
  explicit = true,
): DatasetBuild {
  const mode = overrides.mode ?? "archive";
  const viewRecipe = overrides.view_recipe ?? "trace_full";
  return {
    record_type: "dataset_build",
    schema_version: DATASET_BUILD_VERSION,
    name: "fixture-dataset",
    policy_version: POLICY_VERSION,
    mode,
    target: mode.startsWith("training_") ? { model_owner: "owner", product: "open-model" } : null,
    view_recipe: viewRecipe,
    view_recipe_version: DATASET_VIEW_RECIPE_VERSIONS[viewRecipe],
    quality_profile: "sft_basic",
    compiler_versions: datasetCompilerVersionsForRecipe(viewRecipe),
    split_policy: {
      algorithm: "sha256-group-threshold-v1",
      seed: "fixture-seed",
      ratios_bp: { train: 8000, validation: 1000, test: 1000 },
    },
    traces: bundles.map((bundle) => ({
      trace_id: bundle.manifest.trace_id,
      split_group_id: explicit
        ? explicitGroupId(`repo:${bundle.manifest.trace_id}`, GROUP_SECRET)
        : traceFallbackGroupId(bundle.manifest.trace_id),
      group_basis: explicit ? "explicit_hmac" : "trace_fallback",
      source_bundle_sha256: approvalFingerprint(bundle),
      approval_scope_sha256: sha256(canonicalJson(bundle.manifest.review.approval_scope)),
      eligibility_decision_id: mode === "archive"
        ? bundle.manifest.eligibility.local_archive.decision_id
        : bundle.manifest.eligibility[mode].decision_id,
    })),
    ...overrides,
  };
}

describe("research dataset builds", () => {
  it("streams staging JSONL above the former cap while keeping an injectable hard bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-jsonl-bound-"));
    const path = join(root, "rows.jsonl");
    const bytes = Buffer.from(`${canonicalJson({ id: 1 })}\n${canonicalJson({ id: 2 })}\n`);
    try {
      await writeFile(path, bytes);
      const rows: unknown[] = [];
      for await (const row of readDatasetJsonLines(path, bytes.length)) rows.push(row);
      expect(rows).toEqual([{ id: 1 }, { id: 2 }]);
      await expect(async () => {
        for await (const _row of readDatasetJsonLines(path, bytes.length - 1)) void _row;
      }).rejects.toThrow("oversized dataset JSONL");
      expect(MAX_DATASET_STAGING_JSONL_BYTES).toBe(Number.MAX_SAFE_INTEGER);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("assigns groups deterministically and keeps one group in one split", () => {
    const policy = {
      algorithm: "sha256-group-threshold-v1" as const,
      seed: "paper-42",
      ratios_bp: { train: 7000, validation: 1500, test: 1500 },
    };
    const group = explicitGroupId("private-repo-family", GROUP_SECRET);
    expect(splitForGroup(policy, group)).toBe(splitForGroup(policy, group));
    expect(explicitGroupId("private-repo-family", Buffer.alloc(32, 0x43))).not.toBe(group);
    expect(traceFallbackGroupId("a".repeat(32))).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("freezes source, approval, and decision bindings before creating output", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-stale-"));
    const bundle = distinctBundle("1".repeat(32), "a sufficiently long unique research sample one");
    const build = buildFor([bundle]);
    bundle.events[0]!.content[0]!.value = "changed after selection was frozen";
    const output = join(root, "dataset");
    try {
      await expect(exportApprovedDataset(build, [bundle], {
        format: "canonical",
        outputDirectory: output,
      })).rejects.toThrow("selection is stale");
      await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("rejects an export parent reached through a symlink ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-parent-link-"));
    const realParent = join(root, "real-parent");
    const aliasParent = join(root, "alias-parent");
    await mkdir(realParent);
    await mkdir(join(realParent, "child"));
    await symlink(realParent, aliasParent, "dir");
    const bundle = distinctBundle("9".repeat(32), "symlink ancestor fixture");
    try {
      await expect(exportApprovedDataset(buildFor([bundle]), [bundle], {
        format: "canonical",
        outputDirectory: join(aliasParent, "child", "dataset"),
      })).rejects.toThrow("symbolic-link or junction ancestor");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires explicit research grouping for multi-trace strict builds", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-group-"));
    const bundles = [
      distinctBundle("2".repeat(32), "a sufficiently long unique research sample two"),
      distinctBundle("3".repeat(32), "a sufficiently long unique research sample three"),
    ];
    const build = buildFor(bundles, { quality_profile: "research_strict" }, false);
    try {
      await expect(exportApprovedDataset(build, bundles, {
        format: "canonical",
        outputDirectory: join(root, "dataset"),
      })).rejects.toThrow("DATASET_EXPLICIT_GROUPS_REQUIRED");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks exact substantive duplicates even when they land in one strict split", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-duplicate-"));
    const bundles = [
      distinctBundle("6".repeat(32), "the same sufficiently long duplicated research sample"),
      distinctBundle("7".repeat(32), "the same sufficiently long duplicated research sample"),
    ];
    const build = buildFor(bundles, {
      quality_profile: "research_strict",
      split_policy: {
        algorithm: "sha256-group-threshold-v1",
        seed: "duplicate-fixture",
        ratios_bp: { train: 10_000, validation: 0, test: 0 },
      },
    });
    try {
      await expect(exportApprovedDataset(build, bundles, {
        format: "canonical",
        outputDirectory: join(root, "dataset"),
      })).rejects.toThrow("DATASET_EXACT_DUPLICATE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks punctuation-only prompt variants across research train/test splits", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-near-cross-"));
    const bundles = [
      distinctBundle("1".repeat(32), "Summarize the verifier result."),
      distinctBundle("2".repeat(32), "Summarize the verifier result!"),
    ];
    const splitPolicy: DatasetBuild["split_policy"] = {
      algorithm: "sha256-group-threshold-v1",
      seed: "near-cross",
      ratios_bp: { train: 5000, validation: 0, test: 5000 },
    };
    const build = buildFor(bundles, { quality_profile: "research_strict", split_policy: splitPolicy });
    build.traces[0]!.split_group_id = groupForSplit(splitPolicy, "train");
    build.traces[1]!.split_group_id = groupForSplit(splitPolicy, "test");
    try {
      await expect(exportApprovedDataset(build, bundles, {
        format: "canonical",
        outputDirectory: join(root, "dataset"),
      })).rejects.toThrow("DATASET_NEAR_CROSS_SPLIT_DUPLICATE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks punctuation-only prompt variants within a research split", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-near-within-"));
    const bundles = [
      distinctBundle("3".repeat(32), "Explain this failing test."),
      distinctBundle("4".repeat(32), "Explain this failing test!"),
    ];
    const build = buildFor(bundles, {
      quality_profile: "research_strict",
      split_policy: {
        algorithm: "sha256-group-threshold-v1",
        seed: "near-within",
        ratios_bp: { train: 10_000, validation: 0, test: 0 },
      },
    });
    try {
      await expect(exportApprovedDataset(build, bundles, {
        format: "canonical",
        outputDirectory: join(root, "dataset"),
      })).rejects.toThrow("DATASET_NEAR_DUPLICATE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes text, code/patch, and tool arguments/results without recording content in the audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-near-fields-"));
    const left = distinctBundle("5".repeat(32), "unique preface alpha");
    const right = distinctBundle("6".repeat(32), "unrelated preface omega");
    appendMessage(left, "Run the patch.", "near-text-a");
    appendMessage(right, "Run   the patch!", "near-text-b");
    appendMessage(left, "return compute(value);\r\nconst ok=true;", "near-code-a");
    appendMessage(right, "return  compute ( value ) ;\nconst ok = true ;", "near-code-b");
    left.events.at(-1)!.content[0]!.mime_type = "text/x-typescript";
    right.events.at(-1)!.content[0]!.mime_type = "text/x-typescript";
    appendMessage(left, "const result=verify(value);", "near-patch-a");
    appendMessage(right, "const  result = verify ( value ) ;", "near-patch-b");
    left.events.at(-1)!.event_type = "artifact.patch";
    right.events.at(-1)!.event_type = "artifact.patch";
    left.events.at(-1)!.content[0]!.type = "patch";
    right.events.at(-1)!.content[0]!.type = "patch";
    appendToolPair(left, "alpha beta", "verified.", "near-tool-a");
    appendToolPair(right, "alpha   beta", "verified!", "near-tool-b");
    left.events.at(-2)!.tool!.arguments = { q: "alpha beta", limit: 5 };
    right.events.at(-2)!.tool!.arguments = { limit: 5, q: "alpha   beta" };
    reapprove(left);
    reapprove(right);
    const build = buildFor([left, right], {
      quality_profile: "sft_basic",
      split_policy: {
        algorithm: "sha256-group-threshold-v1",
        seed: "near-fields",
        ratios_bp: { train: 10_000, validation: 0, test: 0 },
      },
    });
    try {
      const output = join(root, "dataset");
      await exportApprovedDataset(build, [left, right], { format: "canonical", outputDirectory: output });
      const auditText = await readFile(join(output, "dataset-audit.json"), "utf8");
      const audit = JSON.parse(auditText) as {
        near_duplicate_candidates: Array<{ similarity_bp: number; trace_ids: string[] }>;
        warnings: string[];
      };
      expect(audit.near_duplicate_candidates).toHaveLength(1);
      expect(audit.near_duplicate_candidates[0]!.similarity_bp).toBeGreaterThanOrEqual(
        DATASET_NEAR_DUPLICATE_CONFIG.threshold_bp,
      );
      expect(audit.warnings).toContain("Near-duplicate canonical training views occur within a split");
      for (const secret of ["Run the patch", "return compute", "const result", "alpha beta", "verified"]) {
        expect(auditText).not.toContain(secret);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not flag substantively different canonical content", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-near-distinct-"));
    const bundles = [
      distinctBundle("7".repeat(32), "Prove the red-black tree rotation invariant"),
      distinctBundle("8".repeat(32), "Measure ocean salinity from satellite radiometry"),
    ];
    const build = buildFor(bundles, {
      quality_profile: "research_strict",
      split_policy: {
        algorithm: "sha256-group-threshold-v1",
        seed: "near-distinct",
        ratios_bp: { train: 10_000, validation: 0, test: 0 },
      },
    });
    try {
      const output = join(root, "dataset");
      await exportApprovedDataset(build, bundles, { format: "canonical", outputDirectory: output });
      const audit = JSON.parse(await readFile(join(output, "dataset-audit.json"), "utf8")) as {
        near_duplicate_candidates: unknown[];
        near_duplicate_scan: { status: string };
      };
      expect(audit.near_duplicate_candidates).toHaveLength(0);
      expect(audit.near_duplicate_scan.status).toBe("complete");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps hashed-feature candidate results stable across input order", () => {
    const featureA = sha256("canonical shingle a");
    const featureB = sha256("canonical shingle b");
    const records = [
      {
        trace_id: "a".repeat(32), split: "train" as const, view_sha256: sha256("view-a"),
        signature_sha256: sha256("signature-a"), feature_sha256: [featureA, featureB],
      },
      {
        trace_id: "b".repeat(32), split: "test" as const, view_sha256: sha256("view-b"),
        signature_sha256: sha256("signature-b"), feature_sha256: [featureB, featureA],
      },
    ];
    expect(inspectDatasetNearDuplicateFeatureSets(records))
      .toEqual(inspectDatasetNearDuplicateFeatureSets([...records].reverse()));
  });

  it("bounds the 10000-record candidate pass and fails closed on dense postings", () => {
    const records = Array.from({ length: DATASET_NEAR_DUPLICATE_CONFIG.max_records }, (_, index) => ({
      trace_id: index.toString(16).padStart(32, "0"),
      split: "train" as const,
      view_sha256: sha256(`view:${index}`),
      signature_sha256: sha256(`signature:${index}`),
      feature_sha256: [sha256(`unique-feature:${index}`)],
    }));
    const sparse = inspectDatasetNearDuplicateFeatureSets(records);
    expect(sparse.scan).toMatchObject({
      status: "complete",
      record_count: 10_000,
      candidate_pair_count: 0,
      compared_pair_count: 0,
    });
    const sharedFeature = sha256("shared-dense-feature");
    const dense = inspectDatasetNearDuplicateFeatureSets(records
      .slice(0, DATASET_NEAR_DUPLICATE_CONFIG.max_postings_per_shingle + 1)
      .map((record) => ({ ...record, feature_sha256: [sharedFeature] })));
    expect(dense.scan).toMatchObject({
      status: "resource_limit_exceeded",
      reason_code: "DEDUPE_POSTINGS_LIMIT",
    });
    expect(dense.candidates).toHaveLength(0);
  });

  it("fingerprints the complete training view while reporting harmless part overlap", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-complete-view-"));
    const bundles = [
      distinctBundle("a".repeat(32), "same short prompt"),
      distinctBundle("b".repeat(32), "same short prompt"),
    ];
    appendMessage(bundles[0]!, "OK", "short-a");
    appendMessage(bundles[1]!, "OK", "short-b");
    appendToolPair(bundles[0]!, "alpha", "same result", "a");
    appendToolPair(bundles[1]!, "beta", "same result", "b");
    bundles.forEach(reapprove);
    const build = buildFor(bundles, {
      quality_profile: "tool_agent_strict",
      split_policy: {
        algorithm: "sha256-group-threshold-v1",
        seed: "complete-view",
        ratios_bp: { train: 10_000, validation: 0, test: 0 },
      },
    });
    try {
      const output = join(root, "dataset");
      await exportApprovedDataset(build, bundles, { format: "canonical", outputDirectory: output });
      const audit = JSON.parse(await readFile(join(output, "dataset-audit.json"), "utf8")) as {
        exact_within_split_duplicates: unknown[];
        partial_content_overlap: unknown[];
        training_views: Array<{ view_sha256: string }>;
      };
      expect(audit.exact_within_split_duplicates).toHaveLength(0);
      expect(audit.partial_content_overlap.length).toBeGreaterThan(0);
      expect(new Set(audit.training_views.map((view) => view.view_sha256)).size).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks duplicate short patch views instead of ignoring parts below a length threshold", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-short-patch-"));
    const bundles = [distinctBundle("c".repeat(32), "x"), distinctBundle("d".repeat(32), "x")];
    for (const bundle of bundles) {
      bundle.events[0]!.event_type = "artifact.patch";
      bundle.events[0]!.content[0]!.type = "patch";
      reapprove(bundle);
    }
    const splitPolicy: DatasetBuild["split_policy"] = {
      algorithm: "sha256-group-threshold-v1",
      seed: "short-patch",
      ratios_bp: { train: 5000, validation: 0, test: 5000 },
    };
    const build = buildFor(bundles, { quality_profile: "sft_basic", split_policy: splitPolicy });
    build.traces[0]!.split_group_id = groupForSplit(splitPolicy, "train");
    build.traces[1]!.split_group_id = groupForSplit(splitPolicy, "test");
    try {
      await expect(exportApprovedDataset(build, bundles, {
        format: "canonical",
        outputDirectory: join(root, "dataset"),
      })).rejects.toThrow("DATASET_EXACT_CROSS_SPLIT_DUPLICATE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses transitive lineage components and blocks direct parent-child split leakage", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-lineage-"));
    const parent = distinctBundle("e".repeat(32), "lineage parent unique sample");
    const child = distinctBundle("f".repeat(32), "lineage child unique sample");
    parent.manifest.lineage.parent_trace_ids = ["0".repeat(32)];
    child.manifest.lineage.parent_trace_ids = [parent.manifest.trace_id];
    reapprove(parent);
    reapprove(child);
    const splitPolicy: DatasetBuild["split_policy"] = {
      algorithm: "sha256-group-threshold-v1",
      seed: "lineage",
      ratios_bp: { train: 5000, validation: 0, test: 5000 },
    };
    const build = buildFor([parent, child], { split_policy: splitPolicy });
    build.traces[0]!.split_group_id = groupForSplit(splitPolicy, "train");
    build.traces[1]!.split_group_id = groupForSplit(splitPolicy, "test");
    try {
      await expect(exportApprovedDataset(build, [parent, child], {
        format: "canonical",
        outputDirectory: join(root, "dataset"),
      })).rejects.toThrow("DATASET_LINEAGE_SPLIT_CONTAMINATION");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes deterministic multi-row HF/TRL splits and a frozen manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-hf-"));
    const bundles = [
      distinctBundle("4".repeat(32), "a sufficiently long unique research sample four", true),
      distinctBundle("5".repeat(32), "a sufficiently long unique research sample five", true),
    ];
    const build = buildFor(bundles, {
      mode: "training_competitive_distillation",
      target: { model_owner: "owner", product: "open-model" },
    });
    const first = join(root, "first");
    const second = join(root, "second");
    const atifOutput = join(root, "atif");
    try {
      const one = await exportApprovedDataset(build, bundles, {
        format: "hf-trl",
        outputDirectory: first,
        createdAt: new Date("2026-08-16T01:00:00.000Z"),
      });
      const two = await exportApprovedDataset(build, bundles, {
        format: "hf-trl",
        outputDirectory: second,
        createdAt: new Date("2026-08-16T02:00:00.000Z"),
      });
      const atif = await exportApprovedDataset(build, bundles, {
        format: "atif",
        outputDirectory: atifOutput,
        createdAt: new Date("2026-08-16T03:00:00.000Z"),
      });
      expect(one.datasetId).toBe(two.datasetId);
      expect(atif.datasetId).not.toBe(one.datasetId);
      expect(computeDatasetId({ ...build, traces: [...build.traces].reverse() }, one.manifest.entries, "hf-trl"))
        .toBe(one.datasetId);
      expect(JSON.parse(await readFile(join(first, "dataset-manifest.json"), "utf8")).entries).toHaveLength(2);
      const rows = await Promise.all((["train", "validation", "test"] as const).map(async (split) => (
        await readFile(join(first, "splits", split, "dataset.jsonl"), "utf8")
      ).split(/\r?\n/u).filter(Boolean)));
      expect(rows.flat()).toHaveLength(2);
      expect(await readFile(join(first, "dataset_info.json"), "utf8")).toContain("generation_markers");
      expect(await readFile(join(first, "dataset-stats.json"), "utf8")).toContain('"providers":{"self_hosted":2}');
      expect(await readFile(join(first, "checksums.txt"), "utf8")).toContain("dataset-manifest.json");
      const populatedSplit = (["train", "validation", "test"] as const)[rows.findIndex((splitRows) => splitRows.length > 0)]!;
      const reader = await ParquetReader.openFile(join(first, "splits", populatedSplit, "dataset.parquet"));
      try {
        const row = await reader.getCursor().next() as Record<string, unknown> | null;
        expect(row).not.toBeNull();
        expect(row?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "assistant" })]));
        expect(row?.assistant_loss_mask).toEqual(expect.arrayContaining([true]));
        expect(row).not.toHaveProperty("messages_json");
      } finally {
        await reader.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("freezes and exports one versioned training recipe across a multi-trace dataset", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-recipe-"));
    const bundles = [
      distinctBundle("a".repeat(32), "first licensed assistant answer", true),
      distinctBundle("b".repeat(32), "second licensed assistant answer", true),
    ];
    const build = buildFor(bundles, {
      mode: "training_competitive_distillation",
      target: { model_owner: "owner", product: "open-model" },
      view_recipe: "answer_sft",
      quality_profile: "sft_basic",
      split_policy: {
        algorithm: "sha256-group-threshold-v1",
        seed: "recipe-fixture",
        ratios_bp: { train: 10_000, validation: 0, test: 0 },
      },
    });
    const output = join(root, "dataset");
    try {
      const result = await exportApprovedDataset(build, bundles, {
        format: "hf-trl",
        outputDirectory: output,
        createdAt: new Date("2026-08-16T04:00:00.000Z"),
      });
      expect(result.manifest.view_recipe).toBe("answer_sft");
      const rows = (await readFile(join(output, "splits", "train", "dataset.jsonl"), "utf8"))
        .split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ metadata: expect.objectContaining({
          view: expect.objectContaining({ recipe: "answer_sft", recipe_version: "answer-sft/0.1" }),
        }) }),
      ]));
      for (const bundle of bundles) {
        const report = JSON.parse(await readFile(join(
          output,
          "lineage",
          "traces",
          bundle.manifest.trace_id,
          "training-view-report.json",
        ), "utf8")) as Record<string, unknown>;
        expect(report).toMatchObject({ recipe: "answer_sft", recipe_version: "answer-sft/0.1" });
      }
      await expect(exportApprovedDataset(build, bundles, {
        format: "canonical",
        outputDirectory: join(root, "not-hf"),
      })).rejects.toThrow("available only for HF/TRL");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("audits every compiled view and blocks a duplicated answer view across splits", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-recipe-view-dedupe-"));
    const left = distinctBundle("1".repeat(32), "shared licensed answer", true);
    const right = distinctBundle("2".repeat(32), "shared licensed answer", true);
    appendAssistantMessage(left, "left-only continuation", "answer-left");
    appendAssistantMessage(right, "right-only continuation", "answer-right");
    reapprove(left);
    reapprove(right);
    const splitPolicy: DatasetBuild["split_policy"] = {
      algorithm: "sha256-group-threshold-v1",
      seed: "recipe-view-cross-split",
      ratios_bp: { train: 5000, validation: 0, test: 5000 },
    };
    const build = buildFor([left, right], {
      mode: "training_competitive_distillation",
      target: { model_owner: "owner", product: "open-model" },
      view_recipe: "answer_sft",
      quality_profile: "sft_basic",
      split_policy: splitPolicy,
    });
    build.traces[0]!.split_group_id = groupForSplit(splitPolicy, "train");
    build.traces[1]!.split_group_id = groupForSplit(splitPolicy, "test");
    try {
      const audit = inspectDatasetBuild(build, [left, right]);
      expect(audit.training_views).toHaveLength(4);
      expect(audit.near_duplicate_scan.record_count).toBe(4);
      expect(audit.blocked_reasons).toContain("DATASET_EXACT_CROSS_SPLIT_DUPLICATE");
      await expect(exportApprovedDataset(build, [left, right], {
        format: "hf-trl",
        outputDirectory: join(root, "blocked"),
      })).rejects.toThrow("DATASET_EXACT_CROSS_SPLIT_DUPLICATE");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deduplicates each trace_full branch instead of hiding overlap in the whole trace", () => {
    const left = branchingBundle("3".repeat(32), "left-only branch");
    const right = branchingBundle("4".repeat(32), "right-only branch");
    const splitPolicy: DatasetBuild["split_policy"] = {
      algorithm: "sha256-group-threshold-v1",
      seed: "trace-full-branch-cross-split",
      ratios_bp: { train: 5000, validation: 0, test: 5000 },
    };
    const build = buildFor([left, right], {
      mode: "training_competitive_distillation",
      target: { model_owner: "owner", product: "open-model" },
      view_recipe: "trace_full",
      quality_profile: "sft_basic",
      split_policy: splitPolicy,
    });
    build.traces[0]!.split_group_id = groupForSplit(splitPolicy, "train");
    build.traces[1]!.split_group_id = groupForSplit(splitPolicy, "test");
    const audit = inspectDatasetBuild(build, [left, right]);
    expect(audit.training_views).toHaveLength(4);
    expect(audit.near_duplicate_scan.record_count).toBe(4);
    expect(audit.blocked_reasons).toContain("DATASET_EXACT_CROSS_SPLIT_DUPLICATE");
  });

  it("blocks a frozen recipe when a selected trace has no eligible view", () => {
    const bundle = distinctBundle("c".repeat(32), "answer-only trace", true);
    const build = buildFor([bundle], {
      mode: "training_competitive_distillation",
      target: { model_owner: "owner", product: "open-model" },
      view_recipe: "tool_use_sft",
      quality_profile: "sft_basic",
    });
    expect(() => inspectDatasetBuild(build, [bundle])).toThrow("VIEW_RECIPE_NO_ELIGIBLE_VIEWS");
  });

  it.skipIf(!HAS_HF_PYTHON)("loads native nested Parquet with Hugging Face Datasets when the optional Python stack is installed", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-hf-loader-"));
    const bundle = distinctBundle("8".repeat(32), "native nested conversational parquet", true);
    const build = buildFor([bundle], {
      mode: "training_competitive_distillation",
      target: { model_owner: "owner", product: "open-model" },
      split_policy: {
        algorithm: "sha256-group-threshold-v1",
        seed: "hf-loader",
        ratios_bp: { train: 10_000, validation: 0, test: 0 },
      },
    });
    try {
      const output = join(root, "dataset");
      await exportApprovedDataset(build, [bundle], { format: "hf-trl", outputDirectory: output });
      const result = spawnSync("python", ["-c", [
        "from datasets import load_dataset",
        "import sys",
        "row=load_dataset('parquet', data_files=sys.argv[1], split='train')[0]",
        "assert isinstance(row['messages'], list) and row['messages'][0]['role']=='assistant'",
        "assert isinstance(row['assistant_loss_mask'], list)",
      ].join(";"), join(output, "splits", "train", "dataset.parquet")], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
