import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ApprovalMode, DatasetExample, TraceBundle, TrajectoryEvent } from "@trajpack/schema";
import { datasetExampleSchema, verifierConfirmationSchema, verifierEvidenceSchema } from "@trajpack/schema";
import { canonicalJson, sha256, stableId } from "./canonical.js";
import { approvalFingerprint, evaluateGate, POLICY_VERSION, reviewEvidenceFingerprint, validateApprovalScope } from "./policy.js";
import { inspectQuality, type QualityReport } from "./quality.js";
import { writeHfParquet } from "./hf-parquet.js";
import { assertSafeOutputParent } from "./safe-path.js";
import { structuredToolProjectionExcluded } from "./selection.js";
import {
  compileTrainingView,
  type CompiledTrainingView,
  type TrainingViewCompilation,
  type TrainingViewRecipe,
} from "./training-views.js";

export type ExportFormat = "canonical" | "atif" | "hf-trl" | "otlp";
export type TrainingMode = "training_noncompetitive" | "training_competitive_distillation";

export interface ExportOptions {
  format: ExportFormat;
  outputDirectory: string;
  mode?: "archive" | TrainingMode | "redistribution";
  trainingRecipe?: TrainingViewRecipe;
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
  targetEventId: string;
  targetEventSha256: string;
}

function verifiedLabel(bundle: TraceBundle): VerifiedLabel | null {
  for (const event of [...bundle.events].reverse()) {
    if (event.review_disposition !== "include" || !["evaluation", "feedback"].includes(event.event_type)) continue;
    const reward = event.metadata.reward;
    const targetEventId = event.metadata.target_event_id;
    const targetEventSha256 = event.metadata.target_event_sha256;
    const review = event.metadata.trajpack_review;
    if (typeof reward !== "number" || !Number.isFinite(reward)
      || typeof targetEventId !== "string" || typeof targetEventSha256 !== "string"
      || !review || typeof review !== "object" || Array.isArray(review)) continue;
    const verifier = verifierEvidenceSchema.safeParse(event.metadata.verifier);
    const confirmation = verifierConfirmationSchema.safeParse(
      (review as Record<string, unknown>).verifier_confirmation,
    );
    const target = bundle.events.find((candidate) => candidate.event_id === targetEventId) ?? null;
    if (target === null || reviewEvidenceFingerprint(target) !== targetEventSha256
      || !verifier.success || !confirmation.success
      || confirmation.data.event_sha256 !== reviewEvidenceFingerprint(event)
      || confirmation.data.reward !== reward
      || canonicalJson(confirmation.data.verifier) !== canonicalJson(verifier.data)) continue;
    return {
      reward,
      verifier: { name: verifier.data.name, version: verifier.data.version },
      sourceEventId: event.event_id,
      targetEventId,
      targetEventSha256,
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
    .filter((event) => !structuredToolProjectionExcluded(event, excludedKeys))
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
  const events = [...bundle.events]
    .filter((event) => event.review_disposition === "include")
    .sort((left, right) => left.sequence - right.sequence);
  if (events.length === 0) throw new Error("ATIF-v1.7 requires at least one included trajectory step");
  const units = atifUnits(events);
  const steps = units.map((unit, index) => atifStep(unit, index + 1, bundle));
  const sessionId = events.find((event) => event.source_session_id !== null)?.source_session_id;
  const definitions = atifToolDefinitions(events);
  const label = verifiedLabel(bundle);
  return {
    schema_version: "ATIF-v1.7",
    ...(sessionId ? { session_id: sessionId } : {}),
    trajectory_id: bundle.manifest.trace_id,
    agent: {
      name: bundle.manifest.source.product,
      version: bundle.manifest.source.adapter_version,
      ...(bundle.manifest.source.model_id ? { model_name: bundle.manifest.source.model_id } : {}),
      ...(definitions.length > 0 ? { tool_definitions: definitions } : {}),
      extra: {
        host: bundle.manifest.source.host,
        provider: bundle.manifest.source.provider,
        surface: bundle.manifest.source.surface,
        capture_method: bundle.manifest.source.capture_method,
        interface_version: bundle.manifest.source.interface_version,
        fidelity: bundle.manifest.source.fidelity,
      },
    },
    steps,
    final_metrics: atifFinalMetrics(steps, events),
    extra: {
      trajpack: {
        canonical_schema_version: bundle.manifest.schema_version,
        mapping_version: "trajectory-0.1-to-ATIF-v1.7/1",
        mapping_fidelity: "lossy_with_canonical_sidecar",
        reasoning_notice: "reasoning_content is provider-exposed or generated observable data; it does not assert hidden chain-of-thought access",
        verified_label: label,
        policy_decisions: bundle.manifest.eligibility,
        review: bundle.manifest.review,
        lineage: bundle.manifest.lineage,
      },
    },
  };
}

type AtifSource = "system" | "user" | "agent";

interface AtifUnit {
  events: TrajectoryEvent[];
  results: TrajectoryEvent[];
}

interface AtifCallGroup extends AtifUnit {
  start: number;
  end: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function atifObject(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return Object.fromEntries(Object.entries(value));
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return Object.fromEntries(Object.entries(parsed));
    } catch {
      // Preserve non-JSON tool arguments explicitly instead of dropping them.
    }
  }
  return value === null || value === undefined ? {} : { value };
}

function atifValue(value: unknown): string {
  return typeof value === "string" ? value : canonicalJson(value);
}

function atifCallId(event: TrajectoryEvent): string {
  return event.tool?.call_id
    ?? `trajpack-call-${sha256(canonicalJson({ event_id: event.event_id, sequence: event.sequence })).slice(0, 24)}`;
}

/**
 * A complete session/turn/step tuple is the only portable evidence that
 * adjacent call events came from one model step. Missing boundaries fail
 * closed to one call per ATIF step rather than inventing parallelism.
 */
function atifParallelBoundary(event: TrajectoryEvent): string | null {
  if (event.source_session_id === null || event.source_turn_id === null || event.source_step_id === null) return null;
  return canonicalJson([event.source_session_id, event.source_turn_id, event.source_step_id]);
}

function compatibleRun(call: TrajectoryEvent, result: TrajectoryEvent): boolean {
  if (call.source_session_id !== null && result.source_session_id !== null
    && call.source_session_id !== result.source_session_id) return false;
  if (call.source_turn_id !== null && result.source_turn_id !== null
    && call.source_turn_id !== result.source_turn_id) return false;
  return true;
}

function atifUnits(events: TrajectoryEvent[]): AtifUnit[] {
  const groups: AtifCallGroup[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.event_type !== "tool.call") continue;
    const boundary = atifParallelBoundary(event);
    const calls = [event];
    let end = index;
    while (boundary !== null && end + 1 < events.length) {
      const candidate = events[end + 1]!;
      if (candidate.event_type !== "tool.call" || atifParallelBoundary(candidate) !== boundary) break;
      calls.push(candidate);
      end += 1;
    }
    groups.push({ start: index, end, events: calls, results: [] });
    index = end;
  }

  const assignedResults = new Set<number>();
  for (let index = 0; index < events.length; index += 1) {
    const result = events[index]!;
    if (result.event_type !== "tool.result"
      || result.tool?.call_id === null || result.tool?.call_id === undefined) continue;
    const group = [...groups].reverse().find((candidate) => candidate.end < index
      && candidate.events.some((call) => call.tool?.call_id === result.tool?.call_id && compatibleRun(call, result)));
    if (!group) continue;
    group.results.push(result);
    assignedResults.add(index);
  }

  const groupByStart = new Map(groups.map((group) => [group.start, group]));
  const groupedIndexes = new Set(groups.flatMap((group) => group.events.map((_, offset) => group.start + offset)));
  const units: AtifUnit[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const group = groupByStart.get(index);
    if (group) {
      units.push({ events: group.events, results: group.results });
      continue;
    }
    if (groupedIndexes.has(index) || assignedResults.has(index)) continue;
    units.push({ events: [events[index]!], results: [] });
  }
  return units;
}

function atifSource(unit: AtifUnit): AtifSource {
  const event = unit.events[0]!;
  if (event.event_type === "tool.call") return "agent";
  if (event.event_type === "compaction") return "system";
  if (event.actor === "user") return "user";
  if (event.actor === "assistant" || event.actor === "agent") return "agent";
  return "system";
}

function atifReasoning(events: TrajectoryEvent[]): {
  text: string;
  representations: Array<Record<string, unknown>>;
} {
  const parts = events.flatMap((event) => event.content
    .filter((part) => part.review_disposition === "include")
    .filter((part) => part.type === "reasoning")
    .filter((part) => part.reasoning?.representation !== "opaque_reasoning_state"));
  return {
    text: parts.map((part) => part.value).filter((value): value is string => value !== null).join("\n"),
    representations: parts.map((part) => ({
      representation: part.reasoning?.representation ?? "unavailable",
      provider_claim: part.reasoning?.provider_claim ?? "none",
      source_field: part.reasoning?.source_field ?? null,
      visibility: part.reasoning?.visibility ?? "not_returned",
      include_in_loss: part.reasoning?.include_in_loss ?? false,
      sha256: part.sha256,
    })),
  };
}

function atifMessage(events: TrajectoryEvent[]): string {
  return events.map((event) => eventText(event, false)).filter(Boolean).join("\n");
}

function atifUsage(events: TrajectoryEvent[]): Record<string, unknown> | null {
  const sum = (field: keyof TrajectoryEvent["usage"]): number | undefined => {
    const values = events.map((event) => event.usage[field]).filter((value): value is number => value !== null);
    return values.length > 0 ? values.reduce((total, value) => total + value, 0) : undefined;
  };
  const promptTokens = sum("input_tokens");
  const completionTokens = sum("output_tokens");
  const cachedTokens = sum("cache_read_tokens");
  const costUsd = sum("cost_usd");
  const reasoningTokens = sum("reasoning_tokens");
  const latencyMs = sum("latency_ms");
  if ([promptTokens, completionTokens, cachedTokens, costUsd, reasoningTokens, latencyMs]
    .every((value) => value === undefined)) return null;
  return {
    ...(promptTokens === undefined ? {} : { prompt_tokens: promptTokens }),
    ...(completionTokens === undefined ? {} : { completion_tokens: completionTokens }),
    ...(cachedTokens === undefined ? {} : { cached_tokens: cachedTokens }),
    ...(costUsd === undefined ? {} : { cost_usd: costUsd }),
    ...((reasoningTokens === undefined && latencyMs === undefined) ? {} : {
      extra: {
        ...(reasoningTokens === undefined ? {} : { reasoning_tokens: reasoningTokens }),
        ...(latencyMs === undefined ? {} : { latency_ms: latencyMs }),
      },
    }),
  };
}

function atifObservationResult(event: TrajectoryEvent, knownCallIds: Set<string>): Record<string, unknown> {
  const canonicalCallId = event.tool?.call_id;
  const content = event.tool?.result === null || event.tool?.result === undefined
    ? eventText(event, false)
    : atifValue(event.tool.result);
  return {
    ...(canonicalCallId !== null && canonicalCallId !== undefined && knownCallIds.has(canonicalCallId)
      ? { source_call_id: canonicalCallId }
      : {}),
    ...(content ? { content } : {}),
    extra: {
      trajpack: {
        canonical_event_id: event.event_id,
        status: event.status,
        tool_name: event.tool?.name ?? null,
        exit_code: event.tool?.exit_code ?? null,
        unpaired_source_call_id: canonicalCallId !== null && canonicalCallId !== undefined
          && !knownCallIds.has(canonicalCallId) ? canonicalCallId : null,
      },
    },
  };
}

function atifStepExtra(unit: AtifUnit, reasoning: ReturnType<typeof atifReasoning>): Record<string, unknown> {
  const events = [...unit.events, ...unit.results];
  return {
    trajpack: {
      canonical_event_ids: events.map((event) => event.event_id),
      canonical_event_types: events.map((event) => event.event_type),
      span_ids: [...new Set(events.map((event) => event.span_id))],
      parent_span_ids: [...new Set(events.map((event) => event.parent_span_id).filter((value): value is string => value !== null))],
      source_session_ids: [...new Set(events.map((event) => event.source_session_id).filter((value): value is string => value !== null))],
      source_turn_ids: [...new Set(events.map((event) => event.source_turn_id).filter((value): value is string => value !== null))],
      source_step_ids: [...new Set(events.map((event) => event.source_step_id).filter((value): value is string => value !== null))],
      statuses: [...new Set(events.map((event) => event.status))],
      reasoning_representations: reasoning.representations,
    },
  };
}

function reportedLlmCallCount(events: TrajectoryEvent[]): number | undefined {
  const counts = events.map((event) => event.metadata.llm_call_count)
    .filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0);
  if (counts.length > 0) return Math.max(...counts);
  return events.some((event) => event.event_type === "model.inference") ? 1 : undefined;
}

function atifStep(unit: AtifUnit, stepId: number, bundle: TraceBundle): Record<string, unknown> {
  const event = unit.events[0]!;
  const source = atifSource(unit);
  const message = atifMessage(unit.events);
  const reasoning = atifReasoning(unit.events);
  const knownCallIds = new Set(unit.events
    .filter((candidate) => candidate.event_type === "tool.call")
    .map(atifCallId));
  const toolCalls = event.event_type === "tool.call" ? unit.events.map((call) => ({
    tool_call_id: atifCallId(call),
    function_name: call.tool?.name ?? "unknown_tool",
    arguments: atifObject(call.tool?.arguments),
    extra: {
      trajpack: {
        canonical_event_id: call.event_id,
        status: call.status,
        source_call_id_was_missing: call.tool?.call_id === null || call.tool?.call_id === undefined,
      },
    },
  })) : [];
  const observations = event.event_type === "tool.result"
    ? [atifObservationResult(event, knownCallIds)]
    : unit.results.map((result) => atifObservationResult(result, knownCallIds));
  const llmCallCount = reportedLlmCallCount(unit.events);
  const deterministicDispatch = source === "agent" && llmCallCount === 0;
  const metrics = source === "agent" && !deterministicDispatch ? atifUsage(unit.events) : null;
  const compaction = event.event_type === "compaction";
  const contextMetadata = isRecord(event.metadata.context_management) ? event.metadata.context_management : {};
  const contextType = typeof contextMetadata.type === "string" ? contextMetadata.type : "compaction";
  const contextBoundary = typeof contextMetadata.boundary === "string"
    ? contextMetadata.boundary
    : message ? "replace" : "unknown";
  const extra = atifStepExtra(unit, reasoning);
  if (compaction) {
    extra.context_management = { type: contextType, boundary: contextBoundary };
  }
  const compactionObservation = compaction && message ? [{
    content: message,
    extra: { trajpack: { canonical_event_id: event.event_id, context_summary: true } },
  }] : [];
  return {
    step_id: stepId,
    timestamp: event.started_at,
    source,
    ...(source === "agent" && bundle.manifest.source.model_id
      ? { model_name: bundle.manifest.source.model_id }
      : {}),
    message: message || (compaction ? "Context compaction performed" : ""),
    ...(source === "agent" && !deterministicDispatch && reasoning.text ? { reasoning_content: reasoning.text } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    ...((observations.length > 0 || compactionObservation.length > 0)
      ? { observation: { results: [...observations, ...compactionObservation] } }
      : {}),
    ...(metrics === null ? {} : { metrics }),
    ...(llmCallCount === undefined ? {} : { llm_call_count: llmCallCount }),
    extra,
  };
}

function atifToolDefinitions(events: TrajectoryEvent[]): Array<Record<string, unknown>> {
  const definitions = new Map<string, Record<string, unknown>>();
  for (const event of events.filter((candidate) => candidate.event_type === "tool.call")) {
    const name = event.tool?.name ?? "unknown_tool";
    if (definitions.has(name)) continue;
    const schema = event.metadata.tool_schema ?? event.metadata.input_schema;
    const description = event.metadata.tool_description;
    definitions.set(name, {
      type: "function",
      function: {
        name,
        ...(typeof description === "string" ? { description } : {}),
        parameters: atifObject(schema),
      },
    });
  }
  return [...definitions.values()];
}

function atifFinalMetrics(steps: Array<Record<string, unknown>>, events: TrajectoryEvent[]): Record<string, unknown> {
  const sum = (field: keyof TrajectoryEvent["usage"]): number | undefined => {
    const values = events.map((event) => event.usage[field]).filter((value): value is number => value !== null);
    return values.length > 0 ? values.reduce((total, value) => total + value, 0) : undefined;
  };
  const promptTokens = sum("input_tokens");
  const completionTokens = sum("output_tokens");
  const cachedTokens = sum("cache_read_tokens");
  const costUsd = sum("cost_usd");
  const reasoningTokens = sum("reasoning_tokens");
  const latencyMs = sum("latency_ms");
  return {
    ...(promptTokens === undefined ? {} : { total_prompt_tokens: promptTokens }),
    ...(completionTokens === undefined ? {} : { total_completion_tokens: completionTokens }),
    ...(cachedTokens === undefined ? {} : { total_cached_tokens: cachedTokens }),
    ...(costUsd === undefined ? {} : { total_cost_usd: costUsd }),
    total_steps: steps.length,
    extra: {
      canonical_event_count: events.length,
      ...(reasoningTokens === undefined ? {} : { total_reasoning_tokens: reasoningTokens }),
      ...(latencyMs === undefined ? {} : { total_latency_ms: latencyMs }),
    },
  };
}

interface HfView {
  events: TrajectoryEvent[];
  sessionSha256: string | null;
  branchLeafSha256: string | null;
}

function hfViews(bundle: TraceBundle): HfView[] {
  const included = [...bundle.events]
    .filter((event) => event.review_disposition === "include")
    .sort((left, right) => left.sequence - right.sequence);
  const groups = new Map<string, TrajectoryEvent[]>();
  for (const event of included) {
    const key = event.source_session_id === null ? "\0unscoped" : `session:${event.source_session_id}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  const views: HfView[] = [];
  for (const events of [...groups.values()].sort((left, right) => left[0]!.sequence - right[0]!.sequence)) {
    const sessionId = events.find((event) => event.source_session_id !== null)?.source_session_id ?? null;
    const isPureMessageGraph = events.length > 0
      && events.every((event) => event.event_type === "message")
      && events.some((event) => typeof event.metadata.source_parent_message_id === "string");
    if (!isPureMessageGraph) {
      views.push({
        events,
        sessionSha256: sessionId === null ? null : sha256(`trajpack.hf-session/v1\0${sessionId}`),
        branchLeafSha256: null,
      });
      continue;
    }
    const bySpan = new Map(events.map((event) => [event.span_id, event]));
    const parentBySpan = new Map(events.map((event) => [
      event.span_id,
      event.parent_span_id !== null && bySpan.has(event.parent_span_id) ? event.parent_span_id : null,
    ]));
    const parentSpans = new Set([...parentBySpan.values()].filter((value): value is string => value !== null));
    const leaves = events.filter((event) => !parentSpans.has(event.span_id));
    for (const leaf of leaves) {
      const path: TrajectoryEvent[] = [];
      const visited = new Set<string>();
      let current: TrajectoryEvent | undefined = leaf;
      while (current && !visited.has(current.span_id)) {
        path.push(current);
        visited.add(current.span_id);
        const parentSpan: string | null = parentBySpan.get(current.span_id) ?? null;
        current = parentSpan === null ? undefined : bySpan.get(parentSpan);
      }
      path.reverse();
      views.push({
        events: path,
        sessionSha256: sessionId === null ? null : sha256(`trajpack.hf-session/v1\0${sessionId}`),
        branchLeafSha256: sha256(`trajpack.hf-branch-leaf/v1\0${leaf.event_id}`),
      });
    }
  }
  return views;
}

function toHfViewExample(bundle: TraceBundle, view: HfView): DatasetExample {
  const messages: Array<Record<string, unknown>> = [];
  const lossMask: boolean[] = [];
  const trainingTargets: DatasetExample["training_targets"] = [];
  const tools = new Map<string, Record<string, unknown>>();

  const events = view.events;
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex]!;
    if (event.event_type === "tool.call" && event.tool) {
      const boundary = atifParallelBoundary(event);
      const calls = [event];
      while (boundary !== null && eventIndex + 1 < events.length) {
        const candidate = events[eventIndex + 1]!;
        if (candidate.event_type !== "tool.call" || candidate.tool === null
          || atifParallelBoundary(candidate) !== boundary) break;
        calls.push(candidate);
        eventIndex += 1;
      }
      const messageIndex = messages.length;
      const toolCalls = calls.map((callEvent) => ({
        id: callEvent.tool!.call_id,
        type: "function",
        function: {
          name: callEvent.tool!.name,
          arguments: typeof callEvent.tool!.arguments === "string"
            ? callEvent.tool!.arguments
            : canonicalJson(callEvent.tool!.arguments),
        },
      }));
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: toolCalls,
        event_id: calls.map((callEvent) => callEvent.event_id).join(","),
      });
      lossMask.push(true);
      trainingTargets.push({
        message_index: messageIndex,
        components: ["tool_name", "tool_arguments"],
        loss_weight: 1,
        source_event_ids: calls.map((callEvent) => callEvent.event_id),
      });
      for (const callEvent of calls) {
        if (callEvent.tool?.name) tools.set(callEvent.tool.name, {
          type: "function",
          function: {
            name: callEvent.tool.name,
            parameters: callEvent.metadata.tool_schema ?? callEvent.metadata.input_schema ?? {},
          },
        });
      }
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
    // Streaming adapters retain provider chunks as partial observable events.
    // They remain available in canonical/ATIF and lineage, but compiling them
    // as conversational assistant turns would duplicate prefixes and create
    // accidental loss targets alongside the completed host response.
    if (event.status === "partial"
      && (event.actor === "assistant" || event.actor === "agent")
      && ["message", "reasoning", "plan"].includes(event.event_type)) continue;
    const role = event.actor === "agent" || event.actor === "assistant"
      ? "assistant"
      : event.actor === "user" || event.actor === "developer" || event.actor === "system"
        ? event.actor
        : "system";
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
    const messageIndex = messages.length;
    messages.push({
      role,
      content,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      event_id: event.event_id,
      event_type: event.event_type,
    });
    const hasLossTarget = includedParts.some((part) => part.value !== null
      && (part.type !== "reasoning" || part.reasoning?.include_in_loss === true));
    const trainable = role === "assistant" && hasLossTarget;
    lossMask.push(trainable);
    if (trainable) {
      const components: DatasetExample["training_targets"][number]["components"] = [];
      if (content) components.push(event.event_type === "plan" ? "plan" : "answer_text");
      if (reasoning) components.push("reasoning");
      if (components.length > 0) trainingTargets.push({
        message_index: messageIndex,
        components,
        loss_weight: 1,
        source_event_ids: [event.event_id],
      });
    }
  }

  return datasetExampleSchema.parse({
    id: stableId("example", { trace: bundle.manifest.trace_id, events: view.events.map((event) => event.event_id) }),
    trace_id: bundle.manifest.trace_id,
    source_event_ids: view.events.map((event) => event.event_id),
    messages,
    tools: [...tools.values()],
    assistant_loss_mask: lossMask,
    training_targets: trainingTargets,
    // A trace can contain several assistant turns, while a verifier label is
    // bound to one exact canonical target. The legacy trace_full view cannot
    // express that target unambiguously, so it never promotes a scalar label
    // to an example-level reward. Use pointwise_reward_rl_ready instead.
    reward: null,
    verifier: null,
    metadata: {
      source: bundle.manifest.source,
      rights: bundle.manifest.rights,
      eligibility: bundle.manifest.eligibility,
      review: bundle.manifest.review,
      lineage: bundle.manifest.lineage,
      verified_label_source_event_id: null,
      view: {
        recipe: "trace_full",
        source_session_sha256: view.sessionSha256,
        branch_leaf_sha256: view.branchLeafSha256,
      },
    },
  });
}

export function toHfExamples(bundle: TraceBundle): DatasetExample[] {
  return hfViews(bundle).map((view) => toHfViewExample(bundle, view));
}

export function toHfExample(bundle: TraceBundle): DatasetExample {
  const examples = toHfExamples(bundle);
  if (examples.length !== 1) {
    throw new Error(`Trace compiles to ${examples.length} isolated HF views; use toHfExamples()`);
  }
  return examples[0]!;
}

function trainingViewExample(bundle: TraceBundle, view: CompiledTrainingView): DatasetExample {
  const enabledMessages = new Set(view.loss_targets.map((target) => target.message_index));
  return datasetExampleSchema.parse({
    id: view.view_id,
    trace_id: view.trace_id,
    source_event_ids: view.source_event_ids,
    messages: view.messages.map((message) => ({ ...message })),
    tools: view.tools.map((tool) => ({ ...tool })),
    assistant_loss_mask: view.messages.map((_, index) => enabledMessages.has(index)),
    training_targets: view.loss_targets.map((target) => ({
      message_index: target.message_index,
      components: target.components,
      loss_weight: target.loss_weight,
      source_event_ids: target.source_event_ids,
    })),
    reward: view.reward,
    verifier: view.verifier_provenance === null
      ? null
      : {
        name: view.verifier_provenance.verifier.name,
        version: view.verifier_provenance.verifier.version,
      },
    metadata: {
      source: bundle.manifest.source,
      rights: bundle.manifest.rights,
      eligibility: bundle.manifest.eligibility,
      review: bundle.manifest.review,
      lineage: bundle.manifest.lineage,
      view: {
        recipe: view.recipe,
        recipe_version: view.recipe_version,
        compiler_version: view.compiler_version,
        objective: view.objective,
        target_event_ids: view.target_event_ids,
        evidence_event_ids: view.evidence_event_ids,
        verifier_provenance: view.verifier_provenance,
        ...view.metadata,
      },
    },
  });
}

function compileRecipeExamples(
  bundle: TraceBundle,
  recipe: TrainingViewRecipe,
  rawSource?: TraceBundle,
): { examples: DatasetExample[]; compilation: TrainingViewCompilation } {
  // The exact Harness epoch recipe needs encrypted raw capsules solely for
  // topology replay and input/output hashes. It is compiled against the
  // already-selected canonical export view, and the compiler requires every
  // emitted raw field to match a review-included, privacy-passed canonical
  // projection byte-for-byte. Raw is never serialized into the dataset.
  const compilerInput = recipe === "deepseek_epoch_sft" && rawSource !== undefined
    ? { ...bundle, raw: rawSource.raw }
    : bundle;
  const compilation = compileTrainingView(compilerInput, recipe);
  if (compilation.views.length === 0) {
    const reasons = [...new Set(compilation.exclusions.flatMap((item) => item.reason_codes))].sort();
    throw new Error(`Training recipe ${recipe} produced no eligible views: ${reasons.join(", ")}`);
  }
  return {
    examples: compilation.views.map((view) => trainingViewExample(bundle, view)),
    compilation,
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
  recipe: TrainingViewRecipe | null,
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
- Training view recipe: \`${safe(recipe ?? "trace_full")}\`
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

async function createPrivateStagingDirectory(finalPath: string): Promise<{ finalPath: string; stagingPath: string }> {
  const absolute = resolve(finalPath);
  const parent = dirname(absolute);
  await assertSafeOutputParent(parent);
  try {
    await lstat(absolute);
    throw new Error(`Export destination already exists: ${absolute}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const stagingPath = join(parent, `.${basename(absolute)}.trajpack-stage-${randomBytes(12).toString("hex")}`);
  await mkdir(stagingPath, { recursive: false, mode: 0o700 });
  const created = await lstat(stagingPath);
  if (!created.isDirectory() || created.isSymbolicLink()) {
    throw new Error(`Export staging path is not a private managed directory: ${stagingPath}`);
  }
  await chmod(stagingPath, 0o700);
  return { finalPath: absolute, stagingPath };
}

async function removeExportStaging(stagingPath: string, finalPath: string): Promise<void> {
  const parent = dirname(finalPath);
  if (dirname(stagingPath) !== parent
    || !basename(stagingPath).startsWith(`.${basename(finalPath)}.trajpack-stage-`)) {
    throw new Error("Refusing to remove an unverified export staging directory");
  }
  await rm(stagingPath, { recursive: true, force: true });
}

async function writeTrackedFile(directory: string, relativePath: string, value: string | Uint8Array, files: string[], checksums: Record<string, string>): Promise<void> {
  const path = join(directory, relativePath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, value, { flag: "wx", mode: 0o600 });
  files.push(path);
  checksums[relativePath] = sha256(value);
}

const JSONL_WRITE_BATCH_BYTES = 1024 * 1024;

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  value: Buffer,
): Promise<void> {
  let offset = 0;
  while (offset < value.length) {
    const result = await handle.write(value, offset, value.length - offset, null);
    if (result.bytesWritten <= 0) throw new Error("Export write made no progress");
    offset += result.bytesWritten;
  }
}

/** Write canonical JSONL without constructing a second full-dataset string. */
async function writeTrackedJsonLines(
  directory: string,
  relativePath: string,
  rows: Iterable<unknown>,
  files: string[],
  checksums: Record<string, string>,
): Promise<void> {
  const path = join(directory, relativePath);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o600);
  const digest = createHash("sha256");
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  const flush = async (): Promise<void> => {
    if (pendingBytes === 0) return;
    const buffer = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    await writeAll(handle, buffer);
  };
  try {
    for (const row of rows) {
      const encoded = Buffer.from(`${canonicalJson(row)}\n`, "utf8");
      digest.update(encoded);
      if (pendingBytes > 0 && pendingBytes + encoded.length > JSONL_WRITE_BATCH_BYTES) await flush();
      pending.push(encoded);
      pendingBytes += encoded.length;
      if (pendingBytes >= JSONL_WRITE_BATCH_BYTES) await flush();
    }
    await flush();
    await handle.sync();
  } finally {
    await handle.close();
  }
  files.push(path);
  checksums[relativePath] = digest.digest("hex");
}

async function sha256RegularFile(path: string): Promise<string> {
  const handle = await open(path, "r");
  const digest = createHash("sha256");
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Export artifact is not a regular file: ${path}`);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (result.bytesRead <= 0) throw new Error(`Export artifact was truncated while hashing: ${path}`);
      digest.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error(`Export artifact changed while hashing: ${path}`);
    }
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
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
  if (options.trainingRecipe !== undefined && options.format !== "hf-trl") {
    throw new Error("Versioned training recipes are available only for HF/TRL exports");
  }
  if (options.format === "hf-trl"
    && mode !== "training_noncompetitive" && mode !== "training_competitive_distillation") {
    throw new Error("HF/TRL exports require an explicit training eligibility gate");
  }
  if (options.format === "hf-trl" && bundle.manifest.source.host === "deepseek_harness"
    && options.trainingRecipe === undefined) {
    throw new Error("DeepSeek Harness HF/TRL export requires an explicit versioned recipe; use deepseek_epoch_sft for exact request context");
  }
  const gate = evaluateGate(bundle, mode);
  const reviewReasons = [
    ...(bundle.manifest.review.automated_checks === "passed" ? [] : ["AUTOMATED_CHECKS_NOT_PASSED"]),
    ...validateApprovalScope(bundle, mode),
  ];
  if (!gate.allowed || reviewReasons.length > 0) {
    throw new Error(`Export blocked by policy: ${[...new Set([...gate.reasonCodes, ...reviewReasons])].join(", ")}`);
  }
  const output = await createPrivateStagingDirectory(options.outputDirectory);
  const outputDirectory = output.stagingPath;
  try {
  const files: string[] = [];
  const checksums: Record<string, string> = {};
  const selected = selectedBundle(bundle, gate.excludedContentParts);
  const exportedEventIds = new Map<string, string>();
  const excludedKeys = new Set(gate.excludedContentParts.map((part) => `${part.eventId}\u0000${part.ordinal}`));
  let exportedIndex = 0;
  for (const event of bundle.events) {
    if (event.review_disposition !== "include") continue;
    // `selectedBundle` may drop an included event whose structured tool
    // projection was review-excluded; advance the cursor only for events that
    // actually survive, so `selected.events[exportedIndex]` stays aligned.
    if (structuredToolProjectionExcluded(event, excludedKeys)) continue;
    const exported = selected.events[exportedIndex];
    if (exported) exportedEventIds.set(event.event_id, exported.event_id);
    exportedIndex += 1;
  }
  const exportedExcludedParts = gate.excludedContentParts.map((part) => ({
    ...part,
    eventId: exportedEventIds.get(part.eventId) ?? part.eventId,
  }));
  const sidecar = canonicalJson({
    manifest: selected.manifest,
    canonical_events: selected.events,
    excluded_content_parts: exportedExcludedParts,
    export_mode: mode,
    training_view_recipe: options.trainingRecipe ?? "trace_full",
    eligibility_decision: exportDecision(selected, mode),
    approval_scope: selected.manifest.review.approval_scope,
    verified_label: verifiedLabel(selected),
  });
  const quality = inspectQuality(selected);
  const redaction = redactionReport(bundle, selected);

  if (options.format === "canonical") {
    await writeTrackedFile(outputDirectory, "manifest.json", `${canonicalJson(selected.manifest)}\n`, files, checksums);
    await writeTrackedJsonLines(outputDirectory, "events.jsonl", selected.events, files, checksums);
    const blobs = new Map<string, string>();
    for (const part of selected.events.flatMap((event) => event.content)) {
      if (part.value !== null) blobs.set(part.sha256, part.value);
    }
    for (const [digest, value] of [...blobs].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
      await writeTrackedFile(outputDirectory, `blobs/sha256/${digest}`, value, files, checksums);
    }
  } else if (options.format === "atif") {
    await writeTrackedFile(outputDirectory, "trajectory.atif.json", `${canonicalJson(toAtif(selected))}\n`, files, checksums);
    await writeTrackedFile(outputDirectory, "provenance.json", `${sidecar}\n`, files, checksums);
  } else if (options.format === "hf-trl") {
    const recipeResult = options.trainingRecipe === undefined
      ? null
      : compileRecipeExamples(selected, options.trainingRecipe, bundle);
    const examples = (recipeResult?.examples ?? toHfExamples(selected))
      .map((example) => datasetExampleSchema.parse(example));
    if (examples.length === 0 || examples.some((example) => example.messages.length === 0)) {
      throw new Error("HF/TRL export requires at least one non-empty topology-safe training view");
    }
    await writeTrackedJsonLines(outputDirectory, "dataset.jsonl", examples, files, checksums);
    const parquetPath = join(outputDirectory, "dataset.parquet");
    await writeHfParquet(parquetPath, examples);
    await chmod(parquetPath, 0o600);
    files.push(parquetPath);
    checksums["dataset.parquet"] = await sha256RegularFile(parquetPath);
    if (recipeResult !== null) {
      await writeTrackedFile(
        outputDirectory,
        "training-view-report.json",
        `${canonicalJson(recipeResult.compilation)}\n`,
        files,
        checksums,
      );
    }
    await writeTrackedFile(outputDirectory, "provenance.json", `${sidecar}\n`, files, checksums);
  } else {
    await writeTrackedFile(outputDirectory, "traces.otlp.json", `${canonicalJson(toOtlp(selected))}\n`, files, checksums);
    await writeTrackedFile(outputDirectory, "provenance.json", `${sidecar}\n`, files, checksums);
  }
  await writeTrackedFile(outputDirectory, "lineage.json", `${canonicalJson(lineageReport(selected, options.format, mode))}\n`, files, checksums);
  await writeTrackedFile(outputDirectory, "quality-report.json", `${canonicalJson(quality)}\n`, files, checksums);
  await writeTrackedFile(outputDirectory, "redaction-report.json", `${canonicalJson(redaction)}\n`, files, checksums);
  await writeTrackedFile(outputDirectory, "license-summary.json", `${canonicalJson({
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
  await writeTrackedFile(outputDirectory, "DATASET_CARD.md", datasetCard(
    selected,
    options.format,
    exportedExcludedParts,
    quality,
    redaction,
    mode,
    options.trainingRecipe ?? null,
  ), files, checksums);
  await writeTrackedFile(
    outputDirectory,
    "checksums.txt",
    `${Object.entries(checksums).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([name, digest]) => `${digest}  ${name}`).join("\n")}\n`,
    files,
    checksums,
  );
  await writeTrackedFile(outputDirectory, "COMPLETE", `${canonicalJson({
    schema_version: "export-complete/0.1",
    format: options.format,
    mode,
    trace_id: selected.manifest.trace_id,
    checksums_sha256: checksums["checksums.txt"],
  })}\n`, files, checksums);
  await assertSafeOutputParent(dirname(output.finalPath));
  try {
    await lstat(output.finalPath);
    throw new Error(`Export destination appeared before publication: ${output.finalPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(output.stagingPath, output.finalPath);
  const publishedFiles = files.map((path) => join(output.finalPath, relative(output.stagingPath, path)));
  return { directory: output.finalPath, files: publishedFiles, checksums, excludedParts: exportedExcludedParts };
  } catch (error) {
    await removeExportStaging(output.stagingPath, output.finalPath).catch(() => undefined);
    throw error;
  }
}
