#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const DEMO_ROOT = join(REPOSITORY_ROOT, "examples", "deepseek-research-demo");
const DEFAULT_OUTPUT = join(DEMO_ROOT, "artifacts");
const OUTPUT_MARKER = "trajpack-deepseek-research-demo/0.1\n";
const INTERFACE_VERSION = "deepseek-harness@0.1.0-rc.6/session-event/0";

function usage() {
  return `trajpack local DeepSeek research demo

Usage:
  node scripts/demo-trajectory.mjs [--output <directory>] [--clean] [--quiet]

The input is authored synthetic data. No model, network, account, credential,
commercial output, signature, or hidden chain-of-thought is used.
`;
}

function parseArguments(argv) {
  const result = { output: DEFAULT_OUTPUT, clean: false, quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--clean") result.clean = true;
    else if (argument === "--quiet") result.quiet = true;
    else if (argument === "--help" || argument === "-h") {
      process.stdout.write(usage());
      return null;
    } else if (argument === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--output requires a directory");
      result.output = resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown demo argument: ${argument}`);
    }
  }
  return result;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function isWithin(parent, candidate) {
  const path = relative(parent, candidate);
  return path.length > 0 && !path.startsWith("..") && !isAbsolute(path);
}

function sameFilesystemPath(left, right) {
  const normalize = (path) => process.platform === "win32"
    ? resolve(path).toLocaleLowerCase("en-US")
    : resolve(path);
  return normalize(left) === normalize(right);
}

function isWithinOrEqual(parent, candidate) {
  return sameFilesystemPath(parent, candidate) || isWithin(parent, candidate);
}

async function assertCleanPathHasNoIndirection(output) {
  if (!isWithin(DEMO_ROOT, output)) {
    throw new Error("--clean is restricted to the managed demo directory");
  }

  const demoRootDetails = await lstat(DEMO_ROOT);
  if (!demoRootDetails.isDirectory() || demoRootDetails.isSymbolicLink()) {
    throw new Error("Refusing to clean through a symbolic link, junction, or reparse point");
  }
  const physicalDemoRoot = await realpath(DEMO_ROOT);
  const components = relative(DEMO_ROOT, output).split(sep).filter(Boolean);
  let lexicalComponent = DEMO_ROOT;
  let expectedPhysicalComponent = physicalDemoRoot;
  let outputDetails = demoRootDetails;

  for (const component of components) {
    lexicalComponent = join(lexicalComponent, component);
    expectedPhysicalComponent = join(expectedPhysicalComponent, component);
    outputDetails = await lstat(lexicalComponent);
    if (outputDetails.isSymbolicLink()) {
      throw new Error("Refusing to clean through a symbolic link, junction, or reparse point");
    }
    const physicalComponent = await realpath(lexicalComponent);
    if (!isWithinOrEqual(physicalDemoRoot, physicalComponent)
      || !sameFilesystemPath(expectedPhysicalComponent, physicalComponent)) {
      throw new Error("Refusing to clean through filesystem indirection outside the managed demo boundary");
    }
  }

  return { details: outputDetails, physicalDemoRoot };
}

async function assertManagedTreeHasNoIndirection(root, physicalDemoRoot) {
  async function visit(directory) {
    const physicalDirectory = await realpath(directory);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const child = join(directory, entry.name);
      const details = await lstat(child);
      if (details.isSymbolicLink()) {
        throw new Error("Refusing to clean a demo tree containing a symbolic link, junction, or reparse point");
      }
      const physicalChild = await realpath(child);
      if (!isWithinOrEqual(physicalDemoRoot, physicalChild)
        || !sameFilesystemPath(join(physicalDirectory, entry.name), physicalChild)) {
        throw new Error("Refusing to clean a demo tree containing filesystem indirection");
      }
      if (details.isDirectory()) await visit(child);
      else if (!details.isFile()) {
        throw new Error("Refusing to clean a demo tree containing an unsupported filesystem entry");
      }
    }
  }
  await visit(root);
}

async function prepareOutput(output, clean) {
  if (clean && await exists(output)) {
    const { details, physicalDemoRoot } = await assertCleanPathHasNoIndirection(output);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error("Refusing to clean a non-directory or symbolic-link demo target");
    }
    const markerPath = join(output, ".trajpack-demo-output");
    const markerDetails = await lstat(markerPath).catch(() => null);
    if (markerDetails === null || !markerDetails.isFile() || markerDetails.isSymbolicLink()) {
      throw new Error("Refusing to clean an unmarked directory");
    }
    const physicalOutput = await realpath(output);
    const physicalMarker = await realpath(markerPath);
    if (!sameFilesystemPath(join(physicalOutput, ".trajpack-demo-output"), physicalMarker)) {
      throw new Error("Refusing to clean a directory with an indirect managed marker");
    }
    const marker = await readFile(markerPath, "utf8").catch(() => null);
    if (marker !== OUTPUT_MARKER) throw new Error("Refusing to clean an unmarked directory");
    await assertManagedTreeHasNoIndirection(output, physicalDemoRoot);
    await assertCleanPathHasNoIndirection(output);
    await rm(output, { recursive: true, force: false });
  }
  // Recursive creation so `--output a/b/c` works when the parent does not
  // already exist; indirection checks run before this point.
  await mkdir(output, { recursive: true, mode: 0o700 });
  await writeFile(join(output, ".trajpack-demo-output"), OUTPUT_MARKER, { flag: "wx", mode: 0o600 });
}

async function importBuilt(relativePath) {
  const absolute = join(REPOSITORY_ROOT, relativePath);
  try {
    return await import(pathToFileURL(absolute).href);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      throw new Error("Built trajpack packages are missing. Run `pnpm build` before the demo.");
    }
    throw error;
  }
}

async function loadModules() {
  const [adapters, core, schema] = await Promise.all([
    importBuilt(join("packages", "adapters", "dist", "index.js")),
    importBuilt(join("packages", "core", "dist", "index.js")),
    importBuilt(join("packages", "schema", "dist", "index.js")),
  ]);
  return { adapters, core, schema };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonl(path) {
  const text = await readFile(path, "utf8");
  return text.split(/\r?\n/u).filter((line) => line.trim().length > 0).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Invalid JSONL record ${index + 1} in ${relative(REPOSITORY_ROOT, path)}`);
    }
  });
}

async function writeExclusive(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, value, { flag: "wx", mode: 0o600 });
}

async function writeJson(path, value, canonicalJson) {
  await writeExclusive(path, `${canonicalJson(value)}\n`);
}

function payloadSequence(payload) {
  const sequence = payload?.event?.seq;
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Synthetic capsule is missing a safe sequence");
  return sequence;
}

function buildRaw(payloads, adapters, schema) {
  return payloads.map((payload) => schema.rawEnvelopeSchema.parse(adapters.createRawEnvelope(
    "deepseek_harness",
    payload,
    {
      sequence: payloadSequence(payload),
      adapterVersion: "0.1.0",
      interfaceVersion: INTERFACE_VERSION,
    },
    INTERFACE_VERSION,
  )));
}

function normalizeTrace(manifestInput, raw, modules) {
  const { adapters, core, schema } = modules;
  const manifest = schema.traceManifestSchema.parse(structuredClone(manifestInput));
  const events = [];
  const ids = new Set();
  let nextSequence = 0;
  for (const envelope of raw) {
    const normalized = adapters.normalizeRawEnvelope(envelope, {
      traceId: manifest.trace_id,
      nextSequence,
    });
    if (normalized.length === 0) throw new Error(`Capsule ${envelope.source_event_id ?? envelope.sequence} has no canonical projection`);
    for (const candidate of normalized) {
      const event = schema.trajectoryEventSchema.parse(candidate);
      nextSequence = Math.max(nextSequence, event.sequence + 1);
      if (ids.has(event.event_id)) continue;
      ids.add(event.event_id);
      events.push(event);
    }
  }
  events.sort((left, right) => left.sequence - right.sequence
    || left.event_id.localeCompare(right.event_id));
  const bundle = schema.traceBundleSchema.parse({
    manifest: {
      ...manifest,
      lineage: {
        ...manifest.lineage,
        raw_sha256: core.sha256(core.canonicalJson(raw)),
      },
    },
    raw,
    events,
  });
  const sanitized = core.sanitizeBundle(bundle);
  const reviewed = core.applyAutomatedReview(sanitized.bundle);
  return {
    bundle: schema.traceBundleSchema.parse(reviewed.bundle),
    redactionFindingCount: sanitized.findingCount,
    quality: reviewed.report,
  };
}

function attachSyntheticToolRights(bundle, core) {
  const decision = bundle.manifest.eligibility.training_competitive_distillation;
  const sourceSha256 = core.sha256(core.canonicalJson(bundle.manifest.source));
  for (const event of bundle.events) {
    if (event.tool === null || (event.tool.arguments === null && event.tool.result === null)) continue;
    event.metadata.trajpack_review = {
      rights_attestation: {
        schema_version: "rights-attestation/0.1",
        rights: bundle.manifest.rights,
        scopes: [{
          mode: "training_competitive_distillation",
          target_model_owner: decision.target_model_owner,
          target_product: decision.target_product,
        }],
        reviewer: "trajpack-demo-synthetic-reviewer",
        evidence_ref: "synthetic-owned-content:demo-v1",
        evidence_sha256: core.sha256("synthetic owned tool arguments and results; demo v1"),
        attested_at: "2026-08-16T00:00:00.000Z",
        expires_at: "2099-01-01T00:00:00.000Z",
        event_sha256: core.reviewEvidenceFingerprint(event),
        source_sha256: sourceSha256,
      },
    };
  }
}

function approveSyntheticTrace(input, core, schema, note) {
  const bundle = structuredClone(input);
  attachSyntheticToolRights(bundle, core);
  bundle.manifest.review = {
    ...bundle.manifest.review,
    revision: bundle.manifest.review.revision + 1,
    human_approval: "pending",
    reviewer: "trajpack-demo-synthetic-reviewer",
    reviewed_at: "2026-08-16T00:00:00.000Z",
    notes: note,
    approval_scope: null,
  };
  bundle.manifest.review.approval_scope = core.createApprovalScope(bundle, [
    "training_competitive_distillation",
  ]);
  bundle.manifest.review.human_approval = "approved";
  return schema.traceBundleSchema.parse(bundle);
}

async function sha256File(path) {
  const content = await readFile(path);
  return createHash("sha256").update(content).digest("hex");
}

async function listFiles(root) {
  const result = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Demo output contains a symbolic link: ${relative(root, absolute)}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) result.push(absolute);
      else throw new Error(`Demo output contains an unsupported filesystem entry: ${relative(root, absolute)}`);
    }
  }
  await visit(root);
  return result;
}

async function verifyExporterChecksums(hfDirectory) {
  const lines = (await readFile(join(hfDirectory, "checksums.txt"), "utf8"))
    .trim().split("\n").filter(Boolean);
  const mismatches = [];
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (.+)$/u.exec(line);
    if (!match) {
      mismatches.push(`malformed:${line}`);
      continue;
    }
    const actual = await sha256File(join(hfDirectory, ...match[2].split("/")));
    if (actual !== match[1]) mismatches.push(match[2]);
  }
  return mismatches;
}

function countTargets(examples, component) {
  return examples.flatMap((example) => example.training_targets)
    .filter((target) => target.components.includes(component)).length;
}

async function buildRootChecksums(output) {
  const files = (await listFiles(output)).filter((path) => {
    const name = relative(output, path).replaceAll("\\", "/");
    return name !== ".trajpack-demo-output" && name !== "checksums.sha256";
  });
  const entries = [];
  for (const file of files) {
    entries.push({
      name: relative(output, file).replaceAll("\\", "/"),
      digest: await sha256File(file),
    });
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  await writeExclusive(join(output, "checksums.sha256"),
    `${entries.map(({ digest, name }) => `${digest}  ${name}`).join("\n")}\n`);
  for (const entry of entries) {
    if (await sha256File(join(output, ...entry.name.split("/"))) !== entry.digest) {
      throw new Error(`Root checksum changed during publication: ${entry.name}`);
    }
  }
  return entries;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function runDemo(options = {}) {
  const output = resolve(options.output ?? DEFAULT_OUTPUT);
  const quiet = options.quiet === true;
  const transcript = [];
  const announce = (message) => {
    transcript.push(message);
    if (!quiet) process.stdout.write(`${message}\n`);
  };

  await prepareOutput(output, options.clean === true);
  announce("[1/7] load pinned synthetic DeepSeek Harness rc.6 capsules");
  const modules = await loadModules();
  const { adapters, core, schema } = modules;
  const fixtureRoot = join(DEMO_ROOT, "fixtures");
  const [manifest, payloads, failurePayloads] = await Promise.all([
    readJson(join(fixtureRoot, "manifest.template.json")),
    readJsonl(join(fixtureRoot, "raw.session.jsonl")),
    readJsonl(join(fixtureRoot, "raw.failure-gap.jsonl")),
  ]);
  const raw = buildRaw(payloads, adapters, schema);
  const epochCompilation = adapters.compileDeepSeekRequestEpochs(payloads);
  assert(epochCompilation.complete, "Valid fixture did not reconstruct complete request epochs");
  assert(epochCompilation.epochs.length === 2, "Valid fixture should contain exactly two request epochs");

  announce("[2/7] normalize, privacy-scan, and produce the review-ready trace");
  const normalized = normalizeTrace(manifest, raw, modules);
  assert(normalized.redactionFindingCount === 0, "Synthetic fixture unexpectedly triggered privacy redaction");
  assert(normalized.quality.passed, "Synthetic fixture failed automated quality checks");
  assert(core.rawIntegrityReasons(normalized.bundle).length === 0, "Valid fixture failed raw integrity checks");
  await writeJson(join(output, "normalized", "review-ready.trace.json"), normalized.bundle, core.canonicalJson);
  await writeJson(join(output, "normalized", "quality-report.json"), normalized.quality, core.canonicalJson);

  announce("[3/7] apply a purpose-scoped synthetic-data review approval");
  const approved = approveSyntheticTrace(
    normalized.bundle,
    core,
    schema,
    "Demo-only approval: every input and output byte is authored synthetic content; no real model was invoked.",
  );
  assert(core.validateApprovalScope(approved, "training_competitive_distillation").length === 0,
    "Synthetic approval scope is invalid");
  await writeJson(join(output, "approved", "approved.trace.json"), approved, core.canonicalJson);

  announce("[4/7] export exact deepseek_epoch_sft JSONL and native Parquet");
  const hfDirectory = join(output, "hf-trl");
  const exportResult = await core.exportApprovedBundle(approved, {
    format: "hf-trl",
    outputDirectory: hfDirectory,
    mode: "training_competitive_distillation",
    trainingRecipe: "deepseek_epoch_sft",
  });
  const examples = (await readFile(join(hfDirectory, "dataset.jsonl"), "utf8"))
    .trim().split("\n").filter(Boolean).map((line) => schema.datasetExampleSchema.parse(JSON.parse(line)));
  const parquetMismatches = await core.validateHfParquetFile(join(hfDirectory, "dataset.parquet"), examples);
  const exporterChecksumMismatches = await verifyExporterChecksums(hfDirectory);
  const hfTextFiles = (await listFiles(hfDirectory))
    .filter((path) => !path.endsWith("dataset.parquet"));
  const hfText = (await Promise.all(hfTextFiles.map((path) => readFile(path, "utf8")))).join("\n");
  const rawPayloadMarkers = ["session_header", "first_live_seq", "seed_length", "surfaceOp", "sourceEventSeqs"]
    .filter((marker) => hfText.includes(marker));
  assert(examples.length === 2, "Exact epoch export should contain two SFT examples");
  assert(parquetMismatches.length === 0, `Parquet round-trip mismatch: ${parquetMismatches.join(", ")}`);
  assert(exporterChecksumMismatches.length === 0,
    `Exporter checksum mismatch: ${exporterChecksumMismatches.join(", ")}`);
  assert(rawPayloadMarkers.length === 0, `HF export leaked raw capsule fields: ${rawPayloadMarkers.join(", ")}`);
  assert(countTargets(examples, "tool_arguments") === 1, "Demo must retain one supervised tool-call epoch");
  assert(countTargets(examples, "reasoning") === 1, "Demo must retain one explicit synthetic reasoning target");
  assert(examples.every((example) => example.reward === null && example.verifier === null),
    "SFT demo must not fabricate reward or verifier labels");

  announce("[5/7] derive content-free research metrics and TraceLab-shaped workload rows");
  const analytics = core.deriveResearchAnalytics({ kind: "approved_bundles", bundles: [approved] });
  const workloadRows = core.toTraceLabWorkloadRows({ kind: "approved_bundles", bundles: [approved] });
  await writeJson(join(output, "analytics", "research-metrics.json"), analytics, core.canonicalJson);
  await writeExclusive(join(output, "analytics", "tracelab-workload.jsonl"),
    workloadRows.length === 0 ? "" : `${workloadRows.map(core.canonicalJson).join("\n")}\n`);

  announce("[6/7] prove sequence gaps fail closed");
  const failureManifest = structuredClone(manifest);
  failureManifest.trace_id = "d3305eed000000000000000000000002";
  const failureRaw = buildRaw(failurePayloads, adapters, schema);
  const failedEpochs = adapters.compileDeepSeekRequestEpochs(failurePayloads);
  assert(!failedEpochs.complete, "Gap fixture unexpectedly compiled as complete");
  assert(failedEpochs.diagnostics.some((item) => item.code === "sequence_gap_or_duplicate"),
    "Gap fixture did not report its sequence failure");
  const failedNormalized = normalizeTrace(failureManifest, failureRaw, modules);
  const failedApproved = approveSyntheticTrace(
    failedNormalized.bundle,
    core,
    schema,
    "Content-only demo approval; the automated sequence-gap failure deliberately remains blocking.",
  );
  const failureExportDirectory = join(output, "failure", "must-not-exist");
  let blockedMessage = null;
  try {
    await core.exportApprovedBundle(failedApproved, {
      format: "hf-trl",
      outputDirectory: failureExportDirectory,
      mode: "training_competitive_distillation",
      trainingRecipe: "deepseek_epoch_sft",
    });
  } catch (error) {
    blockedMessage = error instanceof Error ? error.message : "unknown failure";
  }
  assert(blockedMessage !== null, "Gap fixture unexpectedly produced a training export");
  assert(!await exists(failureExportDirectory), "Blocked export left a plaintext output directory");
  const failureReport = {
    schema_version: "trajpack-demo-failure/0.1",
    expected_failure: "missing DeepSeek Harness durable sequence 5",
    epoch_complete: failedEpochs.complete,
    epoch_diagnostics: failedEpochs.diagnostics,
    raw_integrity_reasons: core.rawIntegrityReasons(failedApproved),
    automated_checks: failedApproved.manifest.review.automated_checks,
    export_blocked: true,
    output_directory_created: false,
    safe_error: blockedMessage,
  };
  await writeJson(join(output, "failure", "failure-report.json"), failureReport, core.canonicalJson);

  announce("[7/7] validate lineage, masks, labels, checksums, and reproducibility evidence");
  const trainingViewReport = await readJson(join(hfDirectory, "training-view-report.json"));
  const hiddenCotClaims = trainingViewReport.views
    .filter((view) => view?.metadata?.hidden_chain_of_thought_claimed !== false).length;
  assert(hiddenCotClaims === 0, "Training view made an unsupported hidden-chain-of-thought claim");
  const utilityEvidence = {
    schema_version: "trajpack-demo-utility-evidence/0.1",
    evidence_scope: "structural training readiness and serialization fidelity only",
    empirical_model_improvement_claimed: false,
    synthetic_fixture: true,
    commercial_model_output_present: false,
    hidden_chain_of_thought_present_or_claimed: false,
    signature_decoding_attempted: false,
    exact_request_epochs: epochCompilation.epochs.length,
    hf_examples: examples.length,
    supervised_assistant_messages: examples.reduce((sum, example) =>
      sum + example.assistant_loss_mask.filter(Boolean).length, 0),
    supervised_tool_call_epochs: countTargets(examples, "tool_arguments"),
    supervised_reasoning_epochs: countTargets(examples, "reasoning"),
    supervised_answer_epochs: countTargets(examples, "answer_text"),
    fabricated_reward_count: examples.filter((example) => example.reward !== null).length,
    fabricated_preference_pair_count: 0,
    jsonl_schema_validation: "passed",
    parquet_jsonl_roundtrip: "passed",
    exporter_checksum_validation: "passed",
    exact_epoch_input_sha256: epochCompilation.epochs.map((epoch) => epoch.input_sha256),
    exact_epoch_output_sha256: epochCompilation.epochs.map((epoch) => epoch.output_sha256),
    limitations: [
      "This demo does not train a model and therefore cannot establish downstream accuracy gains.",
      "The reasoning string is authored synthetic content that exercises provider-exposed field handling.",
      "Real research data requires source-specific permission, authenticity, privacy, quality, and human review.",
    ],
  };
  await writeJson(join(output, "utility-evidence.json"), utilityEvidence, core.canonicalJson);

  const validationReport = {
    schema_version: "trajpack-demo-validation/0.1",
    result: "passed",
    trace_schema: "trajectory/0.1",
    raw_capsules: raw.length,
    canonical_events: approved.events.length,
    raw_integrity_reasons: core.rawIntegrityReasons(approved),
    quality_passed: normalized.quality.passed,
    automated_review: approved.manifest.review.automated_checks,
    human_review: approved.manifest.review.human_approval,
    approval_scope_reasons: core.validateApprovalScope(approved, "training_competitive_distillation"),
    epoch_compiler: epochCompilation.compiler_version,
    exact_epochs: epochCompilation.epochs.length,
    hf_jsonl_examples: examples.length,
    parquet_mismatches: parquetMismatches,
    exporter_checksum_mismatches: exporterChecksumMismatches,
    fail_closed_fixture: failureReport.export_blocked,
    raw_payload_markers_found: rawPayloadMarkers,
    output_contains_raw_capsules: rawPayloadMarkers.length > 0,
  };
  await writeJson(join(output, "validation-report.json"), validationReport, core.canonicalJson);

  const primaryFiles = [
    "normalized/review-ready.trace.json",
    "approved/approved.trace.json",
    "hf-trl/dataset.jsonl",
    "hf-trl/dataset.parquet",
    "hf-trl/training-view-report.json",
    "analytics/research-metrics.json",
    "failure/failure-report.json",
    "utility-evidence.json",
    "validation-report.json",
  ];
  const primaryChecksums = {};
  for (const name of primaryFiles) primaryChecksums[name] = await sha256File(join(output, ...name.split("/")));
  const reproducibility = {
    schema_version: "trajpack-demo-reproducibility/0.1",
    generator: "scripts/demo-trajectory.mjs",
    generator_sha256: await sha256File(SCRIPT_PATH),
    fixture_interface: INTERFACE_VERSION,
    fixture_sha256: {
      raw_session_jsonl: await sha256File(join(fixtureRoot, "raw.session.jsonl")),
      raw_failure_gap_jsonl: await sha256File(join(fixtureRoot, "raw.failure-gap.jsonl")),
      manifest_template_json: await sha256File(join(fixtureRoot, "manifest.template.json")),
    },
    canonical_raw_sha256: approved.manifest.lineage.raw_sha256,
    approval_bundle_sha256: approved.manifest.review.approval_scope.bundle_sha256,
    primary_artifact_sha256: primaryChecksums,
    export_artifact_sha256: exportResult.checksums,
  };
  await writeJson(join(output, "reproducibility.json"), reproducibility, core.canonicalJson);
  await writeExclusive(join(output, "terminal-transcript.txt"), `${[
    "$ pnpm build",
    "[build output omitted from deterministic transcript]",
    "$ node scripts/demo-trajectory.mjs --clean",
    ...transcript,
    "PASS: 2 exact SFT epochs; JSONL/Parquet agree; gap fixture blocked.",
    "NOTICE: synthetic fixture only; no real model or hidden chain-of-thought.",
  ].join("\n")}\n`);
  const rootChecksums = await buildRootChecksums(output);
  announce(`PASS: ${examples.length} exact SFT epochs; ${rootChecksums.length} artifacts checksummed; gap fixture blocked.`);
  announce("NOTICE: this is structural evidence from synthetic data, not a downstream model-quality claim.");
  const replay = {
    schema_version: "trajpack-demo-replay/0.1",
    actual_run: true,
    reproducible_command: "pnpm build && node scripts/demo-trajectory.mjs --clean",
    source_kind: "authored-synthetic-deepseek-harness-fixture",
    video_evidence_scope: "replay of the ETL, validation, and export run only",
    training_effect_evidence: false,
    sensitive_content_emitted: false,
    local_paths_emitted: false,
    secrets_or_credentials_emitted: false,
    hidden_chain_of_thought_emitted: false,
    result: "passed",
    hf_examples: examples.length,
    exact_request_epochs: epochCompilation.epochs.length,
    fail_closed_gap_fixture: true,
    artifact_count: rootChecksums.length,
    artifact_manifest_sha256: await sha256File(join(output, "checksums.sha256")),
    frames: transcript.map((message, index) => ({ frame: index + 1, message })),
  };
  const replayRoot = join(REPOSITORY_ROOT, "work", "demo-replay");
  await mkdir(replayRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(replayRoot, "trajpack-deepseek-demo.json"), `${core.canonicalJson(replay)}\n`, { mode: 0o600 });
  const replayTranscript = [
    "$ pnpm build",
    "[build completed successfully; verbose output omitted from the safe replay]",
    "$ node scripts/demo-trajectory.mjs --clean",
    ...transcript,
  ];
  await writeFile(join(replayRoot, "trajpack-deepseek-demo.txt"), `${replayTranscript.join("\n")}\n`, { mode: 0o600 });
  return { output, examples: examples.length, rootChecksums, utilityEvidence, failureReport };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options === null) return;
  await runDemo(options);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === SCRIPT_PATH) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "unknown demo failure";
    process.stderr.write(`trajpack demo failed: ${message}\n`);
    process.exitCode = 1;
  });
}
