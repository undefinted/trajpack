import { randomBytes } from "node:crypto";
import { lstat, open, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ApprovalMode, DatasetBuild, DatasetTarget, DatasetViewRecipe, TraceBundle } from "@trajpack/schema";
import {
  DATASET_BUILD_VERSION,
  DATASET_VIEW_RECIPE_VERSIONS,
  datasetBuildSchema,
  migrateDatasetBuild,
} from "@trajpack/schema";
import {
  approvalFingerprint,
  assertSafeOutputParent,
  canonicalJson,
  datasetCompilerVersionsForRecipe,
  datasetTraceBlockReasons,
  explicitGroupId,
  inspectDatasetBuild,
  POLICY_VERSION,
  sha256,
  traceFallbackGroupId,
} from "@trajpack/core";
import { readPassphrase } from "./secret.js";
import { loadManagedBundlesBounded } from "./dataset-memory.js";

const MAX_BUILD_FILE_BYTES = 4 * 1024 * 1024;
const MAX_GROUP_MAP_BYTES = 1024 * 1024;
const TRACE_ID = /^[a-f0-9]{32}$/u;

export interface DatasetPlanOptions {
  output: string;
  name: string;
  mode: ApprovalMode;
  seed: string;
  train?: string | number;
  validation?: string | number;
  test?: string | number;
  groupMap?: string;
  qualityProfile?: "sft_basic" | "tool_agent_strict" | "research_strict";
  recipe?: DatasetViewRecipe;
  targetModelOwner?: string;
  targetProduct?: string;
}

async function readBoundedRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  const absolute = resolve(path);
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Expected a regular non-symlink file: ${absolute}`);
  if (before.size > maxBytes) throw new Error(`File exceeds the ${maxBytes}-byte limit: ${absolute}`);
  const handle = await open(absolute, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.size > maxBytes) {
      throw new Error(`File changed while opening: ${absolute}`);
    }
    const buffer = Buffer.allocUnsafe(opened.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset !== opened.size) throw new Error(`File changed while reading: ${absolute}`);
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

export async function readDatasetBuildFile(path: string): Promise<DatasetBuild> {
  const bytes = await readBoundedRegularFile(path, MAX_BUILD_FILE_BYTES);
  return datasetBuildSchema.parse(JSON.parse(bytes.toString("utf8")));
}

export async function runDatasetMigrate(inputPath: string, outputPath: string): Promise<DatasetBuild> {
  const bytes = await readBoundedRegularFile(inputPath, MAX_BUILD_FILE_BYTES);
  const input = JSON.parse(bytes.toString("utf8")) as unknown;
  if (input && typeof input === "object" && !Array.isArray(input)
    && (input as { schema_version?: unknown }).schema_version === DATASET_BUILD_VERSION) {
    throw new Error(`Dataset build is already ${DATASET_BUILD_VERSION}`);
  }
  const migrated = migrateDatasetBuild(input);
  const requestedOutput = resolve(outputPath);
  const parent = await assertSafeOutputParent(dirname(requestedOutput));
  const output = join(parent, basename(requestedOutput));
  await writeFile(output, `${canonicalJson(migrated)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    output,
    schema_version: migrated.schema_version,
    build_sha256: sha256(canonicalJson(migrated)),
  }, null, 2)}\n`);
  return migrated;
}

async function readGroupMap(path: string | undefined, traceIds: string[]): Promise<Map<string, string>> {
  if (path === undefined) return new Map();
  const parsed = JSON.parse((await readBoundedRegularFile(path, MAX_GROUP_MAP_BYTES)).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Dataset group map must be a JSON object mapping exact trace ids to private aliases");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  const expected = new Set(traceIds);
  if (entries.length !== expected.size || entries.some(([traceId]) => !expected.has(traceId))) {
    throw new Error("Dataset group map must contain every selected trace id exactly once and no extra ids");
  }
  const result = new Map<string, string>();
  for (const [traceId, alias] of entries) {
    if (typeof alias !== "string") throw new Error(`Dataset group alias for ${traceId} must be a string`);
    result.set(traceId, alias);
  }
  return result;
}

function basisPoints(value: string | number | undefined, fallback: number, label: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10_000) {
    throw new Error(`${label} must be an integer from 0 to 10000 basis points`);
  }
  return parsed;
}

function decisionFor(bundle: TraceBundle, mode: ApprovalMode) {
  return mode === "archive" ? bundle.manifest.eligibility.local_archive : bundle.manifest.eligibility[mode];
}

function targetFor(options: DatasetPlanOptions): DatasetTarget | null {
  const training = options.mode === "training_noncompetitive" || options.mode === "training_competitive_distillation";
  if (!training) {
    if (options.targetModelOwner !== undefined || options.targetProduct !== undefined) {
      throw new Error("Only training dataset plans accept a target model");
    }
    return null;
  }
  if (!options.targetModelOwner?.trim() || !options.targetProduct?.trim()) {
    throw new Error("Training dataset plans require --target-model-owner and --target-product");
  }
  return { model_owner: options.targetModelOwner.trim(), product: options.targetProduct.trim() };
}

export async function runDatasetPlan(traceIdsInput: string[], options: DatasetPlanOptions): Promise<DatasetBuild> {
  const traceIds = [...traceIdsInput];
  if (traceIds.length === 0 || traceIds.length > 10_000 || traceIds.some((traceId) => !TRACE_ID.test(traceId))) {
    throw new Error("Dataset plan requires between 1 and 10000 exact managed trace ids");
  }
  if (new Set(traceIds).size !== traceIds.length) throw new Error("Dataset plan cannot contain duplicate trace ids");
  traceIds.sort();
  const groups = await readGroupMap(options.groupMap, traceIds);
  const ratios = {
    train: basisPoints(options.train, 8000, "--train"),
    validation: basisPoints(options.validation, 1000, "--validation"),
    test: basisPoints(options.test, 1000, "--test"),
  };
  if (ratios.train + ratios.validation + ratios.test !== 10_000) {
    throw new Error("Dataset split ratios must total 10000 basis points");
  }
  const target = targetFor(options);
  const viewRecipe = options.recipe ?? "trace_full";
  const passphrase = await readPassphrase();
  const bundles = await loadManagedBundlesBounded(traceIds, passphrase);
  const groupSecret = groups.size === 0 ? null : randomBytes(32);
  let frozenTraces: DatasetBuild["traces"];
  try {
    frozenTraces = bundles.map((bundle) => {
      const traceId = bundle.manifest.trace_id;
      const decision = decisionFor(bundle, options.mode);
      const reasons = datasetTraceBlockReasons(bundle, {
        mode: options.mode,
        target,
        qualityProfile: options.qualityProfile ?? "research_strict",
        viewRecipe,
      });
      if (reasons.length > 0) {
        throw new Error(`Cannot freeze blocked trace ${traceId}: ${[...new Set(reasons)].join(", ")}`);
      }
      const scope = bundle.manifest.review.approval_scope;
      if (scope === null) throw new Error(`Cannot freeze trace ${traceId} without an approval scope`);
      const alias = groups.get(traceId);
      return {
        trace_id: traceId,
        split_group_id: alias === undefined
          ? traceFallbackGroupId(traceId)
          : explicitGroupId(alias, groupSecret!),
        group_basis: alias === undefined ? "trace_fallback" : "explicit_hmac",
        source_bundle_sha256: approvalFingerprint(bundle),
        approval_scope_sha256: sha256(canonicalJson(scope)),
        eligibility_decision_id: decision.decision_id,
      };
    });
  } finally {
    groupSecret?.fill(0);
  }
  const build = datasetBuildSchema.parse({
    record_type: "dataset_build",
    schema_version: DATASET_BUILD_VERSION,
    name: options.name,
    policy_version: POLICY_VERSION,
    mode: options.mode,
    target,
    view_recipe: viewRecipe,
    view_recipe_version: DATASET_VIEW_RECIPE_VERSIONS[viewRecipe],
    quality_profile: options.qualityProfile ?? "research_strict",
    compiler_versions: datasetCompilerVersionsForRecipe(viewRecipe),
    split_policy: {
      algorithm: "sha256-group-threshold-v1",
      seed: options.seed,
      ratios_bp: ratios,
    },
    traces: frozenTraces,
  });
  const audit = inspectDatasetBuild(build, bundles);
  if (audit.blocked_reasons.length > 0) {
    throw new Error(`Cannot freeze dataset plan: ${audit.blocked_reasons.join(", ")}`);
  }
  const requestedOutput = resolve(options.output);
  const parent = await assertSafeOutputParent(dirname(requestedOutput));
  const output = join(parent, basename(requestedOutput));
  await writeFile(output, `${canonicalJson(build)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    output,
    build_sha256: sha256(canonicalJson(build)),
    traces: build.traces.length,
    mode: build.mode,
    target: build.target,
    warning: groups.size === 0
      ? "Trace-fallback grouping is not sufficient for the research_strict profile; provide --group-map before export."
      : null,
  }, null, 2)}\n`);
  return build;
}
