import type {
  ContentPart,
  Provider,
  TraceBundle,
  TrajectoryEvent,
} from "@trajpack/schema";
import { traceBundleSchema, trajectoryEventSchema } from "@trajpack/schema";
import { canonicalJson, sha256 } from "./canonical.js";
import { approvalFingerprint } from "./policy.js";

/**
 * This module is intentionally a derived, content-free research view. Canonical
 * events remain the source of truth and no function below emits content values,
 * tool arguments, tool results, filesystem paths, or provider payloads.
 */
export const RESEARCH_ANALYTICS_VERSION = "research-analytics/0.1" as const;
export const TRACELAB_WORKLOAD_MAPPING_VERSION = "tracelab-workload-derived/0.1" as const;

export type ResearchAnalyticsInput =
  | { kind: "approved_bundles"; bundles: readonly TraceBundle[] }
  | { kind: "selected_events"; events: readonly TrajectoryEvent[] };

interface SourceContext {
  provider: Provider | "unknown";
  workloadProvider: string;
  model: string | null;
}

interface EventRecord extends SourceContext {
  event: TrajectoryEvent;
}

interface ResolvedInput {
  kind: ResearchAnalyticsInput["kind"];
  bundleCount: number;
  records: EventRecord[];
  gateCounts: ResearchAnalyticsSummary["training_yield"]["training_gate_status"];
}

interface RoundGroup extends SourceContext {
  key: string;
  traceId: string;
  sessionId: string | null;
  turnId: string | null;
  stepId: string | null;
  groupingEvidence: "source_step_id" | "inference_event";
  events: TrajectoryEvent[];
}

export interface NumericEvidence {
  observed_round_count: number;
  total: number;
}

export interface LatencyEvidence {
  sample_count: number;
  total_ms: number;
  min_ms: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
  mean_ms: number | null;
  quantile_method: "nearest-rank";
}

export interface ResearchAnalyticsSummary {
  schema_version: typeof RESEARCH_ANALYTICS_VERSION;
  input_kind: ResearchAnalyticsInput["kind"];
  privacy: {
    content_values_emitted: false;
    tool_payloads_emitted: false;
    trajectory_identifiers_emitted: false;
  };
  scope: {
    bundle_count: number;
    trace_count: number;
    candidate_event_count: number;
    selected_event_count: number;
    excluded_event_count: number;
    session_count: number;
    turn_count: number;
  };
  sources: {
    providers: Record<string, number>;
    models: Record<string, number>;
  };
  workload: {
    llm_round_count: number;
    llm_rounds_with_usage: number;
    inference_event_count: number;
    grouping_evidence: {
      source_step_id: number;
      inference_event: number;
    };
    usage: {
      input_tokens: NumericEvidence;
      output_tokens: NumericEvidence;
      reasoning_tokens: NumericEvidence;
      cache_read_tokens: NumericEvidence;
      latency_ms: NumericEvidence;
      cost_usd: NumericEvidence;
      cache_read_to_input_bp: number | null;
      reasoning_to_output_bp: number | null;
      aggregation: "last-non-null-per-derived-round";
    };
  };
  tools: {
    call_count: number;
    result_count: number;
    paired_call_count: number;
    unpaired_call_count: number;
    orphan_result_count: number;
    failed_call_count: number;
    parallel_group_count: number;
    parallel_additional_call_count: number;
    max_observed_concurrency: number;
    latency: LatencyEvidence;
    latency_basis: "call.started_at-to-result.ended_at-or-started_at";
  };
  behavior: {
    reasoning_event_count: number;
    action_event_count: number;
    reasoning_to_action_bp: number | null;
    compaction_event_count: number;
    failed_compaction_count: number;
    subagent_invoke_count: number;
    handoff_count: number;
    approval_request_count: number;
    approval_decision_count: number;
    approval_allow_count: number;
    approval_deny_count: number;
    approval_unknown_count: number;
  };
  errors_and_recovery: {
    failed_event_count: number;
    traces_with_error: number;
    traces_with_evidenced_recovery: number;
    first_errors: Array<{
      trace_ref: string;
      event_ref: string;
      sequence: number;
      event_type: TrajectoryEvent["event_type"];
      recovery_evidenced: boolean;
      recovery_sequence: number | null;
      recovery_latency_ms: number | null;
    }>;
  };
  training_yield: {
    candidate_content_part_count: number;
    selected_content_part_count: number;
    privacy_ready_content_part_count: number;
    assistant_loss_candidate_part_count: number;
    reasoning_loss_candidate_part_count: number;
    selected_event_yield_bp: number | null;
    privacy_ready_content_yield_bp: number | null;
    exclusions: {
      event_review_excluded: number;
      content_review_excluded: number;
      content_not_scanned: number;
      content_quarantined: number;
      opaque_reasoning: number;
      reasoning_loss_disabled: number;
    };
    training_gate_status: {
      noncompetitive: Record<"allow" | "deny" | "unknown", number>;
      competitive_distillation: Record<"allow" | "deny" | "unknown", number>;
      unavailable: number;
    };
    notice: "Structural yield is not a training authorization; target-scoped policy gates still apply.";
  };
}

export interface TraceLabDerivedTimingEvent {
  event_type: string;
  timestamp: string;
  source: string;
  tool_call_id?: string;
  tool_name?: string;
  tool_index?: number;
  is_error?: boolean;
  content_chars?: number;
  result_chars?: number;
}

export interface TraceLabDerivedTool {
  tool_index: number;
  tool_name: string;
  tool_call_id: string;
  emitted_at: string;
  result_at: string | null;
  tool_wall_latency_ms: number | null;
  tool_internal_latency_ms: null;
  is_error: boolean | null;
  input_chars: number;
  result_chars: number;
}

/**
 * A TraceLab-shaped normalized JSONL round. It is deliberately lossy and must
 * never be used to reconstruct a canonical trajectory or training example.
 */
export interface TraceLabCompatibleWorkloadRow {
  provider: string;
  project: "trajpack-derived";
  session_id: string;
  session_file: "trajpack-derived";
  round_index: number;
  round_id: string;
  model: string | null;
  input_tokens_total: number | null;
  prefix_tokens: number | null;
  newly_append_tokens: number | null;
  claude_uncached_input_tokens: null;
  claude_cache_creation_input_tokens: null;
  claude_cache_read_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_output_tokens: number | null;
  timing_events: TraceLabDerivedTimingEvent[];
  tools: TraceLabDerivedTool[];
  current_input_event_count: null;
  current_user_message_count: null;
  current_tool_result_count: null;
  current_user_message_chars: null;
  current_tool_result_chars: null;
  current_input_chars: null;
  first_input_event_type: null;
  home: null;
  user: null;
  store: null;
  trace_key: string;
  _trajpack: {
    mapping_version: typeof TRACELAB_WORKLOAD_MAPPING_VERSION;
    mapping_kind: "lossy_derived";
    canonical_source_of_truth: false;
    content_values_emitted: false;
    tool_payloads_emitted: false;
    round_grouping_evidence: RoundGroup["groupingEvidence"];
    unavailable_fields: readonly string[];
  };
}

const USAGE_FIELDS = [
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_read_tokens",
  "latency_ms",
  "cost_usd",
] as const;

const ACTION_EVENT_TYPES = new Set<TrajectoryEvent["event_type"]>([
  "tool.call",
  "artifact.write",
  "artifact.patch",
]);

const COMMON_TOOL_NAMES = new Map<string, string>([
  "apply_patch", "bash", "browser", "edit", "exec_command", "find", "glob", "grep",
  "image_query", "ls", "open", "read", "read_file", "rg", "search", "shell",
  "terminal", "view_image", "webfetch", "websearch", "write", "write_file", "write_stdin",
].map((name) => [name, name]));

function emptyGateCounts(): ResearchAnalyticsSummary["training_yield"]["training_gate_status"] {
  return {
    noncompetitive: { allow: 0, deny: 0, unknown: 0 },
    competitive_distillation: { allow: 0, deny: 0, unknown: 0 },
    unavailable: 0,
  };
}

function compareEvents(left: TrajectoryEvent, right: TrajectoryEvent): number {
  if (left.trace_id !== right.trace_id) return left.trace_id < right.trace_id ? -1 : 1;
  if (left.sequence !== right.sequence) return left.sequence - right.sequence;
  return left.event_id < right.event_id ? -1 : left.event_id > right.event_id ? 1 : 0;
}

function workloadProvider(bundle: TraceBundle): string {
  if (bundle.manifest.source.host === "codex") return "codex";
  if (bundle.manifest.source.host === "claude_code") return "claude";
  if (bundle.manifest.source.host === "deepseek_harness") return "deepseek_harness";
  if (bundle.manifest.source.host === "gemini_cli") return "gemini";
  return bundle.manifest.source.provider;
}

function assertApprovedBundle(bundle: TraceBundle): void {
  const review = bundle.manifest.review;
  if (bundle.manifest.lineage.tombstoned) throw new Error(`Research analytics rejects tombstoned trace ${bundle.manifest.trace_id}`);
  if (review.automated_checks !== "passed" || review.human_approval !== "approved" || review.approval_scope === null) {
    throw new Error(`Research analytics requires an automatically checked and human-approved bundle: ${bundle.manifest.trace_id}`);
  }
  if (review.approval_scope.bundle_sha256 !== approvalFingerprint(bundle)) {
    throw new Error(`Research analytics rejects a stale approval scope: ${bundle.manifest.trace_id}`);
  }
}

function resolveInput(input: ResearchAnalyticsInput): ResolvedInput {
  if (input.kind === "approved_bundles") {
    const bundles = input.bundles.map((bundle) => traceBundleSchema.parse(bundle));
    if (new Set(bundles.map((bundle) => bundle.manifest.trace_id)).size !== bundles.length) {
      throw new Error("Research analytics requires unique approved bundle trace ids");
    }
    const gateCounts = emptyGateCounts();
    const records: EventRecord[] = [];
    for (const bundle of bundles) {
      assertApprovedBundle(bundle);
      gateCounts.noncompetitive[bundle.manifest.eligibility.training_noncompetitive.status] += 1;
      gateCounts.competitive_distillation[bundle.manifest.eligibility.training_competitive_distillation.status] += 1;
      for (const event of bundle.events) {
        records.push({
          event,
          provider: bundle.manifest.source.provider,
          workloadProvider: workloadProvider(bundle),
          model: bundle.manifest.source.model_id,
        });
      }
    }
    return { kind: input.kind, bundleCount: bundles.length, records: records.sort((a, b) => compareEvents(a.event, b.event)), gateCounts };
  }

  const events = input.events.map((event) => trajectoryEventSchema.parse(event)).sort(compareEvents);
  const identities = new Set<string>();
  for (const event of events) {
    const identity = `${event.trace_id}\u0000${event.event_id}`;
    if (identities.has(identity)) throw new Error(`Research analytics rejects duplicate event identity ${event.event_id}`);
    identities.add(identity);
  }
  const gateCounts = emptyGateCounts();
  gateCounts.unavailable = new Set(events.map((event) => event.trace_id)).size;
  return {
    kind: input.kind,
    bundleCount: 0,
    records: events.map((event) => ({ event, provider: "unknown", workloadProvider: "unknown", model: null })),
    gateCounts,
  };
}

function selectedRecords(records: readonly EventRecord[]): EventRecord[] {
  return records.filter((record) => record.event.review_disposition === "include");
}

function selectedParts(event: TrajectoryEvent): ContentPart[] {
  return event.content.filter((part) => part.review_disposition === "include");
}

function hasUsage(event: TrajectoryEvent): boolean {
  return USAGE_FIELDS.some((field) => event.usage[field] !== null);
}

function deriveRounds(records: readonly EventRecord[]): RoundGroup[] {
  const selected = selectedRecords(records);
  const byTrace = new Map<string, EventRecord[]>();
  for (const record of selected) {
    const trace = byTrace.get(record.event.trace_id) ?? [];
    trace.push(record);
    byTrace.set(record.event.trace_id, trace);
  }
  const rounds: RoundGroup[] = [];
  for (const [traceId, traceRecords] of [...byTrace.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const stepGroups = new Map<string, RoundGroup>();
    const fallbackGroups: RoundGroup[] = [];
    for (const record of traceRecords.sort((a, b) => compareEvents(a.event, b.event))) {
      const event = record.event;
      if (event.source_step_id !== null) {
        const stepKey = canonicalJson([
          traceId,
          event.source_session_id,
          event.source_turn_id,
          event.source_step_id,
        ]);
        let group = stepGroups.get(stepKey);
        if (group === undefined) {
          group = {
            key: `step:${sha256(stepKey)}`,
            traceId,
            sessionId: event.source_session_id,
            turnId: event.source_turn_id,
            stepId: event.source_step_id,
            groupingEvidence: "source_step_id",
            provider: record.provider,
            workloadProvider: record.workloadProvider,
            model: record.model,
            events: [],
          };
          stepGroups.set(stepKey, group);
        }
        group.events.push(event);
        continue;
      }
      if (event.event_type === "model.inference" || hasUsage(event)) {
        fallbackGroups.push({
          key: `inference:${sha256(canonicalJson([traceId, event.event_id]))}`,
          traceId,
          sessionId: event.source_session_id,
          turnId: event.source_turn_id,
          stepId: null,
          groupingEvidence: "inference_event",
          provider: record.provider,
          workloadProvider: record.workloadProvider,
          model: record.model,
          events: [event],
        });
      }
    }
    const groups = [...stepGroups.values(), ...fallbackGroups]
      .filter((group) => group.events.some((event) => event.event_type === "model.inference" || hasUsage(event)))
      .sort((left, right) => compareEvents(left.events[0]!, right.events[0]!));
    // Some adapters expose a request/usage event at the inference level but
    // give each emitted tool item its own source_step_id. Attach those orphan
    // items to the nearest round in the same source turn. This is explicitly a
    // lossy workload association; the canonical topology remains untouched.
    const assigned = new Set(groups.flatMap((group) => group.events.map((event) => event.event_id)));
    const groupsByTurn = new Map<string, RoundGroup[]>();
    for (const group of groups) {
      const turnKey = canonicalJson([group.sessionId, group.turnId]);
      const values = groupsByTurn.get(turnKey) ?? [];
      values.push(group);
      groupsByTurn.set(turnKey, values);
    }
    const precedingRound = (candidates: readonly RoundGroup[], sequence: number): RoundGroup | undefined => {
      let low = 0;
      let high = candidates.length - 1;
      let match: RoundGroup | undefined;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = candidates[middle]!;
        if (candidate.events[0]!.sequence <= sequence) {
          match = candidate;
          low = middle + 1;
        } else high = middle - 1;
      }
      return match;
    };
    for (const { event } of traceRecords) {
      if (assigned.has(event.event_id) || groups.length === 0) continue;
      const sameTurn = groupsByTurn.get(canonicalJson([event.source_session_id, event.source_turn_id])) ?? [];
      const candidates = sameTurn.length > 0 ? sameTurn : groups;
      const target = precedingRound(candidates, event.sequence) ?? candidates[0];
      target?.events.push(event);
      assigned.add(event.event_id);
    }
    for (const group of groups) group.events.sort(compareEvents);
    rounds.push(...groups);
  }
  return rounds;
}

function lastUsage(round: RoundGroup): TrajectoryEvent["usage"] {
  const output: TrajectoryEvent["usage"] = {
    input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    cache_read_tokens: null,
    latency_ms: null,
    cost_usd: null,
  };
  for (const event of round.events) {
    for (const field of USAGE_FIELDS) if (event.usage[field] !== null) output[field] = event.usage[field];
  }
  return output;
}

function numericEvidence(rounds: readonly RoundGroup[], field: typeof USAGE_FIELDS[number]): NumericEvidence {
  const values = rounds.map(lastUsage).map((usage) => usage[field]).filter((value): value is number => value !== null);
  return { observed_round_count: values.length, total: values.reduce((sum, value) => sum + value, 0) };
}

function basisPoints(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator * 10_000) / denominator);
}

function nearestRank(sorted: readonly number[], percentile: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[index] ?? null;
}

function latencyEvidence(values: readonly number[]): LatencyEvidence {
  const sorted = [...values].filter((value) => Number.isFinite(value) && value >= 0).sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    sample_count: sorted.length,
    total_ms: total,
    min_ms: sorted[0] ?? null,
    p50_ms: nearestRank(sorted, 0.5),
    p95_ms: nearestRank(sorted, 0.95),
    max_ms: sorted.at(-1) ?? null,
    mean_ms: sorted.length === 0 ? null : Math.round(total / sorted.length),
    quantile_method: "nearest-rank",
  };
}

interface ToolPair {
  call: TrajectoryEvent;
  result: TrajectoryEvent | null;
  latencyMs: number | null;
}

function validTimestamp(value: string | null): number | null {
  if (value === null) return null;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function pairTools(records: readonly EventRecord[]): { pairs: ToolPair[]; orphanResults: number } {
  const events = selectedRecords(records).map((record) => record.event).sort(compareEvents);
  const resultsByKey = new Map<string, TrajectoryEvent[]>();
  for (const event of events) {
    if (event.event_type !== "tool.result" || event.tool?.call_id === null || event.tool?.call_id === undefined) continue;
    const key = `${event.trace_id}\u0000${event.tool.call_id}`;
    const values = resultsByKey.get(key) ?? [];
    values.push(event);
    resultsByKey.set(key, values);
  }
  const resultCursors = new Map<string, number>();
  let pairedResultCount = 0;
  const pairs: ToolPair[] = [];
  for (const call of events.filter((event) => event.event_type === "tool.call")) {
    const callId = call.tool?.call_id;
    const key = callId === null || callId === undefined ? null : `${call.trace_id}\u0000${callId}`;
    const candidates = key === null ? [] : resultsByKey.get(key) ?? [];
    let resultIndex = key === null ? candidates.length : resultCursors.get(key) ?? 0;
    while (resultIndex < candidates.length && candidates[resultIndex]!.sequence <= call.sequence) resultIndex += 1;
    const result = candidates[resultIndex];
    if (key !== null) resultCursors.set(key, resultIndex + (result === undefined ? 0 : 1));
    if (result !== undefined) {
      pairedResultCount += 1;
    }
    const emitted = validTimestamp(call.started_at);
    const finished = result === undefined ? null : validTimestamp(result.ended_at ?? result.started_at);
    const latencyMs = emitted !== null && finished !== null && finished >= emitted ? finished - emitted : null;
    pairs.push({ call, result: result ?? null, latencyMs });
  }
  const totalResults = events.filter((event) => event.event_type === "tool.result").length;
  return { pairs, orphanResults: totalResults - pairedResultCount };
}

function parallelMetrics(records: readonly EventRecord[]): Pick<ResearchAnalyticsSummary["tools"],
  "parallel_group_count" | "parallel_additional_call_count" | "max_observed_concurrency"> {
  const traces = new Map<string, TrajectoryEvent[]>();
  for (const record of selectedRecords(records)) {
    const values = traces.get(record.event.trace_id) ?? [];
    values.push(record.event);
    traces.set(record.event.trace_id, values);
  }
  let parallelGroupCount = 0;
  let parallelAdditionalCallCount = 0;
  let maxObservedConcurrency = 0;
  for (const events of traces.values()) {
    const active = new Map<string, number>();
    let insideGroup = false;
    for (const event of events.sort(compareEvents)) {
      const callId = event.tool?.call_id;
      if (event.event_type === "tool.call" && callId) {
        const concurrency = [...active.values()].reduce((sum, count) => sum + count, 0);
        if (concurrency > 0) {
          parallelAdditionalCallCount += 1;
          if (!insideGroup) {
            parallelGroupCount += 1;
            insideGroup = true;
          }
        }
        active.set(callId, (active.get(callId) ?? 0) + 1);
        maxObservedConcurrency = Math.max(maxObservedConcurrency, concurrency + 1);
      } else if (event.event_type === "tool.result" && callId) {
        const count = active.get(callId) ?? 0;
        if (count <= 1) active.delete(callId);
        else active.set(callId, count - 1);
        if (active.size === 0) insideGroup = false;
      }
    }
  }
  return {
    parallel_group_count: parallelGroupCount,
    parallel_additional_call_count: parallelAdditionalCallCount,
    max_observed_concurrency: maxObservedConcurrency,
  };
}

function metadataRecovery(event: TrajectoryEvent): boolean {
  for (const key of ["recovered", "recovery", "retry_success"] as const) {
    const value = event.metadata[key];
    if (value === true || value === "true") return true;
  }
  return false;
}

function metadataString(event: TrajectoryEvent, key: string): string | null {
  const value = event.metadata[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isSubagentInvoke(event: TrajectoryEvent): boolean {
  if (event.event_type !== "agent.invoke") return false;
  const lifecycle = metadataString(event, "durable_event_type")
    ?? metadataString(event, "hook_event_name")
    ?? metadataString(event, "lifecycle");
  return lifecycle !== null && /subagent|tool-workflow\/agent-start/iu.test(lifecycle)
    || metadataString(event, "subagent_id") !== null
    || metadataString(event, "child_agent_id") !== null
    || metadataString(event, "subagent_type") !== null
    || metadataString(event, "agent_type") !== null;
}

function firstErrors(records: readonly EventRecord[]): ResearchAnalyticsSummary["errors_and_recovery"] {
  const byTrace = new Map<string, TrajectoryEvent[]>();
  for (const record of selectedRecords(records)) {
    const values = byTrace.get(record.event.trace_id) ?? [];
    values.push(record.event);
    byTrace.set(record.event.trace_id, values);
  }
  const output: ResearchAnalyticsSummary["errors_and_recovery"]["first_errors"] = [];
  const pairedResults = new Set(pairTools(records).pairs.flatMap((pair) => pair.result === null ? [] : [pair.result.event_id]));
  let failedEventCount = 0;
  for (const [traceId, unordered] of [...byTrace.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const events = unordered.sort(compareEvents);
    failedEventCount += events.filter((event) => event.status === "error" || event.event_type === "error").length;
    const first = events.find((event) => event.status === "error" || event.event_type === "error");
    if (first === undefined) continue;
    const recovery = events.find((event) => event.sequence > first.sequence && event.status === "ok"
      && (event.event_type === "evaluation"
        || (event.event_type === "tool.result" && pairedResults.has(event.event_id))
        || metadataRecovery(event)));
    const firstAt = validTimestamp(first.started_at);
    const recoveredAt = recovery === undefined ? null : validTimestamp(recovery.ended_at ?? recovery.started_at);
    output.push({
      trace_ref: publicRef("trace", traceId),
      event_ref: publicRef("event", `${traceId}\u0000${first.event_id}`),
      sequence: first.sequence,
      event_type: first.event_type,
      recovery_evidenced: recovery !== undefined,
      recovery_sequence: recovery?.sequence ?? null,
      recovery_latency_ms: firstAt !== null && recoveredAt !== null && recoveredAt >= firstAt ? recoveredAt - firstAt : null,
    });
  }
  return {
    failed_event_count: failedEventCount,
    traces_with_error: output.length,
    traces_with_evidenced_recovery: output.filter((record) => record.recovery_evidenced).length,
    first_errors: output,
  };
}

function approvalOutcome(event: TrajectoryEvent): "allow" | "deny" | "unknown" {
  const raw = event.metadata.approval_decision;
  const value = typeof raw === "string" ? raw.toLowerCase() : "";
  if (["allow", "allowed", "approve", "approved", "accept", "accepted"].includes(value)) return "allow";
  if (["deny", "denied", "reject", "rejected", "abort", "cancel", "cancelled"].includes(value)) return "deny";
  if (event.status === "cancelled" || event.status === "error") return "deny";
  if (event.status === "ok") return "allow";
  return "unknown";
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function trainingYield(records: readonly EventRecord[], gateCounts: ResolvedInput["gateCounts"]): ResearchAnalyticsSummary["training_yield"] {
  const events = records.map((record) => record.event);
  const selected = events.filter((event) => event.review_disposition === "include");
  const allParts = events.flatMap((event) => event.content);
  const partsInSelectedEvents = selected.flatMap((event) => event.content);
  const selectedContent = partsInSelectedEvents.filter((part) => part.review_disposition === "include");
  const privacyReady = selectedContent.filter((part) => part.redaction_status === "passed" || part.redaction_status === "redacted");
  const assistantParts = selected.flatMap((event) => {
    if (event.actor !== "assistant" && event.actor !== "agent") return [];
    return event.content.filter((part) => part.review_disposition === "include"
      && (part.redaction_status === "passed" || part.redaction_status === "redacted"));
  });
  const lossCandidates = assistantParts.filter((part) => {
    if (part.type !== "reasoning") return ["text", "plan", "tool_call", "patch"].includes(part.type);
    return part.reasoning?.include_in_loss === true && part.reasoning.representation !== "opaque_reasoning_state";
  });
  return {
    candidate_content_part_count: allParts.length,
    selected_content_part_count: selectedContent.length,
    privacy_ready_content_part_count: privacyReady.length,
    assistant_loss_candidate_part_count: lossCandidates.length,
    reasoning_loss_candidate_part_count: lossCandidates.filter((part) => part.type === "reasoning").length,
    selected_event_yield_bp: basisPoints(selected.length, events.length),
    privacy_ready_content_yield_bp: basisPoints(privacyReady.length, allParts.length),
    exclusions: {
      event_review_excluded: events.length - selected.length,
      content_review_excluded: partsInSelectedEvents.filter((part) => part.review_disposition === "exclude").length,
      content_not_scanned: selectedContent.filter((part) => part.redaction_status === "not_scanned").length,
      content_quarantined: selectedContent.filter((part) => part.redaction_status === "quarantined").length,
      opaque_reasoning: selectedContent.filter((part) => part.type === "reasoning"
        && part.reasoning?.representation === "opaque_reasoning_state").length,
      reasoning_loss_disabled: selectedContent.filter((part) => part.type === "reasoning"
        && part.reasoning?.include_in_loss !== true).length,
    },
    training_gate_status: gateCounts,
    notice: "Structural yield is not a training authorization; target-scoped policy gates still apply.",
  };
}

function publicRef(namespace: string, value: string): string {
  return `${namespace}_${sha256(`trajpack.research/v1\u0000${namespace}\u0000${value}`).slice(0, 24)}`;
}

function providerAndModelCounts(records: readonly EventRecord[]): ResearchAnalyticsSummary["sources"] {
  const providers = Object.create(null) as Record<string, number>;
  const models = Object.create(null) as Record<string, number>;
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.event.trace_id)) continue;
    seen.add(record.event.trace_id);
    increment(providers, record.provider);
    increment(models, record.model ?? "unknown");
  }
  return { providers, models };
}

export function deriveResearchAnalytics(input: ResearchAnalyticsInput): ResearchAnalyticsSummary {
  const resolved = resolveInput(input);
  const records = resolved.records;
  const selected = selectedRecords(records);
  const events = selected.map((record) => record.event);
  const rounds = deriveRounds(records);
  const usage = {
    input_tokens: numericEvidence(rounds, "input_tokens"),
    output_tokens: numericEvidence(rounds, "output_tokens"),
    reasoning_tokens: numericEvidence(rounds, "reasoning_tokens"),
    cache_read_tokens: numericEvidence(rounds, "cache_read_tokens"),
    latency_ms: numericEvidence(rounds, "latency_ms"),
    cost_usd: numericEvidence(rounds, "cost_usd"),
  };
  const { pairs, orphanResults } = pairTools(records);
  const parallel = parallelMetrics(records);
  const decisions = events.filter((event) => event.event_type === "approval.decision").map(approvalOutcome);
  const reasoningEvents = events.filter((event) => event.event_type === "reasoning"
    || selectedParts(event).some((part) => part.type === "reasoning")).length;
  const actions = events.filter((event) => ACTION_EVENT_TYPES.has(event.event_type)).length;
  const traces = new Set(records.map((record) => record.event.trace_id));
  const sessions = new Set(selected.map((record) => canonicalJson([
    record.event.trace_id,
    record.event.source_session_id ?? record.event.trace_id,
  ])));
  const turns = new Set(selected.map((record) => canonicalJson([
    record.event.trace_id,
    record.event.source_session_id ?? record.event.trace_id,
    record.event.source_turn_id ?? "trace-fallback",
  ])));

  return {
    schema_version: RESEARCH_ANALYTICS_VERSION,
    input_kind: resolved.kind,
    privacy: {
      content_values_emitted: false,
      tool_payloads_emitted: false,
      trajectory_identifiers_emitted: false,
    },
    scope: {
      bundle_count: resolved.bundleCount,
      trace_count: traces.size,
      candidate_event_count: records.length,
      selected_event_count: selected.length,
      excluded_event_count: records.length - selected.length,
      session_count: sessions.size,
      turn_count: turns.size,
    },
    sources: providerAndModelCounts(records),
    workload: {
      llm_round_count: rounds.length,
      llm_rounds_with_usage: rounds.filter((round) => hasUsage(lastUsageEvent(round))).length,
      inference_event_count: events.filter((event) => event.event_type === "model.inference").length,
      grouping_evidence: {
        source_step_id: rounds.filter((round) => round.groupingEvidence === "source_step_id").length,
        inference_event: rounds.filter((round) => round.groupingEvidence === "inference_event").length,
      },
      usage: {
        ...usage,
        cache_read_to_input_bp: basisPoints(usage.cache_read_tokens.total, usage.input_tokens.total),
        reasoning_to_output_bp: basisPoints(usage.reasoning_tokens.total, usage.output_tokens.total),
        aggregation: "last-non-null-per-derived-round",
      },
    },
    tools: {
      call_count: pairs.length,
      result_count: events.filter((event) => event.event_type === "tool.result").length,
      paired_call_count: pairs.filter((pair) => pair.result !== null).length,
      unpaired_call_count: pairs.filter((pair) => pair.result === null).length,
      orphan_result_count: orphanResults,
      failed_call_count: pairs.filter((pair) => pair.call.status === "error"
        || pair.result?.status === "error" || pair.result?.status === "cancelled"
        || (pair.result?.tool?.exit_code !== null && pair.result?.tool?.exit_code !== undefined && pair.result.tool.exit_code !== 0)).length,
      ...parallel,
      latency: latencyEvidence(pairs.flatMap((pair) => pair.latencyMs === null ? [] : [pair.latencyMs])),
      latency_basis: "call.started_at-to-result.ended_at-or-started_at",
    },
    behavior: {
      reasoning_event_count: reasoningEvents,
      action_event_count: actions,
      reasoning_to_action_bp: basisPoints(reasoningEvents, actions),
      compaction_event_count: events.filter((event) => event.event_type === "compaction").length,
      failed_compaction_count: events.filter((event) => event.event_type === "compaction"
        && (event.status === "error" || event.status === "cancelled")).length,
      subagent_invoke_count: events.filter(isSubagentInvoke).length,
      handoff_count: events.filter((event) => event.event_type === "handoff").length,
      approval_request_count: events.filter((event) => event.event_type === "approval.request").length,
      approval_decision_count: decisions.length,
      approval_allow_count: decisions.filter((decision) => decision === "allow").length,
      approval_deny_count: decisions.filter((decision) => decision === "deny").length,
      approval_unknown_count: decisions.filter((decision) => decision === "unknown").length,
    },
    errors_and_recovery: firstErrors(records),
    training_yield: trainingYield(records, resolved.gateCounts),
  };
}

/** Build a synthetic usage-only event without retaining any source content. */
function lastUsageEvent(round: RoundGroup): TrajectoryEvent {
  return { ...round.events.at(-1)!, usage: lastUsage(round) };
}

function renderedLength(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  try {
    const rendered = canonicalJson(value);
    return typeof rendered === "string" ? rendered.length : 0;
  } catch {
    return 0;
  }
}

function contentLength(event: TrajectoryEvent, type?: ContentPart["type"]): number {
  return selectedParts(event)
    .filter((part) => type === undefined || part.type === type)
    .reduce((sum, part) => sum + (part.value?.length ?? 0), 0);
}

function safeToolName(name: string | null | undefined): string {
  if (!name) return "unknown";
  const normalized = name.trim().toLowerCase();
  return COMMON_TOOL_NAMES.get(normalized) ?? `custom_${sha256(`trajpack.tool-name/v1\u0000${name}`).slice(0, 12)}`;
}

function eventTiming(event: TrajectoryEvent, toolIndexes: ReadonlyMap<string, number>): TraceLabDerivedTimingEvent {
  const callId = event.tool?.call_id;
  const timing: TraceLabDerivedTimingEvent = {
    event_type: event.event_type,
    timestamp: event.started_at,
    source: `trajpack.canonical.${event.event_type}`,
  };
  const chars = contentLength(event);
  if (chars > 0) timing.content_chars = chars;
  if (callId) {
    timing.tool_call_id = publicRef("tool", `${event.trace_id}\u0000${callId}`);
    const index = toolIndexes.get(event.event_id);
    if (index !== undefined) timing.tool_index = index;
    if (event.event_type === "tool.call") timing.tool_name = safeToolName(event.tool?.name);
  }
  if (event.event_type === "tool.result") {
    timing.is_error = event.status === "error" || event.status === "cancelled";
    timing.result_chars = renderedLength(event.tool?.result);
  }
  return timing;
}

export function toTraceLabWorkloadRows(input: ResearchAnalyticsInput): TraceLabCompatibleWorkloadRow[] {
  const resolved = resolveInput(input);
  const rounds = deriveRounds(resolved.records);
  const { pairs } = pairTools(resolved.records);
  const pairByCall = new Map(pairs.map((pair) => [pair.call.event_id, pair]));
  const sessionRoundIndexes = new Map<string, number>();
  return rounds.map((round) => {
    const sessionSource = round.sessionId ?? round.traceId;
    const sessionId = publicRef("session", `${round.traceId}\u0000${sessionSource}`);
    const roundIndex = sessionRoundIndexes.get(sessionId) ?? 0;
    sessionRoundIndexes.set(sessionId, roundIndex + 1);
    const calls = round.events.filter((event) => event.event_type === "tool.call");
    const toolIndexes = new Map(calls.map((event, index) => [event.event_id, index]));
    const tools = calls.map((call, toolIndex): TraceLabDerivedTool => {
      const pair = pairByCall.get(call.event_id);
      const result = pair?.result ?? null;
      const callId = call.tool?.call_id ?? call.event_id;
      return {
        tool_index: toolIndex,
        tool_name: safeToolName(call.tool?.name),
        tool_call_id: publicRef("tool", `${call.trace_id}\u0000${callId}`),
        emitted_at: call.started_at,
        result_at: result?.ended_at ?? result?.started_at ?? null,
        tool_wall_latency_ms: pair?.latencyMs ?? null,
        tool_internal_latency_ms: null,
        is_error: result === null ? null : result.status === "error" || result.status === "cancelled"
          || (result.tool?.exit_code !== null && result.tool?.exit_code !== undefined && result.tool.exit_code !== 0),
        input_chars: renderedLength(call.tool?.arguments),
        result_chars: renderedLength(result?.tool?.result),
      };
    });
    const usage = lastUsage(round);
    const inputTokens = usage.input_tokens;
    const prefixTokens = usage.cache_read_tokens;
    const newlyAppendTokens = inputTokens !== null && prefixTokens !== null
      ? Math.max(0, inputTokens - prefixTokens)
      : null;
    const roundIdentity = canonicalJson([round.key, ...round.events.map((event) => event.event_id)]);
    return {
      provider: round.workloadProvider,
      project: "trajpack-derived",
      session_id: sessionId,
      session_file: "trajpack-derived",
      round_index: roundIndex,
      round_id: publicRef("round", roundIdentity),
      model: round.model,
      input_tokens_total: inputTokens,
      prefix_tokens: prefixTokens,
      newly_append_tokens: newlyAppendTokens,
      claude_uncached_input_tokens: null,
      claude_cache_creation_input_tokens: null,
      claude_cache_read_input_tokens: prefixTokens,
      output_tokens: usage.output_tokens,
      reasoning_output_tokens: usage.reasoning_tokens,
      timing_events: round.events.map((event) => eventTiming(event, toolIndexes)),
      tools,
      current_input_event_count: null,
      current_user_message_count: null,
      current_tool_result_count: null,
      current_user_message_chars: null,
      current_tool_result_chars: null,
      current_input_chars: null,
      first_input_event_type: null,
      home: null,
      user: null,
      store: null,
      trace_key: publicRef("trace", round.traceId),
      _trajpack: {
        mapping_version: TRACELAB_WORKLOAD_MAPPING_VERSION,
        mapping_kind: "lossy_derived",
        canonical_source_of_truth: false,
        content_values_emitted: false,
        tool_payloads_emitted: false,
        round_grouping_evidence: round.groupingEvidence,
        unavailable_fields: [
          "provider-native prompt snapshot",
          "provider-specific cache creation tokens",
          "home/user/store provenance",
          "tool internal latency",
        ],
      },
    };
  });
}
