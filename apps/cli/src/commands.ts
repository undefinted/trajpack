import { lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Eligibility, EligibilityDecision, TraceBundle } from "@trajpack/schema";
import { datasetExampleSchema, eligibilityDecisionSchema, termsSnapshotSchema, traceBundleSchema } from "@trajpack/schema";
import {
  POLICY_VERSION,
  canonicalJson,
  deleteTrace,
  evaluateGate,
  exportApprovedBundle,
  inspectQuality,
  loadTrace,
  replaceTrace,
  sha256,
  stableId,
  type ExportFormat,
  type TrainingMode,
  validateApprovalScope,
} from "@trajpack/core";
import { loadSelection } from "./bundle-io.js";
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

export async function runValidate(selection: string): Promise<boolean> {
  if (selection.endsWith(".jsonl") && !selection.endsWith("events.jsonl")) {
    const lines = (await readFile(selection, "utf8")).split(/\r?\n/).filter(Boolean);
    for (const line of lines) datasetExampleSchema.parse(JSON.parse(line));
    process.stdout.write(`${JSON.stringify({ valid: true, examples: lines.length })}\n`);
    return true;
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
  if (!/^[a-f0-9]{32}$/.test(selection)) {
    throw new Error("Export requires one exact managed-vault trace id; import and review external artifacts first");
  }
  const bundle = await loadSelection(selection);
  const output = resolve(options.output);
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
  evidence: string;
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
  for (const [label, value] of Object.entries({ reviewer: options.reviewer, evidence: options.evidence, reason: options.reason })) {
    if (!value?.trim()) throw new Error(`${label} is required`);
  }
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
      evidence: options.evidence,
      expiresAt: expiresAt.toISOString(),
    }),
    decided_at: now,
    expires_at: expiresAt.toISOString(),
    reviewer: options.reviewer.trim(),
    evidence_ref: options.evidence.trim(),
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
