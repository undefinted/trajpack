import { createHash, createHmac, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type {
  ApprovalMode,
  DatasetBuild,
  DatasetExample,
  DatasetManifest,
  DatasetManifestEntry,
  DatasetSplit,
  DatasetSplitPolicy,
  TraceBundle,
} from "@trajpack/schema";
import {
  DATASET_DEDUPE_COMPILER_VERSION,
  DATASET_QUALITY_COMPILER_VERSION,
  DATASET_VIEW_COMPILER_VERSION,
  datasetBuildSchema,
  datasetExampleSchema,
  datasetManifestSchema,
  traceBundleSchema,
} from "@trajpack/schema";
import { approvalFingerprint, evaluateGate, POLICY_VERSION, validateApprovalScope } from "./policy.js";
import { canonicalJson, sha256 } from "./canonical.js";
import { exportApprovedBundle, type ExportFormat } from "./exporters.js";
import { HF_PARQUET_SCHEMA_VERSION, writeHfParquet } from "./hf-parquet.js";
export { validateHfParquetFile } from "./hf-parquet.js";
import { inspectQuality } from "./quality.js";
import { assertSafeOutputParent } from "./safe-path.js";
import { structuredToolProjectionExcluded } from "./selection.js";

export const CURRENT_DATASET_COMPILER_VERSIONS: DatasetBuild["compiler_versions"] = Object.freeze({
  view: DATASET_VIEW_COMPILER_VERSION,
  quality: DATASET_QUALITY_COMPILER_VERSION,
  dedupe: DATASET_DEDUPE_COMPILER_VERSION,
});

export const DATASET_EXPORT_MAPPING: Readonly<Record<ExportFormat, string>> = Object.freeze({
  canonical: "trajectory/0.1+dataset/0.1",
  atif: "ATIF-v1.7",
  "hf-trl": "hf-trl-conversational/0.3+hf-conversational-parquet/0.2",
  otlp: "otel-genai-development-2026-08-16",
});

/**
 * Frozen with DATASET_DEDUPE_COMPILER_VERSION. The candidate pass uses an
 * inverted index over one-way feature hashes and therefore has no false
 * negatives below its explicit resource limits; candidates are accepted only
 * after an exact set Jaccard calculation.
 */
export const DATASET_NEAR_DUPLICATE_CONFIG = Object.freeze({
  algorithm: "canonical-shingle-inverted-index-jaccard/0.1",
  shingle_version: "canonical-token-code-tool-shingles/0.1",
  threshold_bp: 8_000,
  max_records: 10_000,
  max_source_utf8_bytes_per_trace: 16 * 1024 * 1024,
  max_source_utf8_bytes_total: 256 * 1024 * 1024,
  max_features_per_trace: 65_536,
  max_features_total: 500_000,
  max_postings_per_shingle: 512,
  max_candidate_pairs: 250_000,
  max_jaccard_feature_visits: 10_000_000,
});

const STRICT_QUALITY_WARNINGS = new Set([
  "PARTIAL_EVENTS_PRESENT",
  "COMPACTION_BOUNDARY_MISMATCH",
  "COMPACTION_FAILED",
  "SUBAGENT_CORRELATION_ID_MISSING",
  "ORPHAN_HANDOFF",
  "SUBAGENT_HANDOFF_MISSING",
  "SUBAGENT_TOPOLOGY_EDGE_MISSING",
  "REPO_COMMIT_EVIDENCE_MISSING",
  "TEST_EVIDENCE_MISSING",
  "VERIFIER_VERSION_EVIDENCE_MISSING",
  "NEAR_DUPLICATE_SCAN_TRUNCATED",
  "ENVIRONMENT_OBSERVATION_MISSING",
  "ENVIRONMENT_RESULT_MISSING",
  "VERIFICATION_EVIDENCE_MISSING",
]);

const TOOL_QUALITY_WARNINGS = new Set([
  "PARTIAL_EVENTS_PRESENT",
  "COMPACTION_BOUNDARY_MISMATCH",
  "SUBAGENT_CORRELATION_ID_MISSING",
  "ORPHAN_HANDOFF",
  "SUBAGENT_HANDOFF_MISSING",
  "SUBAGENT_TOPOLOGY_EDGE_MISSING",
]);

export interface DatasetExportOptions {
  format: ExportFormat;
  outputDirectory: string;
  createdAt?: Date;
}

export interface DatasetExportResult {
  directory: string;
  datasetId: string;
  manifest: DatasetManifest;
  files: string[];
  checksums: Record<string, string>;
}

interface PreparedTrace {
  bundle: TraceBundle;
  buildTrace: DatasetBuild["traces"][number];
  split: DatasetSplit;
}

interface SelectedTraceArtifact extends PreparedTrace {
  selected: TraceBundle;
  selectedBundleSha256: string;
  exampleIds: string[];
  directory: string;
}

export interface DatasetAudit {
  schema_version: "dataset-audit/0.2";
  profile: DatasetBuild["quality_profile"];
  compiler_versions: DatasetBuild["compiler_versions"];
  trace_count: number;
  fallback_group_count: number;
  training_views: Array<{
    trace_id: string;
    split: DatasetSplit;
    view_sha256: string;
    part_count: number;
    near_shingle_count: number;
  }>;
  exact_within_split_duplicates: Array<{ view_sha256: string; split: DatasetSplit; trace_ids: string[] }>;
  exact_cross_split_duplicates: Array<{ view_sha256: string; splits: DatasetSplit[]; trace_ids: string[] }>;
  near_duplicate_candidates: Array<{
    signature_sha256: string;
    similarity_bp: number;
    splits: DatasetSplit[];
    trace_ids: [string, string];
  }>;
  near_duplicate_scan: {
    algorithm: typeof DATASET_NEAR_DUPLICATE_CONFIG.algorithm;
    shingle_version: typeof DATASET_NEAR_DUPLICATE_CONFIG.shingle_version;
    threshold_bp: number;
    status: "complete" | "resource_limit_exceeded";
    reason_code: string | null;
    record_count: number;
    feature_count: number;
    candidate_pair_count: number;
    compared_pair_count: number;
    resource_limits_sha256: string;
  };
  partial_content_overlap: Array<{ part_sha256: string; splits: DatasetSplit[]; trace_ids: string[] }>;
  same_repo_commit_cross_split: Array<{ repo_commit_sha256: string; splits: DatasetSplit[]; trace_ids: string[] }>;
  lineage_cross_split: Array<{ component_id: string; splits: DatasetSplit[]; trace_ids: string[] }>;
  blocked_reasons: string[];
  warnings: string[];
}

export interface DatasetStats {
  schema_version: "dataset-stats/0.1";
  traces: number;
  events: number;
  examples: number;
  sources: {
    providers: Record<string, number>;
    models: Record<string, number>;
    authenticity: Record<string, number>;
    capture_methods: Record<string, number>;
  };
  rights: {
    source_licenses: Record<string, number>;
    model_licenses: Record<string, number>;
    input_rights: Record<string, number>;
    third_party_content: Record<string, number>;
  };
  redaction: Record<string, number>;
  quality: {
    passed: number;
    failed: number;
    issue_codes: Record<string, number>;
  };
  labels: {
    observed_numeric_rewards: number;
    versioned_verifier_events: number;
    verifier_identities: Record<string, number>;
  };
}

function decisionFor(bundle: TraceBundle, mode: ApprovalMode) {
  return mode === "archive" ? bundle.manifest.eligibility.local_archive : bundle.manifest.eligibility[mode];
}

export function splitForGroup(policy: DatasetSplitPolicy, groupId: string): DatasetSplit {
  const digest = sha256(`trajpack.split/v1\0${policy.seed}\0${groupId}`);
  const bucket = Number(BigInt(`0x${digest.slice(0, 16)}`) % 10_000n);
  if (bucket < policy.ratios_bp.train) return "train";
  if (bucket < policy.ratios_bp.train + policy.ratios_bp.validation) return "validation";
  return "test";
}

export function traceFallbackGroupId(traceId: string): string {
  return sha256(`trajpack.group/trace-fallback/v1\0${traceId}`);
}

export function explicitGroupId(privateGroupAlias: string, secret: Uint8Array): string {
  const normalized = privateGroupAlias.normalize("NFKC").trim();
  if (!normalized || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error("Dataset group aliases must be non-empty text without control characters");
  }
  if (secret.byteLength < 32) throw new Error("Dataset group HMAC secrets must contain at least 256 bits");
  return createHmac("sha256", secret)
    .update("trajpack.group/explicit-hmac/v1\0", "utf8")
    .update(normalized, "utf8")
    .digest("hex");
}

export function computeDatasetId(
  build: DatasetBuild,
  entries: DatasetManifestEntry[],
  format: ExportFormat,
): string {
  const parsedBuild = datasetBuildSchema.parse(build);
  return sha256(canonicalJson({
    build: {
      ...parsedBuild,
      traces: [...parsedBuild.traces]
        .sort((left, right) => left.trace_id < right.trace_id ? -1 : left.trace_id > right.trace_id ? 1 : 0),
    },
    entries: [...entries]
      .sort((left, right) => left.trace_id < right.trace_id ? -1 : left.trace_id > right.trace_id ? 1 : 0)
      .map((entry) => ({
        trace_id: entry.trace_id,
        split: entry.split,
        split_group_id: entry.split_group_id,
        source_bundle_sha256: entry.source_bundle_sha256,
        approval_scope_sha256: entry.approval_scope_sha256,
        eligibility_decision_id: entry.eligibility_decision_id,
        selected_bundle_sha256: entry.selected_bundle_sha256,
        example_ids: entry.example_ids,
      })),
    policy_version: build.policy_version,
    format,
    mapping_version: DATASET_EXPORT_MAPPING[format],
  }));
}

function validatePreparedTrace(build: DatasetBuild, prepared: PreparedTrace): void {
  const { bundle, buildTrace } = prepared;
  if (bundle.manifest.trace_id !== buildTrace.trace_id) throw new Error(`Dataset trace id mismatch: ${buildTrace.trace_id}`);
  const sourceHash = approvalFingerprint(bundle);
  const scope = bundle.manifest.review.approval_scope;
  const scopeHash = scope === null ? null : sha256(canonicalJson(scope));
  const decision = decisionFor(bundle, build.mode);
  const stale: string[] = [];
  if (sourceHash !== buildTrace.source_bundle_sha256) stale.push("source bundle");
  if (scopeHash !== buildTrace.approval_scope_sha256) stale.push("approval scope");
  if (decision.decision_id !== buildTrace.eligibility_decision_id) stale.push("eligibility decision");
  if (stale.length > 0) throw new Error(`Dataset selection is stale for ${buildTrace.trace_id}: ${stale.join(", ")}`);

  const reasons = datasetTraceBlockReasons(bundle, {
    mode: build.mode,
    target: build.target,
    qualityProfile: build.quality_profile,
  });
  if (reasons.length > 0) {
    throw new Error(`Dataset trace ${buildTrace.trace_id} is blocked: ${[...new Set(reasons)].join(", ")}`);
  }
}

export interface DatasetTraceValidationOptions {
  mode: ApprovalMode;
  target: DatasetBuild["target"];
  qualityProfile: DatasetBuild["quality_profile"];
}

/** The exact per-trace preflight used by both `dataset plan` and export. */
export function datasetTraceBlockReasons(
  bundle: TraceBundle,
  options: DatasetTraceValidationOptions,
): string[] {
  const decision = decisionFor(bundle, options.mode);
  const gate = evaluateGate(bundle, options.mode);
  const reasons = [
    ...gate.reasonCodes,
    ...validateApprovalScope(bundle, options.mode),
    ...(bundle.manifest.review.automated_checks === "passed" ? [] : ["AUTOMATED_CHECKS_NOT_PASSED"]),
  ];
  if (options.target !== null) {
    if (decision.target_model_owner !== options.target.model_owner || decision.target_product !== options.target.product) {
      reasons.push("DATASET_TARGET_MISMATCH");
    }
    if (options.mode === "training_noncompetitive" && decision.competitive_with_source !== "no") {
      reasons.push("NONCOMPETITIVE_DECISION_REQUIRED");
    }
    if (options.mode === "training_competitive_distillation" && decision.competitive_with_source !== "yes") {
      reasons.push("COMPETITIVE_DECISION_REQUIRED");
    }
  }
  const quality = inspectQuality(bundle);
  if (!quality.passed) reasons.push("TRACE_QUALITY_FAILED");
  const warningGate = options.qualityProfile === "research_strict"
    ? STRICT_QUALITY_WARNINGS
    : options.qualityProfile === "tool_agent_strict"
      ? TOOL_QUALITY_WARNINGS
      : new Set<string>();
  for (const issue of quality.issues) {
    if (issue.severity === "warning" && warningGate.has(issue.code)) reasons.push(`QUALITY_${issue.code}`);
  }
  return [...new Set(reasons)];
}

interface TrainingViewFingerprint {
  viewSha256: string;
  partSha256: string[];
  nearFeatureSha256: string[];
  nearSignatureSha256: string | null;
  nearSourceUtf8Bytes: number;
  nearFailureReason: string | null;
}

type DedupeFieldKind = "natural" | "code";

function dedupeTokens(value: string, kind: DedupeFieldKind): string[] {
  const normalized = value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .trim();
  if (normalized.length === 0) return [];
  if (kind === "natural") {
    // Natural-language terminal punctuation and layout are intentionally not
    // semantic. CJK scripts are separated into code-point tokens so an entire
    // paragraph does not collapse into one all-or-nothing token.
    const folded = normalized.toLowerCase();
    const cjkSegmented = folded.replace(/([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, " $1 ");
    return cjkSegmented.match(/[\p{L}\p{N}_]+/gu) ?? [folded];
  }
  // Code, patches, and structured tool payloads preserve operators while
  // normalizing layout. Identifiers are not split differently across hosts.
  return normalized.match(/[\p{L}_$][\p{L}\p{N}_$]*|\p{N}+(?:\.\p{N}+)?|[^\p{Z}\p{C}]/gu) ?? [normalized];
}

function addDedupeField(
  features: Set<string>,
  prefix: string,
  value: string,
  kind: DedupeFieldKind,
  budget: { sourceBytes: number; failureReason: string | null },
): void {
  if (budget.failureReason !== null) return;
  budget.sourceBytes += Buffer.byteLength(value, "utf8");
  if (budget.sourceBytes > DATASET_NEAR_DUPLICATE_CONFIG.max_source_utf8_bytes_per_trace) {
    budget.failureReason = "DEDUPE_SOURCE_BYTES_PER_TRACE_LIMIT";
    return;
  }
  const tokens = dedupeTokens(value, kind);
  if (tokens.length === 0) return;
  const width = Math.min(3, tokens.length);
  for (let index = 0; index <= tokens.length - width; index += 1) {
    const shingle = tokens.slice(index, index + width).join("\u001f");
    features.add(sha256(`trajpack.dataset-shingle/v1\0${prefix}\0${kind}\0${shingle}`));
    if (features.size > DATASET_NEAR_DUPLICATE_CONFIG.max_features_per_trace) {
      budget.failureReason = "DEDUPE_FEATURES_PER_TRACE_LIMIT";
      return;
    }
  }
}

function selectedNearDuplicateFeatures(view: Array<{
  actor: string;
  event_type: string;
  content: Array<{ type: string; mime_type: string; value: string | null; blob_ref: string | null; sha256: string }>;
  tool: { name: string | null; arguments: unknown; result: unknown } | null;
}>): Pick<TrainingViewFingerprint,
  "nearFeatureSha256" | "nearSignatureSha256" | "nearSourceUtf8Bytes" | "nearFailureReason"> {
  const features = new Set<string>();
  const budget = { sourceBytes: 0, failureReason: null as string | null };
  for (const event of view) {
    for (const part of event.content) {
      const prefix = `${event.actor}\0${event.event_type}\0content\0${part.type}`;
      if (part.value !== null) {
        const codeMime = /(?:json|javascript|typescript|python|shell|x-sh|diff|patch|source|code)/iu.test(part.mime_type);
        const kind: DedupeFieldKind = codeMime || part.type === "patch" || part.type === "file_ref"
          || part.type === "stdout" || part.type === "stderr" || part.type === "tool_call"
          ? "code"
          : "natural";
        addDedupeField(features, prefix, part.value, kind, budget);
      } else if (part.blob_ref !== null) {
        features.add(sha256(`trajpack.dataset-shingle/v1\0${prefix}\0blob-sha256\0${part.sha256}`));
      }
    }
    if (event.tool !== null) {
      const toolPrefix = `${event.actor}\0${event.event_type}\0tool\0${event.tool.name ?? "unknown"}`;
      for (const [field, value] of [["arguments", event.tool.arguments], ["result", event.tool.result]] as const) {
        if (value === null || value === undefined) continue;
        const serialized = typeof value === "string" ? value : canonicalJson(value);
        addDedupeField(features, `${toolPrefix}\0${field}`, serialized, typeof value === "string" ? "natural" : "code", budget);
      }
      if (event.tool.arguments === null && event.tool.result === null) {
        features.add(sha256(`trajpack.dataset-shingle/v1\0${toolPrefix}\0empty-tool`));
      }
    }
    if (budget.failureReason !== null) break;
  }
  if (features.size === 0 && budget.failureReason === null) {
    features.add(sha256("trajpack.dataset-shingle/v1\0empty-training-view"));
  }
  const nearFeatureSha256 = [...features].sort();
  return {
    nearFeatureSha256,
    nearSignatureSha256: budget.failureReason === null
      ? sha256(canonicalJson({
        compiler: DATASET_DEDUPE_COMPILER_VERSION,
        shingle_version: DATASET_NEAR_DUPLICATE_CONFIG.shingle_version,
        feature_sha256: nearFeatureSha256,
      }))
      : null,
    nearSourceUtf8Bytes: budget.sourceBytes,
    nearFailureReason: budget.failureReason,
  };
}

function selectedTrainingViewFingerprint(
  prepared: PreparedTrace,
  mode: ApprovalMode,
  globalNearBudget?: { sourceBytes: number; features: number; failureReason: string | null },
): TrainingViewFingerprint {
  const excluded = new Set(evaluateGate(prepared.bundle, mode).excludedContentParts
    .map((part) => `${part.eventId}\0${part.ordinal}`));
  const view = [...prepared.bundle.events]
    .sort((left, right) => left.sequence - right.sequence
      || (left.event_id < right.event_id ? -1 : left.event_id > right.event_id ? 1 : 0))
    .filter((event) => event.review_disposition === "include")
    .filter((event) => !structuredToolProjectionExcluded(event, excluded))
    .map((event) => ({
      actor: event.actor,
      event_type: event.event_type,
      status: event.status,
      content: event.content
        .filter((part) => part.review_disposition === "include")
        .filter((part) => !excluded.has(`${event.event_id}\0${part.ordinal}`))
        .filter((part) => part.reasoning?.representation !== "opaque_reasoning_state")
        .map((part) => ({
          type: part.type,
          mime_type: part.mime_type,
          value: part.value,
          blob_ref: part.value === null ? part.blob_ref : null,
          sha256: part.sha256,
          reasoning: part.reasoning === null ? null : {
            representation: part.reasoning.representation,
            include_in_loss: part.reasoning.include_in_loss,
          },
        })),
      tool: event.tool === null ? null : {
        name: event.tool.name,
        arguments: event.tool.arguments,
        result: event.tool.result,
        exit_code: event.tool.exit_code,
      },
      training_metadata: {
        ...(event.metadata.tool_schema === undefined ? {} : { tool_schema: event.metadata.tool_schema }),
        ...(event.metadata.input_schema === undefined ? {} : { input_schema: event.metadata.input_schema }),
      },
    }));
  const partSha256 = view.flatMap((event) => [
    ...event.content.map((part) => sha256(canonicalJson({
      actor: event.actor,
      event_type: event.event_type,
      part,
    }))),
    ...(event.tool === null ? [] : [sha256(canonicalJson({
      actor: event.actor,
      event_type: event.event_type,
      tool: event.tool,
      training_metadata: event.training_metadata,
    }))]),
  ]);
  let near = globalNearBudget?.failureReason
    ? {
      nearFeatureSha256: [],
      nearSignatureSha256: null,
      nearSourceUtf8Bytes: 0,
      nearFailureReason: globalNearBudget.failureReason,
    }
    : selectedNearDuplicateFeatures(view);
  if (globalNearBudget !== undefined && globalNearBudget.failureReason === null) {
    globalNearBudget.sourceBytes += near.nearSourceUtf8Bytes;
    globalNearBudget.features += near.nearFeatureSha256.length;
    if (near.nearFailureReason !== null) {
      globalNearBudget.failureReason = near.nearFailureReason;
    } else if (globalNearBudget.sourceBytes > DATASET_NEAR_DUPLICATE_CONFIG.max_source_utf8_bytes_total) {
      globalNearBudget.failureReason = "DEDUPE_SOURCE_BYTES_TOTAL_LIMIT";
    } else if (globalNearBudget.features > DATASET_NEAR_DUPLICATE_CONFIG.max_features_total) {
      globalNearBudget.failureReason = "DEDUPE_FEATURES_TOTAL_LIMIT";
    }
    if (globalNearBudget.failureReason !== null) {
      near = {
        nearFeatureSha256: [],
        nearSignatureSha256: null,
        nearSourceUtf8Bytes: near.nearSourceUtf8Bytes,
        nearFailureReason: globalNearBudget.failureReason,
      };
    }
  }
  return {
    viewSha256: sha256(canonicalJson({
      compiler: DATASET_DEDUPE_COMPILER_VERSION,
      events: view,
    })),
    partSha256,
    ...near,
  };
}

function groupedWithinSplit<T extends { split: DatasetSplit; traceId: string }>(
  entries: Array<T & { key: string }>,
): Array<{ key: string; split: DatasetSplit; traceIds: string[] }> {
  const grouped = new Map<string, Array<T & { key: string }>>();
  for (const entry of entries) {
    const groupingKey = `${entry.key}\0${entry.split}`;
    grouped.set(groupingKey, [...(grouped.get(groupingKey) ?? []), entry]);
  }
  return [...grouped.values()].flatMap((values) => {
    const traceIds = [...new Set(values.map((value) => value.traceId))].sort();
    return traceIds.length > 1 ? [{ key: values[0]!.key, split: values[0]!.split, traceIds }] : [];
  }).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

function groupedCrossSplit<T extends { split: DatasetSplit; traceId: string }>(
  entries: Array<T & { key: string }>,
): Array<{ key: string; splits: DatasetSplit[]; traceIds: string[] }> {
  const grouped = new Map<string, Array<T & { key: string }>>();
  for (const entry of entries) grouped.set(entry.key, [...(grouped.get(entry.key) ?? []), entry]);
  return [...grouped.entries()].flatMap(([key, values]) => {
    const splits = [...new Set(values.map((value) => value.split))].sort() as DatasetSplit[];
    if (splits.length < 2) return [];
    return [{
      key,
      splits,
      traceIds: [...new Set(values.map((value) => value.traceId))].sort(),
    }];
  }).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

export interface DatasetDedupeFeatureSet {
  trace_id: string;
  split: DatasetSplit;
  view_sha256: string;
  signature_sha256: string;
  feature_sha256: string[];
}

export interface DatasetNearDuplicateInspection {
  candidates: DatasetAudit["near_duplicate_candidates"];
  scan: DatasetAudit["near_duplicate_scan"];
}

function incompleteNearDuplicateScan(
  reasonCode: string,
  recordCount: number,
  featureCount: number,
  candidatePairCount: number,
  comparedPairCount = 0,
): DatasetNearDuplicateInspection {
  return {
    candidates: [],
    scan: {
      algorithm: DATASET_NEAR_DUPLICATE_CONFIG.algorithm,
      shingle_version: DATASET_NEAR_DUPLICATE_CONFIG.shingle_version,
      threshold_bp: DATASET_NEAR_DUPLICATE_CONFIG.threshold_bp,
      status: "resource_limit_exceeded",
      reason_code: reasonCode,
      record_count: recordCount,
      feature_count: featureCount,
      candidate_pair_count: candidatePairCount,
      compared_pair_count: comparedPairCount,
      resource_limits_sha256: sha256(canonicalJson(DATASET_NEAR_DUPLICATE_CONFIG)),
    },
  };
}

/**
 * Low-level deterministic inspection over privacy-safe feature digests. The
 * canonical compiler above is the only producer used by dataset export; this
 * function is exported so validators and large-scale regression tests can
 * exercise the bounded candidate engine without materializing raw prompts.
 */
export function inspectDatasetNearDuplicateFeatureSets(
  inputRecords: DatasetDedupeFeatureSet[],
  preflightFailureReason: string | null = null,
): DatasetNearDuplicateInspection {
  if (preflightFailureReason !== null) {
    return incompleteNearDuplicateScan(preflightFailureReason, inputRecords.length, 0, 0);
  }
  if (inputRecords.length > DATASET_NEAR_DUPLICATE_CONFIG.max_records) {
    return incompleteNearDuplicateScan("DEDUPE_RECORD_LIMIT", inputRecords.length, 0, 0);
  }
  let declaredFeatureCount = 0;
  for (const record of inputRecords) {
    if (record.feature_sha256.length > DATASET_NEAR_DUPLICATE_CONFIG.max_features_per_trace) {
      return incompleteNearDuplicateScan("DEDUPE_FEATURES_PER_TRACE_LIMIT", inputRecords.length, declaredFeatureCount, 0);
    }
    declaredFeatureCount += record.feature_sha256.length;
    if (declaredFeatureCount > DATASET_NEAR_DUPLICATE_CONFIG.max_features_total) {
      return incompleteNearDuplicateScan("DEDUPE_FEATURES_TOTAL_LIMIT", inputRecords.length, declaredFeatureCount, 0);
    }
  }
  const records = inputRecords.map((record) => ({
    ...record,
    feature_sha256: [...new Set(record.feature_sha256)].sort(),
  })).sort((left, right) => left.trace_id < right.trace_id ? -1 : left.trace_id > right.trace_id ? 1 : 0);
  if (new Set(records.map((record) => record.trace_id)).size !== records.length) {
    throw new Error("Near-duplicate inspection trace ids must be unique");
  }
  let featureCount = 0;
  for (const record of records) {
    if (!/^[a-f0-9]{32}$/u.test(record.trace_id)
      || !/^[a-f0-9]{64}$/u.test(record.view_sha256)
      || !/^[a-f0-9]{64}$/u.test(record.signature_sha256)
      || record.feature_sha256.some((feature) => !/^[a-f0-9]{64}$/u.test(feature))) {
      throw new Error("Near-duplicate inspection accepts only canonical lowercase SHA-256 identities");
    }
    if (record.feature_sha256.length > DATASET_NEAR_DUPLICATE_CONFIG.max_features_per_trace) {
      return incompleteNearDuplicateScan("DEDUPE_FEATURES_PER_TRACE_LIMIT", records.length, featureCount, 0);
    }
    featureCount += record.feature_sha256.length;
    if (featureCount > DATASET_NEAR_DUPLICATE_CONFIG.max_features_total) {
      return incompleteNearDuplicateScan("DEDUPE_FEATURES_TOTAL_LIMIT", records.length, featureCount, 0);
    }
  }

  const postings = new Map<string, number[]>();
  for (const [index, record] of records.entries()) {
    for (const feature of record.feature_sha256) {
      const values = postings.get(feature) ?? [];
      values.push(index);
      postings.set(feature, values);
    }
  }
  const pairKeys = new Set<string>();
  for (const feature of [...postings.keys()].sort()) {
    const members = postings.get(feature)!;
    if (members.length > DATASET_NEAR_DUPLICATE_CONFIG.max_postings_per_shingle) {
      return incompleteNearDuplicateScan("DEDUPE_POSTINGS_LIMIT", records.length, featureCount, pairKeys.size);
    }
    for (let left = 0; left < members.length; left += 1) {
      for (let right = left + 1; right < members.length; right += 1) {
        pairKeys.add(`${members[left]!}:${members[right]!}`);
        if (pairKeys.size > DATASET_NEAR_DUPLICATE_CONFIG.max_candidate_pairs) {
          return incompleteNearDuplicateScan("DEDUPE_CANDIDATE_PAIR_LIMIT", records.length, featureCount, pairKeys.size);
        }
      }
    }
  }

  const candidates: DatasetAudit["near_duplicate_candidates"] = [];
  const pairs = [...pairKeys].map((key) => key.split(":").map(Number) as [number, number])
    .sort(([leftA, rightA], [leftB, rightB]) => leftA - leftB || rightA - rightB);
  const featureSets = records.map((record) => new Set(record.feature_sha256));
  let jaccardFeatureVisits = 0;
  let comparedPairCount = 0;
  for (const [leftIndex, rightIndex] of pairs) {
    const left = records[leftIndex]!;
    const right = records[rightIndex]!;
    const leftFeatures = featureSets[leftIndex]!;
    const rightFeatures = featureSets[rightIndex]!;
    const smaller = leftFeatures.size <= rightFeatures.size ? leftFeatures : rightFeatures;
    const larger = smaller === leftFeatures ? rightFeatures : leftFeatures;
    jaccardFeatureVisits += smaller.size;
    if (jaccardFeatureVisits > DATASET_NEAR_DUPLICATE_CONFIG.max_jaccard_feature_visits) {
      return incompleteNearDuplicateScan(
        "DEDUPE_JACCARD_VISIT_LIMIT",
        records.length,
        featureCount,
        pairs.length,
        comparedPairCount,
      );
    }
    let intersection = 0;
    for (const feature of smaller) if (larger.has(feature)) intersection += 1;
    comparedPairCount += 1;
    const union = leftFeatures.size + rightFeatures.size - intersection;
    if (union === 0
      || intersection * 10_000 < DATASET_NEAR_DUPLICATE_CONFIG.threshold_bp * union
      || left.view_sha256 === right.view_sha256) continue;
    const traceIds: [string, string] = [left.trace_id, right.trace_id];
    candidates.push({
      signature_sha256: sha256(`trajpack.dataset-near-duplicate-pair/v1\0${left.signature_sha256}\0${right.signature_sha256}\0${intersection}\0${union}`),
      similarity_bp: Math.floor((intersection * 10_000) / union),
      splits: [...new Set([left.split, right.split])].sort() as DatasetSplit[],
      trace_ids: traceIds,
    });
  }
  return {
    candidates,
    scan: {
      algorithm: DATASET_NEAR_DUPLICATE_CONFIG.algorithm,
      shingle_version: DATASET_NEAR_DUPLICATE_CONFIG.shingle_version,
      threshold_bp: DATASET_NEAR_DUPLICATE_CONFIG.threshold_bp,
      status: "complete",
      reason_code: null,
      record_count: records.length,
      feature_count: featureCount,
      candidate_pair_count: pairs.length,
      compared_pair_count: comparedPairCount,
      resource_limits_sha256: sha256(canonicalJson(DATASET_NEAR_DUPLICATE_CONFIG)),
    },
  };
}

function lineageCrossSplit(prepared: PreparedTrace[]): DatasetAudit["lineage_cross_split"] {
  const parents = new Map<string, string>();
  const add = (id: string): void => { if (!parents.has(id)) parents.set(id, id); };
  const find = (id: string): string => {
    add(id);
    const direct = parents.get(id)!;
    if (direct === id) return id;
    const root = find(direct);
    parents.set(id, root);
    return root;
  };
  const union = (left: string, right: string): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    // Lexical roots make component identifiers deterministic across input order.
    if (leftRoot < rightRoot) parents.set(rightRoot, leftRoot);
    else parents.set(leftRoot, rightRoot);
  };
  for (const trace of prepared) {
    const traceId = trace.bundle.manifest.trace_id;
    add(traceId);
    for (const parentId of trace.bundle.manifest.lineage.parent_trace_ids) union(traceId, parentId);
  }
  const allMembers = new Map<string, string[]>();
  for (const id of parents.keys()) {
    const root = find(id);
    allMembers.set(root, [...(allMembers.get(root) ?? []), id]);
  }
  const selected = new Map<string, PreparedTrace[]>();
  for (const trace of prepared) {
    const root = find(trace.bundle.manifest.trace_id);
    selected.set(root, [...(selected.get(root) ?? []), trace]);
  }
  return [...selected.entries()].flatMap(([root, traces]) => {
    const splits = [...new Set(traces.map((trace) => trace.split))].sort() as DatasetSplit[];
    if (splits.length < 2) return [];
    const members = [...(allMembers.get(root) ?? [])].sort();
    return [{
      component_id: sha256(`trajpack.lineage-component/v1\0${canonicalJson(members)}`),
      splits,
      trace_ids: traces.map((trace) => trace.bundle.manifest.trace_id).sort(),
    }];
  }).sort((left, right) => left.component_id < right.component_id ? -1 : left.component_id > right.component_id ? 1 : 0);
}

function auditDataset(build: DatasetBuild, prepared: PreparedTrace[]): DatasetAudit {
  const globalNearBudget = { sourceBytes: 0, features: 0, failureReason: null as string | null };
  const fingerprints = prepared.map((trace) => ({
    trace,
    fingerprint: selectedTrainingViewFingerprint(trace, build.mode, globalNearBudget),
  }));
  const viewEntries = fingerprints.map(({ trace, fingerprint }) => ({
    key: fingerprint.viewSha256,
    split: trace.split,
    traceId: trace.bundle.manifest.trace_id,
  }));
  const content = groupedCrossSplit(viewEntries);
  const withinSplit = groupedWithinSplit(viewEntries);
  const nearOrdered = [...fingerprints]
    .sort((left, right) => left.trace.bundle.manifest.trace_id < right.trace.bundle.manifest.trace_id ? -1 : 1);
  const featureFailure = nearOrdered.find((entry) => entry.fingerprint.nearFailureReason !== null)
    ?.fingerprint.nearFailureReason ?? null;
  const nearPreflightFailure = globalNearBudget.failureReason ?? featureFailure;
  const nearRecords = nearOrdered.flatMap(({ trace, fingerprint }) => (
    fingerprint.nearSignatureSha256 === null ? [] : [{
      trace_id: trace.bundle.manifest.trace_id,
      split: trace.split,
      view_sha256: fingerprint.viewSha256,
      signature_sha256: fingerprint.nearSignatureSha256,
      feature_sha256: fingerprint.nearFeatureSha256,
    }]
  ));
  const near = nearPreflightFailure === null
    ? inspectDatasetNearDuplicateFeatureSets(nearRecords)
    : incompleteNearDuplicateScan(
      nearPreflightFailure,
      nearOrdered.length,
      nearOrdered.reduce((sum, entry) => sum + entry.fingerprint.nearFeatureSha256.length, 0),
      0,
    );
  const overlapEntries = fingerprints.flatMap(({ trace, fingerprint }) => (
    [...new Set(fingerprint.partSha256)].map((key) => ({
      key,
      split: trace.split,
      traceId: trace.bundle.manifest.trace_id,
    }))
  ));
  const overlapGroups = new Map<string, typeof overlapEntries>();
  for (const entry of overlapEntries) overlapGroups.set(entry.key, [...(overlapGroups.get(entry.key) ?? []), entry]);
  const overlap = [...overlapGroups.entries()].flatMap(([key, values]) => {
    const traceIds = [...new Set(values.map((value) => value.traceId))].sort();
    if (traceIds.length < 2) return [];
    return [{
      key,
      splits: [...new Set(values.map((value) => value.split))].sort() as DatasetSplit[],
      traceIds,
    }];
  });
  const repos = groupedCrossSplit(prepared.flatMap((trace) => {
    const commit = trace.bundle.manifest.environment.repo_commit;
    return commit === null ? [] : [{
      key: sha256(`trajpack.repo-commit/v1\0${commit}`),
      split: trace.split,
      traceId: trace.bundle.manifest.trace_id,
    }];
  }));
  const lineage = lineageCrossSplit(prepared);
  const fallbackGroupCount = build.traces.filter((trace) => trace.group_basis === "trace_fallback").length;
  const blocked: string[] = [];
  const warnings: string[] = [];
  if (content.length > 0) blocked.push("DATASET_EXACT_CROSS_SPLIT_DUPLICATE");
  if (lineage.length > 0) blocked.push("DATASET_LINEAGE_SPLIT_CONTAMINATION");
  if (near.scan.status !== "complete") blocked.push("DATASET_NEAR_DUPLICATE_SCAN_INCOMPLETE");
  if (build.quality_profile === "research_strict") {
    if (withinSplit.length > 0) blocked.push("DATASET_EXACT_DUPLICATE");
    if (near.candidates.some((candidate) => candidate.splits.length === 1)) blocked.push("DATASET_NEAR_DUPLICATE");
    if (near.candidates.some((candidate) => candidate.splits.length > 1)) blocked.push("DATASET_NEAR_CROSS_SPLIT_DUPLICATE");
    if (prepared.length > 1 && fallbackGroupCount > 0) blocked.push("DATASET_EXPLICIT_GROUPS_REQUIRED");
    if (repos.length > 0) blocked.push("DATASET_REPO_SPLIT_CONTAMINATION");
  } else {
    if (withinSplit.length > 0) warnings.push("Exact substantive content is duplicated within a split");
    if (fallbackGroupCount > 0) warnings.push("Trace-fallback grouping cannot prove repo/task isolation");
    if (repos.length > 0) warnings.push("Repository commits occur in more than one split");
    if (lineage.length > 0) warnings.push("Related trace lineages occur in more than one split");
    if (near.candidates.some((candidate) => candidate.splits.length === 1)) {
      warnings.push("Near-duplicate canonical training views occur within a split");
    }
    if (near.candidates.some((candidate) => candidate.splits.length > 1)) {
      warnings.push("Near-duplicate canonical training views occur across splits");
    }
  }
  if (overlap.length > 0) warnings.push("Some canonical training-view parts overlap; this is reported but is not an exact-trace duplicate gate");
  return {
    schema_version: "dataset-audit/0.2",
    profile: build.quality_profile,
    compiler_versions: build.compiler_versions,
    trace_count: prepared.length,
    fallback_group_count: fallbackGroupCount,
    training_views: fingerprints.map(({ trace, fingerprint }) => ({
      trace_id: trace.bundle.manifest.trace_id,
      split: trace.split,
      view_sha256: fingerprint.viewSha256,
      part_count: fingerprint.partSha256.length,
      near_shingle_count: fingerprint.nearFeatureSha256.length,
    })).sort((left, right) => left.trace_id < right.trace_id ? -1 : left.trace_id > right.trace_id ? 1 : 0),
    exact_within_split_duplicates: withinSplit.map((entry) => ({
      view_sha256: entry.key,
      split: entry.split,
      trace_ids: entry.traceIds,
    })),
    exact_cross_split_duplicates: content.map((entry) => ({
      view_sha256: entry.key,
      splits: entry.splits,
      trace_ids: entry.traceIds,
    })),
    near_duplicate_candidates: near.candidates,
    near_duplicate_scan: near.scan,
    partial_content_overlap: overlap.map((entry) => ({
      part_sha256: entry.key,
      splits: entry.splits,
      trace_ids: entry.traceIds,
    })).sort((left, right) => left.part_sha256 < right.part_sha256 ? -1 : left.part_sha256 > right.part_sha256 ? 1 : 0),
    same_repo_commit_cross_split: repos.map((entry) => ({
      repo_commit_sha256: entry.key,
      splits: entry.splits,
      trace_ids: entry.traceIds,
    })),
    lineage_cross_split: lineage,
    blocked_reasons: blocked,
    warnings,
  };
}

/**
 * Rebuild the dataset audit from the canonical selected views carried by an
 * exported dataset. This intentionally skips source-selection freshness and
 * policy checks: the validator has no managed raw vault to reopen. It only
 * reruns the exact frozen view/dedupe compiler over the independently parsed
 * provenance views, so a rewritten audit cannot authenticate itself by also
 * rewriting checksums.txt.
 */
export function deriveDatasetAuditFromSelectedViews(
  inputBuild: DatasetBuild,
  inputBundles: TraceBundle[],
): DatasetAudit {
  const build = datasetBuildSchema.parse(inputBuild);
  if (canonicalJson(build.compiler_versions) !== canonicalJson(CURRENT_DATASET_COMPILER_VERSIONS)) {
    throw new Error("Unsupported dataset compiler versions; the selected-view audit cannot be rederived");
  }
  const bundles = inputBundles.map((bundle) => traceBundleSchema.parse(bundle));
  const byId = new Map(bundles.map((bundle) => [bundle.manifest.trace_id, bundle]));
  if (byId.size !== bundles.length || byId.size !== build.traces.length) {
    throw new Error("Audit derivation requires exactly one canonical selected view per frozen trace id");
  }
  const prepared = [...build.traces]
    .sort((left, right) => left.trace_id < right.trace_id ? -1 : left.trace_id > right.trace_id ? 1 : 0)
    .map((buildTrace) => {
      const bundle = byId.get(buildTrace.trace_id);
      if (!bundle) throw new Error(`Audit derivation is missing selected view ${buildTrace.trace_id}`);
      return {
        bundle,
        buildTrace,
        split: splitForGroup(build.split_policy, buildTrace.split_group_id),
      };
    });
  return auditDataset(build, prepared);
}

export function inspectDatasetBuild(inputBuild: DatasetBuild, inputBundles: TraceBundle[]): DatasetAudit {
  const build = datasetBuildSchema.parse(inputBuild);
  const bundles = inputBundles.map((bundle) => traceBundleSchema.parse(bundle));
  const byId = new Map(bundles.map((bundle) => [bundle.manifest.trace_id, bundle]));
  if (byId.size !== bundles.length || byId.size !== build.traces.length) {
    throw new Error("Dataset inspection requires exactly one managed bundle for every frozen trace id");
  }
  const prepared = [...build.traces].map((buildTrace) => {
    const bundle = byId.get(buildTrace.trace_id);
    if (!bundle) throw new Error(`Dataset selection references a missing managed trace: ${buildTrace.trace_id}`);
    return { bundle, buildTrace, split: splitForGroup(build.split_policy, buildTrace.split_group_id) };
  });
  for (const trace of prepared) validatePreparedTrace(build, trace);
  return auditDataset(build, prepared);
}

async function ensurePrivateParentAndAbsent(output: string): Promise<string> {
  const absolute = resolve(output);
  const parent = dirname(absolute);
  await assertSafeOutputParent(parent);
  try {
    await lstat(absolute);
    throw new Error(`Dataset export destination already exists: ${absolute}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return absolute;
}

async function assertPublishPaths(output: string, staging: string): Promise<void> {
  const parent = dirname(output);
  if (dirname(staging) !== parent) {
    throw new Error("Dataset export parent changed or traverses a symlink/junction before publish");
  }
  await assertSafeOutputParent(parent);
  await assertSafeOutputParent(staging);
  try {
    await lstat(output);
    throw new Error(`Dataset export destination appeared before publish: ${output}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function createStagingDirectory(output: string): Promise<string> {
  const parent = dirname(output);
  const prefix = `.${basename(output)}.trajpack-stage-`;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const staging = join(parent, `${prefix}${randomBytes(12).toString("hex")}`);
    try {
      await mkdir(staging, { recursive: false, mode: 0o700 });
      await chmod(staging, 0o700);
      return staging;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("Unable to allocate a private dataset staging directory");
}

async function removeStaging(staging: string, output: string): Promise<void> {
  const parent = resolve(dirname(output));
  const candidate = resolve(staging);
  if (dirname(candidate) !== parent || !basename(candidate).startsWith(`.${basename(output)}.trajpack-stage-`)) {
    throw new Error("Refusing to remove an unverified dataset staging path");
  }
  await rm(candidate, { recursive: true, force: true });
}

async function writePrivate(path: string, value: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, value, { flag: "wx", mode: 0o600 });
}

async function readSelectedArtifact(format: ExportFormat, directory: string): Promise<{ selected: TraceBundle; exampleIds: string[] }> {
  if (format === "canonical") {
    const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
    const events = (await readFile(join(directory, "events.jsonl"), "utf8"))
      .split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
    return { selected: traceBundleSchema.parse({ manifest, events, raw: [] }), exampleIds: [manifest.trace_id as string] };
  }
  const provenance = JSON.parse(await readFile(join(directory, "provenance.json"), "utf8")) as Record<string, unknown>;
  const selected = traceBundleSchema.parse({
    manifest: provenance.manifest,
    events: provenance.canonical_events,
    raw: [],
  });
  if (format === "hf-trl") {
    const examples = (await readFile(join(directory, "dataset.jsonl"), "utf8"))
      .split(/\r?\n/u).filter(Boolean)
      .map((line) => datasetExampleSchema.parse(JSON.parse(line)));
    return { selected, exampleIds: examples.map((example) => example.id) };
  }
  return { selected, exampleIds: [selected.manifest.trace_id] };
}

function normalizeRelative(path: string): string {
  return path.split(sep).join("/");
}

async function walkFiles(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Dataset staging contains a symbolic link: ${path}`);
    if (entry.isDirectory()) files.push(...await walkFiles(root, path));
    else if (entry.isFile()) files.push(normalizeRelative(relative(root, path)));
    else throw new Error(`Dataset staging contains a non-regular artifact: ${path}`);
  }
  return files;
}

async function artifactInventory(root: string, excluded = new Set<string>()): Promise<DatasetManifest["artifacts"]> {
  const artifacts: DatasetManifest["artifacts"] = [];
  for (const path of await walkFiles(root)) {
    if (excluded.has(path)) continue;
    const absolute = join(root, ...path.split("/"));
    const before = await lstat(absolute);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Dataset artifact is not a regular file: ${absolute}`);
    const digest = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(absolute)) {
      const buffer = chunk as Buffer;
      digest.update(buffer);
      bytes += buffer.byteLength;
    }
    const after = await lstat(absolute);
    if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size || bytes !== before.size) {
      throw new Error(`Dataset artifact changed while hashing: ${absolute}`);
    }
    artifacts.push({ path, sha256: digest.digest("hex"), bytes });
  }
  return artifacts;
}

function topCounts(values: Record<string, number>): string {
  const entries = Object.entries(values).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return entries.length === 0 ? "none" : entries.map(([key, count]) => `${key}=${count}`).join(", ");
}

function datasetCard(build: DatasetBuild, manifest: DatasetManifest, audit: DatasetAudit, stats: DatasetStats): string {
  const safe = (value: string): string => value
    .replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;")
    .replace(/`/gu, "\\u0060").replace(/\r/gu, "\\r").replace(/\n/gu, "\\n")
    .replace(/[\u0000-\u001f\u007f]/gu, "�");
  return `# ${safe(build.name)}\n\n`
    + `- Dataset ID: \`${manifest.dataset_id}\`\n`
    + `- Schema: \`${manifest.schema_version}\`\n`
    + `- Format mapping: \`${safe(manifest.mapping_version)}\`\n`
    + `- Policy: \`${safe(manifest.policy_version)}\`\n`
    + `- Eligibility mode: \`${manifest.mode}\`\n`
    + `- Target: \`${safe(manifest.target === null ? "none" : `${manifest.target.model_owner}/${manifest.target.product}`)}\`\n`
    + `- View recipe: \`${manifest.view_recipe}\`\n`
    + `- View compiler: \`${manifest.compiler_versions.view}\`\n`
    + `- Quality compiler: \`${manifest.compiler_versions.quality}\`\n`
    + `- Dedupe compiler: \`${manifest.compiler_versions.dedupe}\`\n`
    + `- Quality profile: \`${manifest.quality_profile}\`\n`
    + `- Traces: ${manifest.entries.length}\n`
    + `- Split traces: train=${manifest.splits.train.traces}, validation=${manifest.splits.validation.traces}, test=${manifest.splits.test.traces}\n`
    + `- Exact cross-split duplicates: ${audit.exact_cross_split_duplicates.length}\n`
    + `- Exact within-split duplicate clusters: ${audit.exact_within_split_duplicates.length}\n`
    + `- Near-duplicate candidates (Jaccard >= ${audit.near_duplicate_scan.threshold_bp / 100}%): ${audit.near_duplicate_candidates.length}\n`
    + `- Near-duplicate scan: ${audit.near_duplicate_scan.status} (${audit.near_duplicate_scan.compared_pair_count} candidate comparisons)\n`
    + `- Fallback group assignments: ${audit.fallback_group_count}\n\n`
    + `- Providers: \`${safe(topCounts(stats.sources.providers))}\`\n`
    + `- Models: \`${safe(topCounts(stats.sources.models))}\`\n`
    + `- Authenticity: \`${safe(topCounts(stats.sources.authenticity))}\`\n`
    + `- Source licenses: \`${safe(topCounts(stats.rights.source_licenses))}\`\n`
    + `- Input rights: \`${safe(topCounts(stats.rights.input_rights))}\`\n`
    + `- Redaction states: \`${safe(topCounts(stats.redaction))}\`\n`
    + `- Quality: ${stats.quality.passed} passed / ${stats.quality.failed} failed\n`
    + `- Observed numeric rewards / versioned verifier events: ${stats.labels.observed_numeric_rewards} / ${stats.labels.versioned_verifier_events}\n\n`
    + "The selection is frozen to source-bundle, approval-scope, eligibility-decision, and derived-view hashes.\n"
    + "`assistant_loss_mask` is message-level audit metadata; TRL only applies assistant-only loss when the chosen chat template emits generation markers.\n"
    + "Reasoning fields describe provider-exposed representations and never assert access to hidden chain-of-thought.\n";
}

function increment(counts: Record<string, number>, value: string): void {
  counts[value] = (counts[value] ?? 0) + 1;
}

export interface DatasetSelectedStatsInput {
  bundle: TraceBundle;
  exampleIds: readonly string[];
}

/** Recompute all published statistics solely from canonical selected views. */
export function deriveDatasetStatsFromSelectedViews(
  inputArtifacts: DatasetSelectedStatsInput[],
): DatasetStats {
  const artifacts = inputArtifacts.map((artifact) => ({
    bundle: traceBundleSchema.parse(artifact.bundle),
    exampleIds: [...artifact.exampleIds],
  }));
  if (new Set(artifacts.map((artifact) => artifact.bundle.manifest.trace_id)).size !== artifacts.length) {
    throw new Error("Dataset statistics require unique canonical selected trace ids");
  }
  const stats: DatasetStats = {
    schema_version: "dataset-stats/0.1",
    traces: artifacts.length,
    events: 0,
    examples: artifacts.reduce((sum, artifact) => sum + artifact.exampleIds.length, 0),
    sources: { providers: {}, models: {}, authenticity: {}, capture_methods: {} },
    rights: { source_licenses: {}, model_licenses: {}, input_rights: {}, third_party_content: {} },
    redaction: {},
    quality: { passed: 0, failed: 0, issue_codes: {} },
    labels: { observed_numeric_rewards: 0, versioned_verifier_events: 0, verifier_identities: {} },
  };
  for (const artifact of artifacts) {
    const manifest = artifact.bundle.manifest;
    increment(stats.sources.providers, manifest.source.provider);
    increment(stats.sources.models, manifest.source.model_id ?? "unknown");
    increment(stats.sources.authenticity, manifest.source.authenticity);
    increment(stats.sources.capture_methods, manifest.source.capture_method);
    increment(stats.rights.source_licenses, manifest.rights.source_license_expression);
    increment(stats.rights.model_licenses, manifest.rights.model_license_chain.join(" -> ") || "unknown");
    increment(stats.rights.input_rights, manifest.rights.input_rights_basis);
    increment(stats.rights.third_party_content, manifest.rights.third_party_content);
    stats.events += artifact.bundle.events.length;
    const quality = inspectQuality(artifact.bundle);
    stats.quality[quality.passed ? "passed" : "failed"] += 1;
    for (const issue of quality.issues) increment(stats.quality.issue_codes, `${issue.severity}:${issue.code}`);
    for (const event of artifact.bundle.events) {
      for (const part of event.content) {
        increment(stats.redaction, `${part.review_disposition}:${part.redaction_status}`);
      }
    }
    for (const event of artifact.bundle.events) {
      if (typeof event.metadata.reward === "number" && Number.isFinite(event.metadata.reward)) {
        stats.labels.observed_numeric_rewards += 1;
      }
      const verifier = event.metadata.verifier;
      if (verifier && typeof verifier === "object" && !Array.isArray(verifier)) {
        const record = verifier as Record<string, unknown>;
        if (typeof record.name === "string" && record.name !== ""
          && typeof record.version === "string" && record.version !== "") {
          stats.labels.versioned_verifier_events += 1;
          increment(stats.labels.verifier_identities, `${record.name}@${record.version}`);
        }
      }
    }
  }
  return stats;
}

function datasetStats(artifacts: SelectedTraceArtifact[]): DatasetStats {
  return deriveDatasetStatsFromSelectedViews(artifacts.map((artifact) => ({
    bundle: artifact.selected,
    exampleIds: artifact.exampleIds,
  })));
}

async function aggregateFormat(
  staging: string,
  format: ExportFormat,
  artifacts: SelectedTraceArtifact[],
  datasetId: string,
): Promise<void> {
  for (const split of ["train", "validation", "test"] as const) {
    const selected = artifacts.filter((artifact) => artifact.split === split);
    if (format === "hf-trl") {
      const examples = (await Promise.all(selected.map(async (artifact) => {
        const parsed = (await readFile(join(artifact.directory, "dataset.jsonl"), "utf8"))
          .split(/\r?\n/u).filter(Boolean)
          .map((line) => datasetExampleSchema.parse(JSON.parse(line)));
        return parsed.map((example) => datasetExampleSchema.parse({
          ...example,
          metadata: {
            ...example.metadata,
            dataset_id: datasetId,
            dataset_split: split,
            split_group_id: artifact.buildTrace.split_group_id,
            source_bundle_sha256: artifact.buildTrace.source_bundle_sha256,
            selected_bundle_sha256: artifact.selectedBundleSha256,
            training_contract: {
              dataset_type: "conversational-language-modeling",
              assistant_only_loss_requires_generation_markers: true,
              assistant_loss_mask_is_advisory: true,
              structural_targets_are_not_token_masks: true,
            },
          },
        }));
      }))).flat();
      const directory = join(staging, "splits", split);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writePrivate(join(directory, "dataset.jsonl"), examples.length === 0
        ? ""
        : `${examples.map(canonicalJson).join("\n")}\n`);
      await writeHfParquet(join(directory, "dataset.parquet"), examples);
    } else if (format === "atif") {
      const trajectories = await Promise.all(selected.map(async (artifact) => {
        const value = JSON.parse(await readFile(join(artifact.directory, "trajectory.atif.json"), "utf8")) as Record<string, unknown>;
        const extra = value.extra && typeof value.extra === "object" && !Array.isArray(value.extra)
          ? value.extra as Record<string, unknown>
          : {};
        return {
          ...value,
          extra: {
            ...extra,
            trajpack_dataset: {
              dataset_id: datasetId,
              split,
              split_group_id: artifact.buildTrace.split_group_id,
              selected_bundle_sha256: artifact.selectedBundleSha256,
            },
          },
        };
      }));
      await writePrivate(join(staging, "splits", split, "trajectories.atif.jsonl"), trajectories.length === 0
        ? ""
        : `${trajectories.map(canonicalJson).join("\n")}\n`);
    } else if (format === "otlp") {
      const requests = await Promise.all(selected.map(async (artifact) => JSON.parse(
        await readFile(join(artifact.directory, "traces.otlp.json"), "utf8"),
      ) as { resourceSpans?: unknown[] }));
      await writePrivate(join(staging, "splits", split, "traces.otlp.json"), `${canonicalJson({
        resourceSpans: requests.flatMap((request) => request.resourceSpans ?? []),
      })}\n`);
    }
  }
  if (format === "hf-trl") {
    await writePrivate(join(staging, "dataset_info.json"), `${canonicalJson({
      schema_version: "hf-trl-conversational/0.2",
      dataset_id: datasetId,
      split_files: {
        train: "splits/train/dataset.jsonl",
        validation: "splits/validation/dataset.jsonl",
        test: "splits/test/dataset.jsonl",
      },
      training_contract: {
        messages_field: "messages",
        tools_field: "tools",
        assistant_only_loss_requires_generation_markers: true,
        assistant_loss_mask_is_message_level_audit_metadata: true,
        training_targets_are_structural_pre_tokenization_metadata: true,
        parquet_schema_version: HF_PARQUET_SCHEMA_VERSION,
        parquet_native_nested_messages: true,
        parquet_json_sidecars: ["tools.function.parameters_json", "metadata_json"],
      },
    })}\n`);
  }
}

export async function exportApprovedDataset(
  inputBuild: DatasetBuild,
  inputBundles: TraceBundle[],
  options: DatasetExportOptions,
): Promise<DatasetExportResult> {
  const build = datasetBuildSchema.parse(inputBuild);
  if (build.policy_version !== POLICY_VERSION) {
    throw new Error(`Dataset build policy ${build.policy_version} is stale; current policy is ${POLICY_VERSION}`);
  }
  if (options.format === "hf-trl"
    && build.mode !== "training_noncompetitive" && build.mode !== "training_competitive_distillation") {
    throw new Error("HF/TRL dataset exports require an explicit training eligibility mode");
  }
  const bundles = inputBundles.map((bundle) => traceBundleSchema.parse(bundle));
  const byId = new Map(bundles.map((bundle) => [bundle.manifest.trace_id, bundle]));
  if (byId.size !== bundles.length || byId.size !== build.traces.length) {
    throw new Error("Dataset export requires exactly one managed bundle for every frozen trace id");
  }
  const prepared = [...build.traces]
    .sort((left, right) => left.trace_id < right.trace_id ? -1 : left.trace_id > right.trace_id ? 1 : 0)
    .map((buildTrace) => {
      const bundle = byId.get(buildTrace.trace_id);
      if (!bundle) throw new Error(`Dataset selection references a missing managed trace: ${buildTrace.trace_id}`);
      return { bundle, buildTrace, split: splitForGroup(build.split_policy, buildTrace.split_group_id) };
    });
  for (const trace of prepared) validatePreparedTrace(build, trace);
  const audit = auditDataset(build, prepared);
  if (audit.blocked_reasons.length > 0) {
    throw new Error(`Dataset audit blocked export: ${audit.blocked_reasons.join(", ")}`);
  }

  const output = await ensurePrivateParentAndAbsent(options.outputDirectory);
  const staging = await createStagingDirectory(output);
  try {
    const selectedArtifacts: SelectedTraceArtifact[] = [];
    for (const trace of prepared) {
      const directory = options.format === "canonical"
        ? join(staging, "splits", trace.split, "traces", trace.bundle.manifest.trace_id)
        : join(staging, "lineage", "traces", trace.bundle.manifest.trace_id);
      await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
      await exportApprovedBundle(trace.bundle, {
        format: options.format,
        outputDirectory: directory,
        mode: build.mode,
      });
      const artifact = await readSelectedArtifact(options.format, directory);
      selectedArtifacts.push({
        ...trace,
        selected: artifact.selected,
        selectedBundleSha256: approvalFingerprint(artifact.selected),
        exampleIds: artifact.exampleIds,
        directory,
      });
    }

    const entries: DatasetManifestEntry[] = selectedArtifacts.map((artifact) => ({
      trace_id: artifact.bundle.manifest.trace_id,
      split: artifact.split,
      split_group_id: artifact.buildTrace.split_group_id,
      source_bundle_sha256: artifact.buildTrace.source_bundle_sha256,
      approval_scope_sha256: artifact.buildTrace.approval_scope_sha256,
      eligibility_decision_id: artifact.buildTrace.eligibility_decision_id,
      selected_bundle_sha256: artifact.selectedBundleSha256,
      example_ids: artifact.exampleIds,
    }));
    const datasetId = computeDatasetId(build, entries, options.format);
    await aggregateFormat(staging, options.format, selectedArtifacts, datasetId);
    const selectionCanonical = canonicalJson(build);
    const auditCanonical = canonicalJson(audit);
    const stats = datasetStats(selectedArtifacts);
    const statsCanonical = canonicalJson(stats);
    await writePrivate(join(staging, "selection.json"), `${selectionCanonical}\n`);
    await writePrivate(join(staging, "dataset-audit.json"), `${auditCanonical}\n`);
    await writePrivate(join(staging, "dataset-stats.json"), `${statsCanonical}\n`);

    const splits = Object.fromEntries((["train", "validation", "test"] as const).map((split) => [split, {
      traces: entries.filter((entry) => entry.split === split).length,
      examples: entries.filter((entry) => entry.split === split).reduce((sum, entry) => sum + entry.example_ids.length, 0),
    }])) as DatasetManifest["splits"];
    const createdAt = options.createdAt ?? new Date();
    const manifestWithoutArtifacts = {
      record_type: "dataset_manifest" as const,
      schema_version: "dataset/0.1" as const,
      dataset_id: datasetId,
      name: build.name,
      created_at: createdAt.toISOString(),
      format: options.format,
      mapping_version: DATASET_EXPORT_MAPPING[options.format],
      mode: build.mode,
      target: build.target,
      policy_version: POLICY_VERSION,
      view_recipe: build.view_recipe,
      quality_profile: build.quality_profile,
      compiler_versions: build.compiler_versions,
      split_policy: build.split_policy,
      entries,
      splits,
      artifacts: [],
    };
    await writePrivate(join(staging, "DATASET_CARD.md"), datasetCard(
      build,
      datasetManifestSchema.parse(manifestWithoutArtifacts),
      audit,
      stats,
    ));
    await writePrivate(join(staging, "COMPLETE"), `${canonicalJson({
      schema_version: "dataset-complete/0.1",
      dataset_id: datasetId,
      trace_count: entries.length,
      example_count: entries.reduce((sum, entry) => sum + entry.example_ids.length, 0),
      splits,
      format: options.format,
      mode: build.mode,
      selection_sha256: sha256(selectionCanonical),
      audit_sha256: sha256(auditCanonical),
      stats_sha256: sha256(statsCanonical),
      compiler_versions: build.compiler_versions,
    })}\n`);
    const inventory = await artifactInventory(staging, new Set(["dataset-manifest.json", "checksums.txt"]));
    const manifest = datasetManifestSchema.parse({ ...manifestWithoutArtifacts, artifacts: inventory });
    await writePrivate(join(staging, "dataset-manifest.json"), `${canonicalJson(manifest)}\n`);
    const checksums = Object.fromEntries((await artifactInventory(staging, new Set(["checksums.txt"])))
      .map((artifact) => [artifact.path, artifact.sha256]));
    await writePrivate(join(staging, "checksums.txt"), `${Object.entries(checksums)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([path, digest]) => `${digest}  ${path}`).join("\n")}\n`);
    await assertPublishPaths(output, staging);
    await rename(staging, output);
    const files = (await walkFiles(output)).map((path) => join(output, ...path.split("/")));
    return { directory: output, datasetId, manifest, files, checksums };
  } catch (error) {
    await removeStaging(staging, output).catch(() => undefined);
    throw error;
  }
}
