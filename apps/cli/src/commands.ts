import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Eligibility, EligibilityDecision, TraceBundle } from "@trajpack/schema";
import {
  datasetBuildSchema,
  datasetExampleSchema,
  datasetManifestSchema,
  eligibilityDecisionSchema,
  termsSnapshotSchema,
  traceBundleSchema,
  traceManifestSchema,
  trajectoryEventSchema,
} from "@trajpack/schema";
import {
  CURRENT_DATASET_COMPILER_VERSIONS,
  DATASET_EXPORT_MAPPING,
  DATASET_NEAR_DUPLICATE_CONFIG,
  POLICY_VERSION,
  approvalFingerprint,
  canonicalJson,
  computeDatasetId,
  deleteTrace,
  deriveDatasetAuditFromSelectedViews,
  deriveDatasetStatsFromSelectedViews,
  evaluateGate,
  exportApprovedBundle,
  exportApprovedDataset,
  inspectQuality,
  loadTrace,
  replaceTrace,
  sha256,
  splitForGroup,
  stableId,
  type ExportFormat,
  type TrainingMode,
  validateHfParquetFile,
  validateApprovalScope,
} from "@trajpack/core";
import { loadSelection } from "./bundle-io.js";
import { readDatasetBuildFile } from "./dataset-command.js";
import {
  MAX_DATASET_RESIDENT_ESTIMATE_BYTES,
  estimateResidentBytes,
  loadManagedBundlesBounded,
} from "./dataset-memory.js";
import { createEvidenceArtifactReference } from "./evidence-artifact.js";
import { readPassphrase } from "./secret.js";

function finalExportGate(bundle: TraceBundle, mode: "archive" | TrainingMode | "redistribution") {
  const gate = evaluateGate(bundle, mode);
  const approvalReasons = validateApprovalScope(bundle, mode);
  return {
    ...gate,
    allowed: gate.allowed && approvalReasons.length === 0,
    reasonCodes: [...new Set([...gate.reasonCodes, ...approvalReasons])],
  };
}

const MAX_DATASET_DIRECTORY_DEPTH = 24;
const MAX_DATASET_FILE_COUNT = 100_000;
const MAX_DATASET_VALIDATION_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_SELECTED_VIEW_FILE_BYTES = 128 * 1024 * 1024;
const MAX_JSONL_ROWS = 1_000_000;

async function hashRegularFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Dataset artifact is not a regular file: ${path}`);
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== details.dev || opened.ino !== details.ino
      || opened.size !== details.size || opened.mtimeMs !== details.mtimeMs
      || opened.ctimeMs !== details.ctimeMs) throw new Error(`Dataset artifact changed while opening: ${path}`);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const buffer = chunk as Buffer;
      hash.update(buffer);
      bytes += buffer.byteLength;
    }
    const [after, pathAfter] = await Promise.all([handle.stat(), lstat(path)]);
    if (!after.isFile() || pathAfter.isSymbolicLink() || pathAfter.dev !== opened.dev
      || pathAfter.ino !== opened.ino || after.size !== opened.size || bytes !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || pathAfter.mtimeMs !== opened.mtimeMs || pathAfter.ctimeMs !== opened.ctimeMs) {
      throw new Error(`Dataset artifact changed while hashing: ${path}`);
    }
    return { sha256: hash.digest("hex"), bytes };
  } finally {
    await handle.close();
  }
}

async function listDatasetFiles(
  root: string,
  current = root,
  depth = 0,
  result: string[] = [],
  state: { entries: number } = { entries: 0 },
): Promise<string[]> {
  if (depth > MAX_DATASET_DIRECTORY_DEPTH) throw new Error("Dataset directory exceeds the validation depth limit");
  for (const entry of await readdir(current, { withFileTypes: true })) {
    state.entries += 1;
    if (state.entries > MAX_DATASET_FILE_COUNT) throw new Error("Dataset directory exceeds the validation entry-count limit");
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Dataset contains a symbolic link: ${path}`);
    if (entry.isDirectory()) await listDatasetFiles(root, path, depth + 1, result, state);
    else if (entry.isFile()) result.push(relative(root, path).split(sep).join("/"));
    else throw new Error(`Dataset contains a non-regular artifact: ${path}`);
  }
  return depth === 0 ? result.sort() : result;
}

async function readSmallJson(path: string, maxBytes: number): Promise<unknown> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size > maxBytes) {
    throw new Error(`Invalid or oversized JSON artifact: ${path}`);
  }
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== details.dev || opened.ino !== details.ino
      || opened.size !== details.size || opened.mtimeMs !== details.mtimeMs
      || opened.ctimeMs !== details.ctimeMs || opened.size > maxBytes) {
      throw new Error(`JSON artifact changed while opening: ${path}`);
    }
    const bytes = Buffer.allocUnsafe(opened.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const [after, pathAfter] = await Promise.all([handle.stat(), lstat(path)]);
    if (offset !== opened.size || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || pathAfter.isSymbolicLink() || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino
      || pathAfter.mtimeMs !== opened.mtimeMs || pathAfter.ctimeMs !== opened.ctimeMs) {
      throw new Error(`JSON artifact changed while reading: ${path}`);
    }
    return JSON.parse(bytes.subarray(0, offset).toString("utf8"));
  } finally {
    await handle.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function safeDatasetPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/u.test(path)
    || path.includes("\\") || /[\u0000-\u001f\u007f]/u.test(path)) return false;
  const components = path.split("/");
  return components.every((component) => component !== "" && component !== "." && component !== "..");
}

async function readJsonLines(
  path: string,
  maxBytes: number,
  consume: (value: unknown, index: number) => void,
): Promise<number> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || details.size > maxBytes) {
    throw new Error(`Invalid or oversized JSONL artifact: ${path}`);
  }
  const handle = await open(path, "r");
  const opened = await handle.stat();
  if (!opened.isFile() || opened.dev !== details.dev || opened.ino !== details.ino
    || opened.size !== details.size || opened.mtimeMs !== details.mtimeMs
    || opened.ctimeMs !== details.ctimeMs) {
    await handle.close();
    throw new Error(`Dataset JSONL changed while opening: ${path}`);
  }
  let count = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  const consumeLine = (lineWithPossibleCr: string): void => {
    const line = lineWithPossibleCr.endsWith("\r")
      ? lineWithPossibleCr.slice(0, -1)
      : lineWithPossibleCr;
    if (line === "") return;
    if (Buffer.byteLength(line, "utf8") > 64 * 1024 * 1024) {
      throw new Error(`Dataset JSONL row exceeds 64 MiB: ${path}`);
    }
    consume(JSON.parse(line), count);
    count += 1;
    if (count > MAX_JSONL_ROWS) throw new Error(`Dataset JSONL exceeds ${MAX_JSONL_ROWS} rows: ${path}`);
  };
  const consumeDecoded = (text: string): void => {
    pending += text;
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      consumeLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
    if (Buffer.byteLength(pending, "utf8") > 64 * 1024 * 1024) {
      throw new Error(`Dataset JSONL row exceeds 64 MiB: ${path}`);
    }
  };
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < opened.size) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - offset), offset);
      if (result.bytesRead === 0) throw new Error(`Dataset JSONL was truncated while reading: ${path}`);
      offset += result.bytesRead;
      consumeDecoded(decoder.decode(buffer.subarray(0, result.bytesRead), { stream: true }));
    }
    consumeDecoded(decoder.decode());
    consumeLine(pending);
    pending = "";
  } finally {
    const [after, pathAfter] = await Promise.all([handle.stat(), lstat(path)]);
    await handle.close();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs || pathAfter.isSymbolicLink()
      || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino
      || pathAfter.mtimeMs !== opened.mtimeMs || pathAfter.ctimeMs !== opened.ctimeMs) {
      throw new Error(`Dataset JSONL changed while reading: ${path}`);
    }
  }
  return count;
}

async function canonicalSelectedBundleFingerprint(
  manifestPath: string,
  eventsPath: string,
  expectedTraceId: string,
): Promise<{ bundle: TraceBundle; fingerprint: string }> {
  const manifest = traceManifestSchema.parse(await readSmallJson(manifestPath, 16 * 1024 * 1024));
  if (manifest.trace_id !== expectedTraceId) throw new Error(`Canonical trace manifest id mismatch: ${expectedTraceId}`);
  const { review: _review, ...manifestWithoutReview } = manifest;
  const events: ReturnType<typeof trajectoryEventSchema.parse>[] = [];
  let residentEstimate = estimateResidentBytes(manifest);
  const hash = createHash("sha256");
  hash.update('{"events":[');
  let first = true;
  await readJsonLines(eventsPath, 512 * 1024 * 1024, (value) => {
    const event = trajectoryEventSchema.parse(value);
    if (event.trace_id !== expectedTraceId) throw new Error(`Canonical event trace id mismatch: ${expectedTraceId}`);
    residentEstimate += estimateResidentBytes(event);
    if (residentEstimate > MAX_SELECTED_VIEW_FILE_BYTES) {
      throw new Error("Canonical selected view exceeds the bounded validation memory budget");
    }
    events.push(event);
    if (!first) hash.update(",");
    first = false;
    hash.update(canonicalJson(event));
  });
  hash.update('],"manifest":');
  hash.update(canonicalJson(manifestWithoutReview));
  hash.update("}");
  return {
    bundle: traceBundleSchema.parse({ manifest, events, raw: [] }),
    fingerprint: hash.digest("hex"),
  };
}

async function provenanceSelectedBundleFingerprint(
  path: string,
  expectedTraceId: string,
): Promise<{ bundle: TraceBundle; fingerprint: string }> {
  const provenance = requireRecord(await readSmallJson(path, MAX_SELECTED_VIEW_FILE_BYTES), "trajectory provenance");
  const bundle = traceBundleSchema.parse({
    manifest: provenance.manifest,
    events: provenance.canonical_events,
    raw: [],
  });
  if (bundle.manifest.trace_id !== expectedTraceId) throw new Error(`Provenance trace id mismatch: ${expectedTraceId}`);
  if (estimateResidentBytes(bundle) > MAX_SELECTED_VIEW_FILE_BYTES) {
    throw new Error("Trajectory provenance exceeds the bounded validation memory budget");
  }
  return { bundle, fingerprint: approvalFingerprint(bundle) };
}

function expectStringArray(record: Record<string, unknown>, key: string, label: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label}.${key} must be a string array`);
  }
  return value as string[];
}

function validatedCountMap(value: unknown, label: string): Record<string, number> {
  const record = requireRecord(value, label);
  for (const [key, count] of Object.entries(record)) {
    if (!key || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`${label} must contain non-negative integer counts`);
    }
  }
  return record as Record<string, number>;
}

function expectedFormatArtifacts(
  absolute: string,
  format: "canonical" | "atif" | "hf-trl" | "otlp",
  manifest: ReturnType<typeof datasetManifestSchema.parse>,
  actualFileSet: Set<string>,
  mismatches: string[],
): Promise<{
  observedBySplit: Record<"train" | "validation" | "test", string[]>;
  selectedBundles: Map<string, TraceBundle>;
}> {
  return (async () => {
    const observed: Record<"train" | "validation" | "test", string[]> = {
      train: [], validation: [], test: [],
    };
    const selectedBundles = new Map<string, TraceBundle>();
    let selectedBundleBytes = 0;
    const retainSelectedBundle = (traceId: string, bundle: TraceBundle): void => {
      selectedBundleBytes += estimateResidentBytes(bundle);
      if (selectedBundleBytes > MAX_DATASET_RESIDENT_ESTIMATE_BYTES) {
        throw new Error("Selected canonical views exceed the bounded validation memory budget");
      }
      selectedBundles.set(traceId, bundle);
    };
    for (const split of ["train", "validation", "test"] as const) {
      const entries = manifest.entries.filter((entry) => entry.split === split);
      if (format === "canonical") {
        for (const entry of entries) {
          const prefix = `splits/${split}/traces/${entry.trace_id}`;
          for (const required of [`${prefix}/manifest.json`, `${prefix}/events.jsonl`, `${prefix}/COMPLETE`]) {
            if (!actualFileSet.has(required)) mismatches.push(`missing:${required}`);
          }
          const selected = await canonicalSelectedBundleFingerprint(
            join(absolute, ...`${prefix}/manifest.json`.split("/")),
            join(absolute, ...`${prefix}/events.jsonl`.split("/")),
            entry.trace_id,
          );
          retainSelectedBundle(entry.trace_id, selected.bundle);
          if (selected.fingerprint !== entry.selected_bundle_sha256) mismatches.push(`selected_bundle:${entry.trace_id}`);
          observed[split].push(entry.trace_id);
        }
        continue;
      }
      for (const entry of entries) {
        const primary = format === "atif" ? "trajectory.atif.json"
          : format === "hf-trl" ? "dataset.jsonl" : "traces.otlp.json";
        const required = `lineage/traces/${entry.trace_id}/${primary}`;
        if (!actualFileSet.has(required)) mismatches.push(`missing:${required}`);
        const provenancePath = `lineage/traces/${entry.trace_id}/provenance.json`;
        if (!actualFileSet.has(provenancePath)) mismatches.push(`missing:${provenancePath}`);
        else {
          const selected = await provenanceSelectedBundleFingerprint(
            join(absolute, ...provenancePath.split("/")),
            entry.trace_id,
          );
          retainSelectedBundle(entry.trace_id, selected.bundle);
          if (selected.fingerprint !== entry.selected_bundle_sha256) mismatches.push(`selected_bundle:${entry.trace_id}`);
        }
      }
      if (format === "hf-trl") {
        const jsonl = `splits/${split}/dataset.jsonl`;
        const parquet = `splits/${split}/dataset.parquet`;
        if (!actualFileSet.has(jsonl)) mismatches.push(`missing:${jsonl}`);
        if (!actualFileSet.has(parquet)) mismatches.push(`missing:${parquet}`);
        const examples: ReturnType<typeof datasetExampleSchema.parse>[] = [];
        let exampleResidentBytes = 0;
        if (actualFileSet.has(jsonl)) {
          await readJsonLines(join(absolute, ...jsonl.split("/")), 512 * 1024 * 1024, (value) => {
            const example = datasetExampleSchema.parse(value);
            exampleResidentBytes += estimateResidentBytes(example);
            if (exampleResidentBytes > MAX_DATASET_RESIDENT_ESTIMATE_BYTES) {
              throw new Error("HF examples exceed the bounded Parquet comparison memory budget");
            }
            examples.push(example);
            observed[split].push(example.id);
            const metadata = example.metadata;
            if (metadata.dataset_id !== manifest.dataset_id || metadata.dataset_split !== split) {
              mismatches.push(`hf_metadata:${example.id}`);
            }
            const entry = entries.find((candidate) => candidate.trace_id === example.trace_id);
            if (!entry) mismatches.push(`hf_trace:${example.id}`);
            else if (metadata.split_group_id !== entry.split_group_id
              || metadata.source_bundle_sha256 !== entry.source_bundle_sha256
              || metadata.selected_bundle_sha256 !== entry.selected_bundle_sha256) {
              mismatches.push(`hf_lineage_binding:${example.id}`);
            }
          });
        }
        if (actualFileSet.has(parquet)) {
          const parquetMismatches = await validateHfParquetFile(join(absolute, ...parquet.split("/")), examples);
          mismatches.push(...parquetMismatches.map((value) => `hf_parquet:${split}:${value}`));
        }
      } else if (format === "atif") {
        const path = `splits/${split}/trajectories.atif.jsonl`;
        if (!actualFileSet.has(path)) mismatches.push(`missing:${path}`);
        if (actualFileSet.has(path)) {
          await readJsonLines(join(absolute, ...path.split("/")), 512 * 1024 * 1024, (value) => {
            const trajectory = requireRecord(value, "ATIF trajectory");
            if (trajectory.schema_version !== "ATIF-v1.7" || typeof trajectory.trajectory_id !== "string") {
              throw new Error("Dataset ATIF row has an unsupported schema or missing trajectory_id");
            }
            observed[split].push(trajectory.trajectory_id);
            const extra = requireRecord(trajectory.extra, "ATIF extra");
            const binding = requireRecord(extra.trajpack_dataset, "ATIF dataset binding");
            if (binding.dataset_id !== manifest.dataset_id || binding.split !== split) {
              mismatches.push(`atif_binding:${trajectory.trajectory_id}`);
            }
            const entry = entries.find((candidate) => candidate.trace_id === trajectory.trajectory_id);
            if (!entry || binding.split_group_id !== entry.split_group_id
              || binding.selected_bundle_sha256 !== entry.selected_bundle_sha256) {
              mismatches.push(`atif_lineage_binding:${trajectory.trajectory_id}`);
            }
          });
        }
      } else {
        const path = `splits/${split}/traces.otlp.json`;
        if (!actualFileSet.has(path)) mismatches.push(`missing:${path}`);
        if (actualFileSet.has(path)) {
          const request = requireRecord(await readSmallJson(join(absolute, ...path.split("/")), 512 * 1024 * 1024), "OTLP request");
          if (!Array.isArray(request.resourceSpans)) throw new Error("Dataset OTLP request must contain resourceSpans");
          for (const resourceSpan of request.resourceSpans) {
            const resource = requireRecord(resourceSpan, "OTLP resource span");
            if (!Array.isArray(resource.scopeSpans)) throw new Error("Dataset OTLP resource span must contain scopeSpans");
            const ids = new Set<string>();
            for (const scopeSpan of resource.scopeSpans) {
              const scope = requireRecord(scopeSpan, "OTLP scope span");
              if (!Array.isArray(scope.spans)) throw new Error("Dataset OTLP scope span must contain spans");
              for (const span of scope.spans) {
                const record = requireRecord(span, "OTLP span");
                if (typeof record.traceId !== "string") throw new Error("Dataset OTLP span is missing traceId");
                ids.add(record.traceId);
              }
            }
            if (ids.size !== 1) mismatches.push(`otlp_trace_binding:${split}`);
            else observed[split].push([...ids][0]!);
          }
        }
      }
    }
    return { observedBySplit: observed, selectedBundles };
  })();
}

function usesSupportedDatasetCompilers(value: unknown): boolean {
  return isRecord(value)
    && canonicalJson(value.compiler_versions) === canonicalJson(CURRENT_DATASET_COMPILER_VERSIONS);
}

async function validateDatasetDirectory(root: string): Promise<boolean> {
  const absolute = resolve(root);
  const rootDetails = await lstat(absolute);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) throw new Error("Dataset must be a real directory");
  const rawManifest = await readSmallJson(join(absolute, "dataset-manifest.json"), 16 * 1024 * 1024);
  const rawBuild = await readSmallJson(join(absolute, "selection.json"), 4 * 1024 * 1024);
  const unsupportedCompilers = [
    ...(usesSupportedDatasetCompilers(rawManifest) ? [] : ["compiler:manifest_unsupported"]),
    ...(usesSupportedDatasetCompilers(rawBuild) ? [] : ["compiler:selection_unsupported"]),
  ];
  if (unsupportedCompilers.length > 0) {
    process.stdout.write(`${JSON.stringify({
      structurally_valid: false,
      integrity_valid: false,
      checksum_self_consistent: false,
      self_consistent: false,
      compiler_supported: false,
      source_authenticity_verified: false,
      current_compiler_versions: CURRENT_DATASET_COMPILER_VERSIONS,
      training_ready: false,
      validation_scope: "fail closed: this trajpack version cannot rederive the dataset's frozen compiler output",
      mismatches: unsupportedCompilers,
    }, null, 2)}\n`);
    return false;
  }
  const manifest = datasetManifestSchema.parse(rawManifest);
  const build = datasetBuildSchema.parse(rawBuild);
  const expectedDatasetId = computeDatasetId(build, manifest.entries, manifest.format);
  const checksumDetails = await lstat(join(absolute, "checksums.txt"));
  if (!checksumDetails.isFile() || checksumDetails.isSymbolicLink() || checksumDetails.size > 16 * 1024 * 1024) {
    throw new Error("Invalid dataset checksums file");
  }
  const checksums = new Map<string, string>();
  for (const line of (await readFile(join(absolute, "checksums.txt"), "utf8")).split(/\r?\n/u).filter(Boolean)) {
    const match = /^([a-f0-9]{64})  ([^\\\r\n]+)$/u.exec(line);
    if (!match || !safeDatasetPath(match[2]!)) {
      throw new Error("Dataset checksums contain an unsafe or malformed path");
    }
    if (checksums.has(match[2]!)) throw new Error("Dataset checksums contain a duplicate path");
    checksums.set(match[2]!, match[1]!);
  }
  const actualFiles = await listDatasetFiles(absolute);
  const actualFileSet = new Set(actualFiles);
  const expectedFiles = [...checksums.keys(), "checksums.txt"].sort();
  if (canonicalJson(actualFiles) !== canonicalJson(expectedFiles)) throw new Error("Dataset artifact membership does not match checksums.txt");
  const mismatches: string[] = [];
  const actualArtifacts = new Map<string, { sha256: string; bytes: number }>();
  let validationBytes = 0;
  for (const [path, digest] of checksums) {
    const artifact = await hashRegularFile(join(absolute, ...path.split("/")));
    validationBytes += artifact.bytes;
    if (validationBytes > MAX_DATASET_VALIDATION_BYTES) {
      throw new Error("Dataset exceeds the 4 GiB validation byte budget");
    }
    actualArtifacts.set(path, artifact);
    if (artifact.sha256 !== digest) mismatches.push(path);
  }
  const inventory = new Map<string, { sha256: string; bytes: number }>();
  for (const artifact of manifest.artifacts) {
    if (!safeDatasetPath(artifact.path) || artifact.path === "dataset-manifest.json" || artifact.path === "checksums.txt") {
      throw new Error("Dataset manifest contains an unsafe or self-referential artifact path");
    }
    if (inventory.has(artifact.path)) throw new Error("Dataset manifest contains a duplicate artifact path");
    inventory.set(artifact.path, { sha256: artifact.sha256, bytes: artifact.bytes });
  }
  const expectedInventoryPaths = [...checksums.keys()].filter((path) => path !== "dataset-manifest.json").sort();
  if (canonicalJson([...inventory.keys()].sort()) !== canonicalJson(expectedInventoryPaths)) {
    mismatches.push("manifest:artifact_membership");
  }
  for (const [path, expected] of inventory) {
    const actual = actualArtifacts.get(path);
    if (!actual || expected.sha256 !== actual.sha256 || expected.bytes !== actual.bytes || checksums.get(path) !== expected.sha256) {
      mismatches.push(`manifest:${path}`);
    }
  }

  const compare = (condition: boolean, label: string): void => { if (!condition) mismatches.push(label); };
  compare(manifest.dataset_id === expectedDatasetId, "dataset_id");
  compare(manifest.name === build.name, "manifest:name");
  compare(manifest.mode === build.mode, "manifest:mode");
  compare(canonicalJson(manifest.target) === canonicalJson(build.target), "manifest:target");
  compare(manifest.policy_version === build.policy_version, "manifest:policy_version");
  compare(manifest.view_recipe === build.view_recipe, "manifest:view_recipe");
  compare(manifest.quality_profile === build.quality_profile, "manifest:quality_profile");
  compare(canonicalJson(manifest.compiler_versions) === canonicalJson(build.compiler_versions), "manifest:compiler_versions");
  compare(canonicalJson(manifest.split_policy) === canonicalJson(build.split_policy), "manifest:split_policy");
  compare(manifest.mapping_version === DATASET_EXPORT_MAPPING[manifest.format], "manifest:mapping_version");
  const buildTraces = new Map(build.traces.map((trace) => [trace.trace_id, trace]));
  compare(manifest.entries.length === build.traces.length, "manifest:trace_count");
  const observedEntryIds = new Set<string>();
  const observedExampleIds = new Set<string>();
  for (const entry of manifest.entries) {
    if (observedEntryIds.has(entry.trace_id)) mismatches.push(`manifest:duplicate_trace:${entry.trace_id}`);
    observedEntryIds.add(entry.trace_id);
    const frozen = buildTraces.get(entry.trace_id);
    if (!frozen) {
      mismatches.push(`manifest:unknown_trace:${entry.trace_id}`);
      continue;
    }
    compare(entry.split_group_id === frozen.split_group_id, `manifest:split_group:${entry.trace_id}`);
    compare(entry.split === splitForGroup(build.split_policy, frozen.split_group_id), `manifest:split:${entry.trace_id}`);
    compare(entry.source_bundle_sha256 === frozen.source_bundle_sha256, `manifest:source_bundle:${entry.trace_id}`);
    compare(entry.approval_scope_sha256 === frozen.approval_scope_sha256, `manifest:approval_scope:${entry.trace_id}`);
    compare(entry.eligibility_decision_id === frozen.eligibility_decision_id, `manifest:eligibility:${entry.trace_id}`);
    for (const id of entry.example_ids) {
      if (observedExampleIds.has(id)) mismatches.push(`manifest:duplicate_example:${id}`);
      observedExampleIds.add(id);
    }
  }

  const audit = requireRecord(await readSmallJson(join(absolute, "dataset-audit.json"), 64 * 1024 * 1024), "dataset audit");
  compare(audit.schema_version === "dataset-audit/0.2", "audit:schema_version");
  compare(audit.profile === build.quality_profile, "audit:profile");
  compare(canonicalJson(audit.compiler_versions) === canonicalJson(build.compiler_versions), "audit:compiler_versions");
  compare(audit.trace_count === manifest.entries.length, "audit:trace_count");
  compare(audit.fallback_group_count === build.traces.filter((trace) => trace.group_basis === "trace_fallback").length, "audit:fallback_group_count");
  const blockedReasons = expectStringArray(audit, "blocked_reasons", "dataset audit");
  compare(blockedReasons.length === 0, "audit:blocked_reasons");
  if (!Array.isArray(audit.training_views) || audit.training_views.length !== manifest.entries.length) {
    mismatches.push("audit:training_views");
  } else {
    const observedViews = new Set<string>();
    for (const value of audit.training_views) {
      const view = requireRecord(value, "dataset audit training view");
      if (typeof view.trace_id !== "string" || typeof view.view_sha256 !== "string"
        || !/^[a-f0-9]{64}$/u.test(view.view_sha256)
        || typeof view.part_count !== "number" || !Number.isSafeInteger(view.part_count) || view.part_count < 0
        || typeof view.near_shingle_count !== "number" || !Number.isSafeInteger(view.near_shingle_count)
        || view.near_shingle_count < 0) {
        throw new Error("Dataset audit training view is malformed");
      }
      if (observedViews.has(view.trace_id)) mismatches.push(`audit:duplicate_training_view:${view.trace_id}`);
      observedViews.add(view.trace_id);
      const entry = manifest.entries.find((candidate) => candidate.trace_id === view.trace_id);
      if (!entry || view.split !== entry.split) mismatches.push(`audit:training_view_binding:${view.trace_id}`);
    }
  }
  for (const key of ["exact_within_split_duplicates", "exact_cross_split_duplicates", "partial_content_overlap", "same_repo_commit_cross_split", "lineage_cross_split", "near_duplicate_candidates", "warnings"] as const) {
    if (!Array.isArray(audit[key])) throw new Error(`dataset audit.${key} must be an array`);
  }
  const nearScan = requireRecord(audit.near_duplicate_scan, "dataset audit near-duplicate scan");
  compare(nearScan.algorithm === DATASET_NEAR_DUPLICATE_CONFIG.algorithm, "audit:near_scan_algorithm");
  compare(nearScan.shingle_version === DATASET_NEAR_DUPLICATE_CONFIG.shingle_version, "audit:near_scan_shingles");
  compare(nearScan.threshold_bp === DATASET_NEAR_DUPLICATE_CONFIG.threshold_bp, "audit:near_scan_threshold");
  compare(nearScan.status === "complete" && nearScan.reason_code === null, "audit:near_scan_status");
  compare(nearScan.record_count === manifest.entries.length, "audit:near_scan_record_count");
  compare(nearScan.resource_limits_sha256 === sha256(canonicalJson(DATASET_NEAR_DUPLICATE_CONFIG)), "audit:near_scan_limits");
  for (const key of ["feature_count", "candidate_pair_count", "compared_pair_count"] as const) {
    if (typeof nearScan[key] !== "number" || !Number.isSafeInteger(nearScan[key]) || nearScan[key] < 0) {
      throw new Error(`dataset audit near-duplicate scan.${key} must be a nonnegative safe integer`);
    }
  }
  compare(nearScan.candidate_pair_count === nearScan.compared_pair_count, "audit:near_scan_comparisons");
  const nearSignatures = new Set<string>();
  for (const value of audit.near_duplicate_candidates as unknown[]) {
    const candidate = requireRecord(value, "dataset audit near-duplicate candidate");
    if (typeof candidate.signature_sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(candidate.signature_sha256)
      || typeof candidate.similarity_bp !== "number" || !Number.isSafeInteger(candidate.similarity_bp)
      || candidate.similarity_bp < DATASET_NEAR_DUPLICATE_CONFIG.threshold_bp || candidate.similarity_bp > 10_000
      || !Array.isArray(candidate.trace_ids) || candidate.trace_ids.length !== 2
      || candidate.trace_ids.some((traceId) => typeof traceId !== "string")
      || !Array.isArray(candidate.splits) || candidate.splits.length < 1) {
      throw new Error("Dataset audit near-duplicate candidate is malformed");
    }
    if (nearSignatures.has(candidate.signature_sha256)) mismatches.push(`audit:duplicate_near_signature:${candidate.signature_sha256}`);
    nearSignatures.add(candidate.signature_sha256);
    const traceIds = candidate.trace_ids as string[];
    const entries = traceIds.map((traceId) => manifest.entries.find((entry) => entry.trace_id === traceId));
    if (entries.some((entry) => entry === undefined)
      || canonicalJson(candidate.splits) !== canonicalJson([...new Set(entries.map((entry) => entry!.split))].sort())) {
      mismatches.push(`audit:near_candidate_binding:${candidate.signature_sha256}`);
    }
  }

  const stats = requireRecord(await readSmallJson(join(absolute, "dataset-stats.json"), 64 * 1024 * 1024), "dataset stats");
  compare(stats.schema_version === "dataset-stats/0.1", "stats:schema_version");
  compare(stats.traces === manifest.entries.length, "stats:traces");
  const expectedExampleCount = manifest.entries.reduce((sum, entry) => sum + entry.example_ids.length, 0);
  compare(stats.examples === expectedExampleCount, "stats:examples");
  const sources = requireRecord(stats.sources, "dataset stats.sources");
  const rights = requireRecord(stats.rights, "dataset stats.rights");
  const redaction = validatedCountMap(stats.redaction, "dataset stats.redaction");
  const qualityStats = requireRecord(stats.quality, "dataset stats.quality");
  const labels = requireRecord(stats.labels, "dataset stats.labels");
  for (const key of ["providers", "models", "authenticity", "capture_methods"] as const) {
    const counts = validatedCountMap(sources[key], `dataset stats.sources.${key}`);
    compare(Object.values(counts).reduce((sum, count) => sum + count, 0) === manifest.entries.length, `stats:sources:${key}`);
  }
  for (const key of ["source_licenses", "model_licenses", "input_rights", "third_party_content"] as const) {
    const counts = validatedCountMap(rights[key], `dataset stats.rights.${key}`);
    compare(Object.values(counts).reduce((sum, count) => sum + count, 0) === manifest.entries.length, `stats:rights:${key}`);
  }
  validatedCountMap(qualityStats.issue_codes, "dataset stats.quality.issue_codes");
  validatedCountMap(labels.verifier_identities, "dataset stats.labels.verifier_identities");
  for (const [label, value] of Object.entries({
    events: stats.events,
    quality_passed: qualityStats.passed,
    quality_failed: qualityStats.failed,
    observed_numeric_rewards: labels.observed_numeric_rewards,
    versioned_verifier_events: labels.versioned_verifier_events,
  })) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`dataset stats.${label} must be a non-negative integer`);
  }
  compare((qualityStats.passed as number) + (qualityStats.failed as number) === manifest.entries.length, "stats:quality_trace_count");
  void redaction;

  const complete = requireRecord(await readSmallJson(join(absolute, "COMPLETE"), 4 * 1024 * 1024), "dataset completion marker");
  compare(complete.schema_version === "dataset-complete/0.1", "complete:schema_version");
  compare(complete.dataset_id === manifest.dataset_id, "complete:dataset_id");
  compare(complete.trace_count === manifest.entries.length, "complete:trace_count");
  compare(complete.example_count === expectedExampleCount, "complete:example_count");
  compare(complete.format === manifest.format, "complete:format");
  compare(complete.mode === manifest.mode, "complete:mode");
  compare(canonicalJson(complete.splits) === canonicalJson(manifest.splits), "complete:splits");
  compare(canonicalJson(complete.compiler_versions) === canonicalJson(build.compiler_versions), "complete:compiler_versions");
  compare(complete.selection_sha256 === sha256(canonicalJson(build)), "complete:selection_sha256");
  compare(complete.audit_sha256 === sha256(canonicalJson(audit)), "complete:audit_sha256");
  compare(complete.stats_sha256 === sha256(canonicalJson(stats)), "complete:stats_sha256");

  const formatInspection = await expectedFormatArtifacts(absolute, manifest.format, manifest, actualFileSet, mismatches);
  const observedBySplit = formatInspection.observedBySplit;
  for (const split of ["train", "validation", "test"] as const) {
    const entries = manifest.entries.filter((entry) => entry.split === split);
    const expectedIds = entries.flatMap((entry) => entry.example_ids).sort();
    compare(canonicalJson(observedBySplit[split].sort()) === canonicalJson(expectedIds), `format:example_ids:${split}`);
    compare(manifest.splits[split].traces === entries.length, `manifest:split_trace_count:${split}`);
    compare(manifest.splits[split].examples === expectedIds.length, `manifest:split_example_count:${split}`);
  }

  const selectedViews = manifest.entries.flatMap((entry) => {
    const bundle = formatInspection.selectedBundles.get(entry.trace_id);
    return bundle === undefined ? [] : [{ bundle, exampleIds: entry.example_ids }];
  });
  if (selectedViews.length !== manifest.entries.length) {
    mismatches.push("derived:selected_view_membership");
  } else {
    const derivedAudit = deriveDatasetAuditFromSelectedViews(build, selectedViews.map((entry) => entry.bundle));
    compare(canonicalJson(audit) === canonicalJson(derivedAudit), "audit:derived_selected_views");
    const derivedStats = deriveDatasetStatsFromSelectedViews(selectedViews);
    compare(canonicalJson(stats) === canonicalJson(derivedStats), "stats:derived_selected_views");
  }

  const checksumSelfConsistent = [...actualArtifacts.entries()]
    .every(([path, value]) => checksums.get(path) === value.sha256);
  const derivedIntegrityInvalid = mismatches.some((mismatch) => mismatch.startsWith("selected_bundle:")
    || mismatch.startsWith("derived:")
    || mismatch === "audit:derived_selected_views"
    || mismatch === "stats:derived_selected_views");
  const integrityValid = checksumSelfConsistent && !derivedIntegrityInvalid;
  const selfConsistent = checksumSelfConsistent && mismatches.length === 0;
  const trainingMode = manifest.mode === "training_noncompetitive" || manifest.mode === "training_competitive_distillation";
  process.stdout.write(`${JSON.stringify({
    structurally_valid: true,
    integrity_valid: integrityValid,
    checksum_self_consistent: checksumSelfConsistent,
    self_consistent: selfConsistent,
    compiler_supported: true,
    source_authenticity_verified: false,
    export_mode: manifest.mode,
    training_eligibility_attestation_present: selfConsistent && trainingMode,
    current_policy_rechecked: false,
    training_ready: false,
    validation_scope: "checksums establish only internal file consistency; integrity additionally rederives stats and audit fingerprints from canonical selected views; managed traces and current policy were not reopened",
    dataset_id: manifest.dataset_id,
    traces: manifest.entries.length,
    splits: manifest.splits,
    mismatches: [...new Set(mismatches)].sort(),
  }, null, 2)}\n`);
  return selfConsistent;
}

export async function runValidate(selection: string): Promise<boolean> {
  const details = await lstat(selection);
  if (details.isDirectory()) {
    try {
      await lstat(join(selection, "dataset-manifest.json"));
      return validateDatasetDirectory(selection);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (selection.endsWith(".jsonl") && !selection.endsWith("events.jsonl")) {
    if (!details.isFile() || details.isSymbolicLink() || details.size > 256 * 1024 * 1024) {
      throw new Error("HF/TRL JSONL validation input must be a regular file no larger than 256 MiB");
    }
    const examples = await readJsonLines(selection, 256 * 1024 * 1024, (value) => {
      datasetExampleSchema.parse(value);
    });
    process.stdout.write(`${JSON.stringify({
      structurally_valid: true,
      integrity_valid: false,
      policy_valid: false,
      training_ready: false,
      examples,
      validation_scope: "schema-only JSONL; validate the complete dataset directory for lineage and checksums",
    })}\n`);
    return true;
  }
  if (selection.toLowerCase().endsWith(".json")
    && details.isFile() && !details.isSymbolicLink() && details.size <= 4 * 1024 * 1024) {
    const candidate = JSON.parse(await readFile(selection, "utf8")) as unknown;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)
      && (candidate as Record<string, unknown>).record_type === "dataset_build") {
      const build = datasetBuildSchema.parse(candidate);
      process.stdout.write(`${JSON.stringify({
        structurally_valid: true,
        frozen_selection: true,
        integrity_valid: false,
        policy_valid: false,
        training_ready: false,
        traces: build.traces.length,
        build_sha256: sha256(canonicalJson(build)),
        validation_scope: "build schema only; export reopens every managed trace and rechecks frozen bindings",
      }, null, 2)}\n`);
      return true;
    }
  }
  const bundle = traceBundleSchema.parse(await loadSelection(selection));
  const quality = inspectQuality(bundle);
  const gates = {
    archive: finalExportGate(bundle, "archive"),
    training_noncompetitive: finalExportGate(bundle, "training_noncompetitive"),
    training_competitive_distillation: finalExportGate(bundle, "training_competitive_distillation"),
    redistribution: finalExportGate(bundle, "redistribution"),
  };
  const exportableModes = Object.entries(gates).filter(([, gate]) => gate.allowed).map(([mode]) => mode);
  const valid = quality.passed && exportableModes.length > 0;
  process.stdout.write(`${JSON.stringify({
    valid,
    structurally_valid: true,
    trace_id: bundle.manifest.trace_id,
    quality,
    exportable_modes: exportableModes,
    gates,
  }, null, 2)}\n`);
  return valid;
}

export async function runPolicyExplain(selection: string): Promise<void> {
  const bundle = await loadSelection(selection);
  process.stdout.write(`${JSON.stringify({
    trace_id: bundle.manifest.trace_id,
    source: bundle.manifest.source,
    account_contract: bundle.manifest.account_contract,
    rights: bundle.manifest.rights,
    consent: bundle.manifest.consent,
    decisions: bundle.manifest.eligibility,
    approval_scope: bundle.manifest.review.approval_scope,
    approval_validation: {
      archive: validateApprovalScope(bundle, "archive"),
      training_noncompetitive: validateApprovalScope(bundle, "training_noncompetitive"),
      training_competitive_distillation: validateApprovalScope(bundle, "training_competitive_distillation"),
      redistribution: validateApprovalScope(bundle, "redistribution"),
    },
    gates: {
      archive: finalExportGate(bundle, "archive"),
      automatic_capture: evaluateGate(bundle, "automatic_capture"),
      training_noncompetitive: finalExportGate(bundle, "training_noncompetitive"),
      training_competitive_distillation: finalExportGate(bundle, "training_competitive_distillation"),
      redistribution: finalExportGate(bundle, "redistribution"),
    },
  }, null, 2)}\n`);
}

export interface ExportCommandOptions {
  format: ExportFormat;
  output: string;
  plaintext?: boolean;
  mode?: "archive" | TrainingMode | "redistribution";
}

export async function runExport(selection: string, options: ExportCommandOptions): Promise<void> {
  if (!options.plaintext) throw new Error("Plaintext export requires --plaintext and an explicit output directory");
  const output = resolve(options.output);
  if (!/^[a-f0-9]{32}$/.test(selection)) {
    const build = await readDatasetBuildFile(selection);
    if (options.mode !== undefined && options.mode !== build.mode) {
      throw new Error(`Dataset build is frozen to ${build.mode}; --mode cannot change it`);
    }
    const passphrase = await readPassphrase();
    const bundles = await loadManagedBundlesBounded(build.traces.map((trace) => trace.trace_id), passphrase);
    const result = await exportApprovedDataset(build, bundles, {
      format: options.format,
      outputDirectory: output,
    });
    process.stdout.write(`${JSON.stringify({
      dataset_id: result.datasetId,
      traces: result.manifest.entries.length,
      splits: result.manifest.splits,
      output: result.directory,
      files: result.files,
      warning: "Plaintext copies are outside the managed vault and cannot be recalled automatically.",
    }, null, 2)}\n`);
    return;
  }
  const bundle = await loadSelection(selection);
  const result = await exportApprovedBundle(bundle, {
    format: options.format,
    outputDirectory: output,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  });
  process.stdout.write(`${JSON.stringify({
    trace_id: bundle.manifest.trace_id,
    output: result.directory,
    files: result.files,
    excluded_content_parts: result.excludedParts,
    license: bundle.manifest.rights.source_license_expression,
    warning: "Plaintext copies are outside the managed vault and cannot be recalled automatically.",
  }, null, 2)}\n`);
}

export async function runDelete(traceId: string, yes: boolean): Promise<void> {
  if (!yes) throw new Error("Deletion requires --yes after reviewing the exact trace id");
  const tombstone = await deleteTrace(traceId);
  process.stdout.write(`${JSON.stringify({ trace_id: traceId, deleted: true, tombstone })}\n`);
}

type PolicyDimension = keyof Eligibility;

export interface PolicyOverrideOptions {
  dimension: PolicyDimension;
  status: "allow" | "deny";
  reviewer: string;
  evidenceKind: string;
  evidenceFile: string;
  expires: string;
  reason: string;
  purpose?: string[];
  targetModelOwner?: string;
  targetProduct?: string;
  competitive?: "yes" | "no" | "unknown";
  yes?: boolean;
}

export async function runPolicyOverride(traceId: string, options: PolicyOverrideOptions): Promise<void> {
  if (!/^[a-f0-9]{32}$/.test(traceId)) throw new Error("Policy override requires one exact trace id");
  if (!options.yes) throw new Error("Policy override requires --yes after reviewing its exact scope");
  for (const [label, value] of Object.entries({
    reviewer: options.reviewer,
    evidenceKind: options.evidenceKind,
    evidenceFile: options.evidenceFile,
    reason: options.reason,
  })) {
    if (!value?.trim()) throw new Error(`${label} is required`);
  }
  const evidenceReference = await createEvidenceArtifactReference(
    options.evidenceKind.trim(),
    options.evidenceFile,
  );
  const expiresAt = new Date(options.expires);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new Error("--expires must be a future ISO-8601 timestamp");
  }
  const training = options.dimension.startsWith("training_");
  if (training && (!options.targetModelOwner?.trim() || !options.targetProduct?.trim()
    || !options.competitive || options.competitive === "unknown")) {
    throw new Error("Training overrides require target model owner, target product, and explicit competitive yes/no");
  }
  const passphrase = await readPassphrase();
  const bundle = await loadTrace(traceId, passphrase);
  const previous = bundle.manifest.eligibility[options.dimension];
  const now = new Date().toISOString();
  const decision: EligibilityDecision = eligibilityDecisionSchema.parse({
    status: options.status,
    purposes: options.purpose?.length ? options.purpose : previous.purposes,
    reason_codes: [`MANUAL_OVERRIDE_${options.status.toUpperCase()}`],
    basis: `manual-override:${POLICY_VERSION}:${options.reason.trim()}`,
    target_model_owner: options.targetModelOwner ?? previous.target_model_owner,
    target_product: options.targetProduct ?? previous.target_product,
    competitive_with_source: options.competitive ?? previous.competitive_with_source,
    decision_id: stableId("manual-policy-override", {
      traceId,
      dimension: options.dimension,
      status: options.status,
      reviewer: options.reviewer,
      evidence: evidenceReference,
      expiresAt: expiresAt.toISOString(),
    }),
    decided_at: now,
    expires_at: expiresAt.toISOString(),
    reviewer: options.reviewer.trim(),
    evidence_ref: evidenceReference,
  });
  const updated = {
    ...bundle,
    manifest: {
      ...bundle.manifest,
      eligibility: { ...bundle.manifest.eligibility, [options.dimension]: decision },
      review: {
        ...bundle.manifest.review,
        revision: bundle.manifest.review.revision + 1,
        human_approval: "pending" as const,
        reviewer: null,
        reviewed_at: null,
        approval_scope: null,
        notes: `Policy ${options.dimension} overridden by ${options.reviewer.trim()}: ${options.reason.trim()}`,
      },
    },
  };
  await replaceTrace(updated, passphrase);
  process.stdout.write(`${JSON.stringify({ trace_id: traceId, dimension: options.dimension, decision }, null, 2)}\n`);
}

export interface TermsSnapshotOptions {
  name: string;
  url: string;
  effectiveAt: string;
  reviewAfter: string;
  input: string;
  output: string;
}

export async function runTermsSnapshot(options: TermsSnapshotOptions): Promise<void> {
  const input = resolve(options.input);
  const output = resolve(options.output);
  const inputDetails = await lstat(input);
  if (!inputDetails.isFile() || inputDetails.isSymbolicLink()) {
    throw new Error("Terms snapshot input must be a regular file");
  }
  if (inputDetails.size > 64 * 1024 * 1024) {
    throw new Error("Terms snapshot input exceeds the 64 MiB limit");
  }
  const handle = await open(input, "r");
  let bytes: Buffer;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > 64 * 1024 * 1024) throw new Error("Terms snapshot input changed or exceeds the 64 MiB limit");
    const buffer = Buffer.allocUnsafe(opened.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead !== opened.size) throw new Error("Terms snapshot input changed while it was read");
    bytes = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  const snapshot = termsSnapshotSchema.parse({
    name: options.name,
    url: options.url,
    effective_at: new Date(options.effectiveAt).toISOString(),
    retrieved_at: new Date().toISOString(),
    snapshot_sha256: sha256(bytes),
    review_after: new Date(options.reviewAfter).toISOString(),
  });
  if (Date.parse(snapshot.review_after) <= Date.parse(snapshot.retrieved_at)) {
    throw new Error("--review-after must be later than retrieval time");
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${canonicalJson(snapshot)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output, snapshot }, null, 2)}\n`);
}
