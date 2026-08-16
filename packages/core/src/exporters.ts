import { chmod, lstat, mkdir, open, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ParquetSchema, ParquetWriter } from "@dsnp/parquetjs";
import type { ApprovalMode, DatasetExample, TraceBundle, TrajectoryEvent } from "@trajpack/schema";
import { verifierConfirmationSchema, verifierEvidenceSchema } from "@trajpack/schema";
import { canonicalJson, sha256, stableId } from "./canonical.js";
import { approvalFingerprint, evaluateGate, POLICY_VERSION, reviewEvidenceFingerprint, validateApprovalScope } from "./policy.js";
import { inspectQuality, type QualityReport } from "./quality.js";

export type ExportFormat = "canonical" | "atif" | "hf-trl" | "otlp";
export type TrainingMode = "training_noncompetitive" | "training_competitive_distillation";

export interface ExportOptions {
  format: ExportFormat;
  outputDirectory: string;
  mode?: "archive" | TrainingMode | "redistribution";
}

export interface ExportResult {
  directory: string;
  files: string[];
  checksums: Record<string, string>;
  excludedParts: Array<{ eventId: string; ordinal: number; reason: string }>;
}

interface VerifiedLabel {
  reward: number;
  verifier: { name: string; version: string };
  sourceEventId: string;
}

function verifiedLabel(bundle: TraceBundle): VerifiedLabel | null {
  for (const event of [...bundle.events].reverse()) {
    if (event.review_disposition !== "include" || !["evaluation", "feedback"].includes(event.event_type)) continue;
    const reward = event.metadata.reward;
    const review = event.metadata.trajpack_review;
    if (typeof reward !== "number" || !Number.isFinite(reward)
      || !review || typeof review !== "object" || Array.isArray(review)) continue;
    const verifier = verifierEvidenceSchema.safeParse(event.metadata.verifier);
    const confirmation = verifierConfirmationSchema.safeParse(
      (review as Record<string, unknown>).verifier_confirmation,
    );
    if (!verifier.success || !confirmation.success
      || confirmation.data.event_sha256 !== reviewEvidenceFingerprint(event)
      || confirmation.data.reward !== reward
      || canonicalJson(confirmation.data.verifier) !== canonicalJson(verifier.data)) continue;
    return {
      reward,
      verifier: { name: verifier.data.name, version: verifier.data.version },
      sourceEventId: event.event_id,
    };
  }
  return null;
}

function eventText(event: TrajectoryEvent, includeReasoning: boolean): string {
  return event.content
    .filter((part) => part.review_disposition === "include")
    .filter((part) => includeReasoning || part.type !== "reasoning")
    .filter((part) => part.reasoning?.representation !== "opaque_reasoning_state")
    .map((part) => part.value ?? `[${part.type}:${part.blob_ref ?? part.sha256}]`)
    .join("\n");
}

function selectedBundle(bundle: TraceBundle, excluded: ExportResult["excludedParts"] = []): TraceBundle {
  const excludedKeys = new Set(excluded.map((part) => `${part.eventId}\u0000${part.ordinal}`));
  const selectedEvents = bundle.events
    .filter((event) => event.review_disposition === "include")
    .map((event) => ({
      ...event,
      content: event.content
        .filter((part) => part.review_disposition === "include")
        .filter((part) => !excludedKeys.has(`${event.event_id}\u0000${part.ordinal}`)),
    }));
  const wasRedacted = (event: TrajectoryEvent): boolean => {
    const review = event.metadata.trajpack_review;
    return event.content.some((part) => part.redaction_status === "redacted")
      || event.metadata.trajpack_structured_redaction !== undefined
      || (typeof review === "object" && review !== null
        && (review as Record<string, unknown>).disposition === "redact");
  };
  const redactedSpans = new Map<string, string>();
  for (const event of selectedEvents.filter(wasRedacted)) {
    redactedSpans.set(event.span_id, sha256(canonicalJson({
      scope: "redacted-span",
      trace_id: event.trace_id,
      sequence: event.sequence,
      event_type: event.event_type,
      actor: event.actor,
    })).slice(0, 16));
  }
  const events = selectedEvents.map((event) => {
    const rekey = redactedSpans.has(event.span_id);
    const metadata = { ...event.metadata };
    if (rekey) {
      delete metadata.raw_payload_sha256;
      delete metadata.payload_sha256;
      delete metadata.payload_preview_hash;
    }
    return {
      ...event,
      ...(rekey ? {
        event_id: `redacted:${sha256(canonicalJson({
          scope: "redacted-event",
          trace_id: event.trace_id,
          sequence: event.sequence,
          event_type: event.event_type,
          actor: event.actor,
        })).slice(0, 32)}`,
        source_event_id: null,
      } : {}),
      span_id: redactedSpans.get(event.span_id) ?? event.span_id,
      parent_span_id: event.parent_span_id === null
        ? null
        : redactedSpans.get(event.parent_span_id) ?? event.parent_span_id,
      links: event.links.map((link) => ({
        ...link,
        span_id: redactedSpans.get(link.span_id) ?? link.span_id,
      })),
      metadata,
    };
  });
  const hasRedaction = redactedSpans.size > 0;
  const selected: TraceBundle = {
    ...bundle,
    manifest: hasRedaction ? {
      ...bundle.manifest,
      lineage: { ...bundle.manifest.lineage, raw_sha256: null },
    } : bundle.manifest,
    raw: [],
    events,
  };
  const sourceApproval = bundle.manifest.review.approval_scope;
  if (sourceApproval !== null) {
    selected.manifest = {
      ...selected.manifest,
      review: {
        ...selected.manifest.review,
        approval_scope: {
          ...sourceApproval,
          approved_source_bundle_sha256: sourceApproval.approved_source_bundle_sha256 ?? sourceApproval.bundle_sha256,
          export_pass_version: "export-view/0.1",
          bundle_sha256: approvalFingerprint(selected),
        },
      },
    };
    // approvalFingerprint excludes review, so the value remains stable after
    // attaching the derived-view attestation above.
    selected.manifest.review.approval_scope!.bundle_sha256 = approvalFingerprint(selected);
  }
  return selected;
}

export function toAtif(bundle: TraceBundle): Record<string, unknown> {
  const label = verifiedLabel(bundle);
  return {
    schema_version: "atif/rfc-0001-pinned-2026-08-16",
    trajectory_id: bundle.manifest.trace_id,
    source: bundle.manifest.source,
    messages: bundle.events.filter((event) => event.review_disposition === "include").map((event) => ({
      message_id: event.event_id,
      parent_message_id: event.parent_span_id,
      source_call_id: event.tool?.call_id ?? null,
      role: event.actor,
      timestamp: event.started_at,
      status: event.status,
      content: event.content
        .filter((part) => part.review_disposition === "include")
        .filter((part) => part.type !== "reasoning" && part.reasoning?.representation !== "opaque_reasoning_state")
        .map((part) => ({ type: part.type, value: part.value, blob_ref: part.blob_ref, sha256: part.sha256 })),
      reasoning_content: event.content
        .filter((part) => part.review_disposition === "include")
        .filter((part) => part.type === "reasoning" && part.reasoning?.representation !== "opaque_reasoning_state")
        .map((part) => ({ value: part.value, metadata: part.reasoning })),
      tool_call: event.event_type === "tool.call" ? event.tool : null,
      observation: event.event_type === "tool.result" ? event.tool : null,
      metadata: {
        trace_id: event.trace_id,
        span_id: event.span_id,
        links: event.links,
        source_session_id: event.source_session_id,
        source_turn_id: event.source_turn_id,
        source_step_id: event.source_step_id,
        usage: event.usage,
        event_type: event.event_type,
      },
    })),
    reward: label?.reward ?? null,
    provenance: {
      schema_version: bundle.manifest.schema_version,
      policy_decisions: bundle.manifest.eligibility,
      review: bundle.manifest.review,
      lineage: bundle.manifest.lineage,
      verified_label: label,
    },
  };
}

export function toHfExample(bundle: TraceBundle): DatasetExample {
  const messages: Array<Record<string, unknown>> = [];
  const lossMask: boolean[] = [];
  const tools = new Map<string, Record<string, unknown>>();
  const label = verifiedLabel(bundle);

  for (const event of bundle.events.filter((candidate) => candidate.review_disposition === "include")) {
    if (event.event_type === "tool.call" && event.tool) {
      const call = {
        id: event.tool.call_id,
        type: "function",
        function: {
          name: event.tool.name,
          arguments: typeof event.tool.arguments === "string" ? event.tool.arguments : canonicalJson(event.tool.arguments),
        },
      };
      messages.push({ role: "assistant", content: null, tool_calls: [call], event_id: event.event_id });
      lossMask.push(true);
      if (event.tool.name) tools.set(event.tool.name, {
        type: "function",
        function: {
          name: event.tool.name,
          parameters: event.metadata.tool_schema ?? event.metadata.input_schema ?? {},
        },
      });
      continue;
    }
    if (event.event_type === "tool.result" && event.tool) {
      messages.push({
        role: "tool",
        tool_call_id: event.tool.call_id,
        name: event.tool.name,
        content: typeof event.tool.result === "string" ? event.tool.result : canonicalJson(event.tool.result),
        event_id: event.event_id,
      });
      lossMask.push(false);
      continue;
    }
    if (!["message", "reasoning", "plan", "error", "feedback", "evaluation"].includes(event.event_type)) continue;
    const role = event.actor === "agent" ? "assistant" : event.actor;
    const reasoning = event.content
      .filter((part) => part.review_disposition === "include")
      .filter((part) => part.type === "reasoning"
        && part.reasoning?.representation !== "opaque_reasoning_state"
        && part.reasoning?.include_in_loss === true)
      .map((part) => part.value)
      .filter((value): value is string => value !== null)
      .join("\n");
    const content = eventText(event, false);
    const includedParts = event.content
      .filter((part) => part.review_disposition === "include")
      .filter((part) => part.reasoning?.representation !== "opaque_reasoning_state");
    if (!content && !reasoning) continue;
    messages.push({
      role,
      content,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      event_id: event.event_id,
      event_type: event.event_type,
    });
    const hasLossTarget = includedParts.some((part) => part.value !== null
      && (part.type !== "reasoning" || part.reasoning?.include_in_loss === true));
    lossMask.push(role === "assistant" && hasLossTarget);
  }

  return {
    id: stableId("example", { trace: bundle.manifest.trace_id, events: bundle.events.map((event) => event.event_id) }),
    trace_id: bundle.manifest.trace_id,
    source_event_ids: bundle.events.map((event) => event.event_id),
    messages,
    tools: [...tools.values()],
    assistant_loss_mask: lossMask,
    reward: label?.reward ?? null,
    verifier: label?.verifier ?? null,
    metadata: {
      source: bundle.manifest.source,
      rights: bundle.manifest.rights,
      eligibility: bundle.manifest.eligibility,
      review: bundle.manifest.review,
      lineage: bundle.manifest.lineage,
      verified_label_source_event_id: label?.sourceEventId ?? null,
    },
  };
}

export function toOtlp(bundle: TraceBundle): Record<string, unknown> {
  return {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: "service.name", value: { stringValue: "trajpack" } },
          { key: "gen_ai.system", value: { stringValue: bundle.manifest.source.provider } },
          { key: "gen_ai.agent.name", value: { stringValue: bundle.manifest.source.product } },
        ],
      },
      scopeSpans: [{
        scope: { name: "trajpack", version: "0.1.0" },
        spans: bundle.events.map((event) => ({
          traceId: event.trace_id,
          spanId: event.span_id,
          parentSpanId: event.parent_span_id ?? undefined,
          name: event.event_type,
          kind: event.event_type.startsWith("tool.") ? 3 : 1,
          startTimeUnixNano: String(BigInt(Date.parse(event.started_at)) * 1_000_000n),
          endTimeUnixNano: String(BigInt(Date.parse(event.ended_at ?? event.started_at)) * 1_000_000n),
          attributes: [
            { key: "trajpack.event_id", value: { stringValue: event.event_id } },
            { key: "trajpack.actor", value: { stringValue: event.actor } },
            { key: "trajpack.content.sha256", value: { stringValue: sha256(canonicalJson(event.content)) } },
          ],
          status: { code: event.status === "error" ? 2 : 1 },
        })),
      }],
    }],
  };
}

function datasetCard(
  bundle: TraceBundle,
  format: ExportFormat,
  excluded: ExportResult["excludedParts"],
  quality: QualityReport,
  redaction: Record<string, unknown>,
  mode: ApprovalMode,
): string {
  const safe = (value: string): string => value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "\\u0060")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "�");
  const errorCount = quality.issues.filter((issue) => issue.severity === "error").length;
  const warningCount = quality.issues.filter((issue) => issue.severity === "warning").length;
  return `# trajpack dataset card

- Trace: \`${safe(bundle.manifest.trace_id)}\`
- Schema: \`${safe(bundle.manifest.schema_version)}\`
- Policy: \`${safe(POLICY_VERSION)}\`
- Eligibility gate: \`${safe(mode)}\`
- Export format: \`${safe(format)}\`
- Source: \`${safe(`${bundle.manifest.source.host}/${bundle.manifest.source.provider}/${bundle.manifest.source.product}`)}\`
- Model: \`${safe(bundle.manifest.source.model_id ?? "unknown")}\`
- Account/contract class: \`${safe(bundle.manifest.account_contract.account_type)}\`
- Capture fidelity: \`${bundle.manifest.source.fidelity}\`
- Events: ${bundle.events.length}
- Excluded opaque or unsupported parts: ${excluded.length}
- Automated checks: \`${safe(bundle.manifest.review.automated_checks)}\`
- Human approval: \`${safe(bundle.manifest.review.human_approval)}\`
- Quality issues: ${errorCount} errors / ${warningCount} warnings
- EGS completeness: ${quality.metrics.egs_completeness_ratio}
- TOR completeness: ${quality.metrics.tor_completeness_ratio}
- Exact / near duplicate text: ${quality.metrics.exact_duplicate_text_count} / ${quality.metrics.near_duplicate_text_count}
- Source license expression: \`${safe(bundle.manifest.rights.source_license_expression)}\`
- Model license chain: \`${safe(bundle.manifest.rights.model_license_chain.join(" -> ") || "unknown")}\`
- Input rights basis: \`${safe(bundle.manifest.rights.input_rights_basis)}\`
- Terms snapshots: ${bundle.manifest.account_contract.terms.length}
- Redaction summary: \`${safe(canonicalJson(redaction))}\`

This artifact contains observable trajectory data only. Reasoning labels describe the
provider-exposed representation and do not assert access to hidden chain-of-thought.
`;
}

async function writeParquet(path: string, example: DatasetExample): Promise<void> {
  const schema = new ParquetSchema({
    id: { type: "UTF8" },
    trace_id: { type: "UTF8" },
    messages_json: { type: "UTF8" },
    tools_json: { type: "UTF8" },
    assistant_loss_mask_json: { type: "UTF8" },
    reward: { type: "DOUBLE", optional: true },
    verifier_json: { type: "UTF8", optional: true },
    metadata_json: { type: "UTF8" },
  });
  // parquetjs opens with truncation but does not expose a creation-mode
  // option. Pre-create atomically at 0600 so there is never a world-readable
  // interval between writer creation and the final chmod.
  const placeholder = await open(path, "wx", 0o600);
  await placeholder.close();
  const writer = await ParquetWriter.openFile(schema, path);
  try {
    await writer.appendRow({
      id: example.id,
      trace_id: example.trace_id,
      messages_json: canonicalJson(example.messages),
      tools_json: canonicalJson(example.tools),
      assistant_loss_mask_json: canonicalJson(example.assistant_loss_mask),
      ...(example.reward === null ? {} : { reward: example.reward }),
      ...(example.verifier === null ? {} : { verifier_json: canonicalJson(example.verifier) }),
      metadata_json: canonicalJson(example.metadata),
    });
  } finally {
    await writer.close();
  }
}

async function createPrivateOutputDirectory(path: string): Promise<void> {
  const parent = dirname(path);
  const parentDetails = await lstat(parent);
  if (!parentDetails.isDirectory() || parentDetails.isSymbolicLink()) {
    throw new Error(`Export parent must be an existing non-symlink directory: ${parent}`);
  }
  try {
    await lstat(path);
    throw new Error(`Export destination already exists: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path, { recursive: false, mode: 0o700 });
  const created = await lstat(path);
  if (!created.isDirectory() || created.isSymbolicLink()) {
    throw new Error(`Export destination is not a private managed directory: ${path}`);
  }
  await chmod(path, 0o700);
}

async function writeTrackedFile(directory: string, relativePath: string, value: string | Uint8Array, files: string[], checksums: Record<string, string>): Promise<void> {
  const path = join(directory, relativePath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, value, { flag: "wx", mode: 0o600 });
  files.push(path);
  checksums[relativePath] = sha256(value);
}

function redactionReport(original: TraceBundle, selected: TraceBundle): Record<string, unknown> {
  const originalParts = original.events.flatMap((event) => event.content);
  const selectedParts = selected.events.flatMap((event) => event.content);
  const countBy = (field: "redaction_status" | "sensitivity") => Object.fromEntries(
    [...new Set(selectedParts.map((part) => part[field]))]
      .sort()
      .map((value) => [value, selectedParts.filter((part) => part[field] === value).length]),
  );
  return {
    policy_version: original.manifest.privacy.redaction_policy_version,
    original_event_count: original.events.length,
    exported_event_count: selected.events.length,
    excluded_event_count: original.events.length - selected.events.length,
    original_content_part_count: originalParts.length,
    exported_content_part_count: selectedParts.length,
    excluded_content_part_count: originalParts.length - selectedParts.length,
    redaction_status: countBy("redaction_status"),
    sensitivity: countBy("sensitivity"),
  };
}

function exportDecision(bundle: TraceBundle, mode: ApprovalMode) {
  return mode === "archive" ? bundle.manifest.eligibility.local_archive : bundle.manifest.eligibility[mode];
}

function lineageReport(bundle: TraceBundle, format: ExportFormat, mode: ApprovalMode): Record<string, unknown> {
  return {
    trace_id: bundle.manifest.trace_id,
    canonical_schema_version: bundle.manifest.schema_version,
    export_format: format,
    eligibility_mode: mode,
    eligibility_decision: exportDecision(bundle, mode),
    policy_version: POLICY_VERSION,
    source: bundle.manifest.source,
    source_event_ids: bundle.events.map((event) => event.source_event_id ?? event.event_id),
    raw_sha256: bundle.manifest.lineage.raw_sha256,
    normalizer_version: bundle.manifest.lineage.normalizer_version,
    parent_trace_ids: bundle.manifest.lineage.parent_trace_ids,
    eligibility: bundle.manifest.eligibility,
    review: bundle.manifest.review,
  };
}

export async function exportApprovedBundle(bundle: TraceBundle, options: ExportOptions): Promise<ExportResult> {
  const mode = options.mode ?? (options.format === "canonical" ? "archive" : "training_competitive_distillation");
  if (["atif", "hf-trl"].includes(options.format)
    && mode !== "training_noncompetitive" && mode !== "training_competitive_distillation") {
    throw new Error("ATIF and HF/TRL exports require an explicit training eligibility gate");
  }
  const gate = evaluateGate(bundle, mode);
  const reviewReasons = [
    ...(bundle.manifest.review.automated_checks === "passed" ? [] : ["AUTOMATED_CHECKS_NOT_PASSED"]),
    ...validateApprovalScope(bundle, mode),
  ];
  if (!gate.allowed || reviewReasons.length > 0) {
    throw new Error(`Export blocked by policy: ${[...new Set([...gate.reasonCodes, ...reviewReasons])].join(", ")}`);
  }
  await createPrivateOutputDirectory(options.outputDirectory);
  const files: string[] = [];
  const checksums: Record<string, string> = {};
  const selected = selectedBundle(bundle, gate.excludedContentParts);
  const exportedEventIds = new Map<string, string>();
  bundle.events.filter((event) => event.review_disposition === "include")
    .forEach((event, index) => {
      const exported = selected.events[index];
      if (exported) exportedEventIds.set(event.event_id, exported.event_id);
    });
  const exportedExcludedParts = gate.excludedContentParts.map((part) => ({
    ...part,
    eventId: exportedEventIds.get(part.eventId) ?? part.eventId,
  }));
  const sidecar = canonicalJson({
    manifest: selected.manifest,
    canonical_events: selected.events,
    excluded_content_parts: exportedExcludedParts,
    export_mode: mode,
    eligibility_decision: exportDecision(selected, mode),
    approval_scope: selected.manifest.review.approval_scope,
  });
  const quality = inspectQuality(selected);
  const redaction = redactionReport(bundle, selected);

  if (options.format === "canonical") {
    await writeTrackedFile(options.outputDirectory, "manifest.json", `${canonicalJson(selected.manifest)}\n`, files, checksums);
    await writeTrackedFile(options.outputDirectory, "events.jsonl", `${selected.events.map(canonicalJson).join("\n")}\n`, files, checksums);
    const blobs = new Map<string, string>();
    for (const part of selected.events.flatMap((event) => event.content)) {
      if (part.value !== null) blobs.set(part.sha256, part.value);
    }
    for (const [digest, value] of [...blobs].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
      await writeTrackedFile(options.outputDirectory, `blobs/sha256/${digest}`, value, files, checksums);
    }
  } else if (options.format === "atif") {
    await writeTrackedFile(options.outputDirectory, "trajectory.atif.json", `${canonicalJson(toAtif(selected))}\n`, files, checksums);
    await writeTrackedFile(options.outputDirectory, "provenance.json", `${sidecar}\n`, files, checksums);
  } else if (options.format === "hf-trl") {
    const example = toHfExample(selected);
    await writeTrackedFile(options.outputDirectory, "dataset.jsonl", `${canonicalJson(example)}\n`, files, checksums);
    const parquetPath = join(options.outputDirectory, "dataset.parquet");
    await writeParquet(parquetPath, example);
    await chmod(parquetPath, 0o600);
    const parquet = await import("node:fs/promises").then(({ readFile }) => readFile(parquetPath));
    files.push(parquetPath);
    checksums["dataset.parquet"] = sha256(parquet);
    await writeTrackedFile(options.outputDirectory, "provenance.json", `${sidecar}\n`, files, checksums);
  } else {
    await writeTrackedFile(options.outputDirectory, "traces.otlp.json", `${canonicalJson(toOtlp(selected))}\n`, files, checksums);
    await writeTrackedFile(options.outputDirectory, "provenance.json", `${sidecar}\n`, files, checksums);
  }
  await writeTrackedFile(options.outputDirectory, "lineage.json", `${canonicalJson(lineageReport(selected, options.format, mode))}\n`, files, checksums);
  await writeTrackedFile(options.outputDirectory, "quality-report.json", `${canonicalJson(quality)}\n`, files, checksums);
  await writeTrackedFile(options.outputDirectory, "redaction-report.json", `${canonicalJson(redaction)}\n`, files, checksums);
  await writeTrackedFile(options.outputDirectory, "license-summary.json", `${canonicalJson({
    code_license: "Apache-2.0",
    data_license_is_independent: true,
    export_mode: mode,
    eligibility_decision: exportDecision(selected, mode),
    source_license_expression: selected.manifest.rights.source_license_expression,
    rights: selected.manifest.rights,
    per_content_rights_overrides: selected.events.flatMap((event) => event.content)
      .filter((part) => part.rights_override)
      .map((part) => ({ sha256: part.sha256, rights: part.rights_override })),
    per_event_rights_attestations: selected.events
      .filter((event) => event.metadata.trajpack_review !== undefined)
      .map((event) => ({
        event_id: event.event_id,
        attestation: (event.metadata.trajpack_review as Record<string, unknown>)?.rights_attestation ?? null,
      }))
      .filter((entry) => entry.attestation !== null),
    terms_snapshots: selected.manifest.account_contract.terms,
    eligibility: selected.manifest.eligibility,
  })}\n`, files, checksums);
  await writeTrackedFile(options.outputDirectory, "DATASET_CARD.md", datasetCard(selected, options.format, exportedExcludedParts, quality, redaction, mode), files, checksums);
  await writeTrackedFile(
    options.outputDirectory,
    "checksums.txt",
    `${Object.entries(checksums).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([name, digest]) => `${digest}  ${name}`).join("\n")}\n`,
    files,
    checksums,
  );
  return { directory: options.outputDirectory, files, checksums, excludedParts: exportedExcludedParts };
}
