import type { TraceBundle } from "@trajpack/schema";
import { rawIntegrityReasons } from "./integrity.js";

export interface QualityIssue {
  code: string;
  severity: "error" | "warning";
  eventId?: string;
  detail: string;
}

/** Evidence counters only: no metric below asserts that the whole trace succeeded. */
export interface QualityMetrics {
  event_count: number;
  tool_call_count: number;
  tool_result_count: number;
  failed_event_count: number;
  verified_action_ratio: number;
  reasoning_part_count: number;
  sequence_gap_count: number;
  duplicate_sequence_count: number;
  duplicate_tool_call_id_count: number;
  duplicate_tool_result_count: number;
  out_of_order_tool_result_count: number;
  ordered_tool_pair_count: number;
  parallel_tool_call_group_count: number;
  parallel_tool_call_count: number;
  retry_event_count: number;
  compaction_event_count: number;
  unpaired_compaction_boundary_count: number;
  failed_compaction_count: number;
  partial_event_count: number;
  cancelled_event_count: number;
  subagent_invoke_count: number;
  handoff_count: number;
  unpaired_subagent_count: number;
  missing_parent_span_count: number;
  missing_link_span_count: number;
  missing_subagent_edge_count: number;
  first_error_sequence: number | null;
  recovery_after_error_count: number;
  repo_commit_evidence_count: number;
  patch_evidence_count: number;
  test_evidence_count: number;
  verifier_evidence_count: number;
  evaluation_event_count: number;
  exact_duplicate_text_count: number;
  near_duplicate_text_count: number;
  near_duplicate_scan_truncated: number;
  cross_split_duplicate_count: number;
  repo_split_contamination_signal_count: number;
  time_split_contamination_signal_count: number;
  environment_observation_count: number;
  environment_action_count: number;
  environment_result_count: number;
  verification_evidence_count: number;
  environment_grounded_turn_count: number;
  egs_complete_turn_count: number;
  egs_completeness_ratio: number;
  tor_complete_turn_count: number;
  tor_complete_action_count: number;
  tor_completeness_ratio: number;
  raw_record_count: number;
  raw_sequence_gap_count: number;
  raw_duplicate_sequence_count: number;
  raw_integrity_error_count: number;
}

export interface QualityReport {
  passed: boolean;
  issues: QualityIssue[];
  metrics: QualityMetrics;
}

type Event = TraceBundle["events"][number];

interface TextRecord {
  event: Event;
  text: string;
  normalized: string;
  shingles: Set<string>;
  split: string | null;
  repo: string | null;
}

const TRAIN_SPLITS = new Set(["train", "training"]);
const EVALUATION_SPLITS = new Set(["dev", "eval", "evaluation", "test", "val", "validation"]);
const MAX_NEAR_DUPLICATE_RECORDS = 1_000;

function pushIssue(
  issues: QualityIssue[],
  code: string,
  severity: QualityIssue["severity"],
  detail: string,
  eventId?: string,
): void {
  issues.push({ code, severity, detail, ...(eventId === undefined ? {} : { eventId }) });
}

function sorted(events: Event[]): Event[] {
  return [...events].sort((left, right) => {
    const sequenceOrder = left.sequence - right.sequence;
    if (sequenceOrder !== 0) return sequenceOrder;
    return left.event_id < right.event_id ? -1 : left.event_id > right.event_id ? 1 : 0;
  });
}

function primitiveStrings(value: unknown, depth = 0, seen = new Set<object>()): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (value === null || value === undefined || depth >= 5 || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((item) => primitiveStrings(item, depth + 1, seen));
  return Object.values(value).flatMap((item) => primitiveStrings(item, depth + 1, seen));
}

function keyedValues(
  value: unknown,
  acceptedKeys: ReadonlySet<string>,
  depth = 0,
  seen = new Set<object>(),
): unknown[] {
  if (value === null || value === undefined || typeof value !== "object" || depth >= 5 || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((item) => keyedValues(item, acceptedKeys, depth + 1, seen));
  const values: unknown[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (acceptedKeys.has(key.toLowerCase())) values.push(item);
    values.push(...keyedValues(item, acceptedKeys, depth + 1, seen));
  }
  return values;
}

function firstMetadataString(event: Event, keys: readonly string[]): string | null {
  const values = keyedValues(event.metadata, new Set(keys.map((key) => key.toLowerCase())));
  for (const value of values) {
    if ((typeof value === "string" || typeof value === "number") && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return null;
}

function eventSplit(event: Event): string | null {
  return firstMetadataString(event, ["split", "dataset_split", "data_split"])?.toLowerCase() ?? null;
}

function eventRepo(event: Event, bundle: TraceBundle): string | null {
  return firstMetadataString(event, [
    "repo", "repository", "repo_id", "repository_id", "repo_commit", "git_commit", "commit_sha",
  ]) ?? bundle.manifest.environment.repo_commit ?? bundle.manifest.environment.cwd_hmac;
}

function explicitRetry(event: Event): boolean {
  const booleanValues = keyedValues(event.metadata, new Set(["retry", "is_retry", "retried"]));
  if (booleanValues.some((value) => value === true || value === "true")) return true;
  const counts = keyedValues(event.metadata, new Set(["retry_count", "retry_index", "attempt"]));
  if (counts.some((value) => typeof value === "number" && value > 1)) return true;
  if (keyedValues(event.metadata, new Set(["retry_of", "retry_reason"])).some((value) => value !== null && value !== "")) return true;
  const lifecycle = firstMetadataString(event, ["lifecycle", "durable_event_type", "source_type"]);
  return lifecycle !== null && /(?:^|[./_-])retry(?:$|[./_-])/iu.test(lifecycle);
}

function compactionPhase(event: Event): "start" | "end" | null {
  const phase = firstMetadataString(event, ["phase", "lifecycle", "hook_event_name"])?.toLowerCase();
  if (phase === undefined || phase === null) return null;
  if (["start", "before", "precompact", "pre_compact"].includes(phase)) return "start";
  if (["end", "after", "postcompact", "post_compact", "complete", "completed"].includes(phase)) return "end";
  return null;
}

function subagentCorrelationId(event: Event): string | null {
  return event.source_step_id ?? firstMetadataString(event, ["agent_id", "subagent_id", "child_agent_id"]);
}

function isExplicitSubagentInvoke(event: Event): boolean {
  if (event.event_type !== "agent.invoke") return false;
  if (subagentCorrelationId(event) !== null || firstMetadataString(event, ["agent_type", "subagent_type"]) !== null) return true;
  const lifecycle = firstMetadataString(event, ["lifecycle", "hook_event_name", "durable_event_type"]);
  return lifecycle !== null && /subagent/iu.test(lifecycle);
}

function eventsStructurallyLinked(left: Event, right: Event): boolean {
  if (left.span_id === right.span_id || left.parent_span_id === right.span_id || right.parent_span_id === left.span_id) return true;
  return left.links.some((link) => link.trace_id === right.trace_id && link.span_id === right.span_id)
    || right.links.some((link) => link.trace_id === left.trace_id && link.span_id === left.span_id);
}

function normalizedText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function shingles(text: string): Set<string> {
  const words = text.split(" ").filter(Boolean);
  if (words.length >= 5) {
    return new Set(words.slice(0, -2).map((word, index) => `${word}\u0000${words[index + 1]}\u0000${words[index + 2]}`));
  }
  if (text.length < 5) return new Set([text]);
  const output = new Set<string>();
  for (let index = 0; index <= text.length - 5; index += 1) output.add(text.slice(index, index + 5));
  return output;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function isNearDuplicate(left: TextRecord, right: TextRecord): boolean {
  if (left.text === right.text || left.normalized === right.normalized || left.normalized.length < 32 || right.normalized.length < 32) {
    return left.text !== right.text && left.normalized === right.normalized && left.normalized.length >= 32;
  }
  const lengthRatio = Math.min(left.normalized.length, right.normalized.length) / Math.max(left.normalized.length, right.normalized.length);
  return lengthRatio >= 0.8 && jaccard(left.shingles, right.shingles) >= 0.82;
}

const TEST_COMMAND_PATTERN = /(?:^|[\s;&|])(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test\b|pytest\b|vitest\b|jest\b|cargo\s+test\b|go\s+test\b|dotnet\s+test\b|mvn(?:w)?\s+test\b|gradle(?:w)?\s+test\b)/iu;

function isTestCall(event: Event): boolean {
  if (event.event_type !== "tool.call") return false;
  const evidence = [event.tool?.name ?? "", ...primitiveStrings(event.tool?.arguments)].join(" ");
  return TEST_COMMAND_PATTERN.test(evidence);
}

function hasExplicitTestMetadata(event: Event): boolean {
  return keyedValues(event.metadata, new Set([
    "test_result", "test_results", "test_status", "test_exit_code", "tests_passed", "tests_failed",
  ])).some((value) => value !== null && value !== undefined && value !== "");
}

function verifierIdentity(event: Event): string | null {
  const verifierValues = keyedValues(event.metadata, new Set(["verifier", "grader"]));
  for (const value of verifierValues) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      if (typeof record.name === "string" && typeof record.version === "string" && record.name !== "" && record.version !== "") {
        return `${record.name}@${record.version}`;
      }
    }
  }
  const name = firstMetadataString(event, ["verifier_name", "grader_name"]);
  const version = firstMetadataString(event, ["verifier_version", "grader_version"]);
  return name !== null && version !== null ? `${name}@${version}` : null;
}

function isEnvironmentObservation(event: Event): boolean {
  if (["retrieval", "artifact.read", "tool.result"].includes(event.event_type)) return true;
  return event.actor === "environment" && !["evaluation", "error"].includes(event.event_type);
}

function isEnvironmentAction(event: Event): boolean {
  return ["tool.call", "artifact.write", "artifact.patch"].includes(event.event_type);
}

function isEnvironmentResult(event: Event): boolean {
  return event.event_type === "tool.result" || event.event_type === "artifact.read";
}

function turnKey(event: Event): string {
  return `${event.source_session_id ?? "trace"}\u0000${event.source_turn_id ?? "session"}`;
}

function splitSetsByKey(events: Event[], key: (event: Event) => string | null): number {
  const groups = new Map<string, Set<string>>();
  for (const event of events) {
    const split = eventSplit(event);
    const value = key(event);
    if (split === null || value === null) continue;
    const splits = groups.get(value) ?? new Set<string>();
    splits.add(split);
    groups.set(value, splits);
  }
  return [...groups.values()].filter((splits) => splits.size > 1).length;
}

export function inspectQuality(bundle: TraceBundle): QualityReport {
  const issues: QualityIssue[] = [];
  const rawSequenceCounts = new Map<number, number>();
  for (const envelope of bundle.raw) rawSequenceCounts.set(envelope.sequence, (rawSequenceCounts.get(envelope.sequence) ?? 0) + 1);
  const rawUniqueSequences = [...rawSequenceCounts.keys()].sort((left, right) => left - right);
  const rawSequenceGapCount = rawUniqueSequences.reduce((total, sequence, index) => total + Math.max(0, sequence - index), 0);
  const rawDuplicateSequenceCount = [...rawSequenceCounts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
  const rawReasons = rawIntegrityReasons(bundle);
  for (const reason of rawReasons) pushIssue(issues, reason, "error", `Raw vault integrity check failed: ${reason}`);
  const selectedEvents = bundle.events.filter((event) => event.review_disposition === "include");
  const orderedEvents = sorted(selectedEvents);
  if (selectedEvents.length === 0) pushIssue(issues, "EMPTY_TRACE", "error", "Trace contains no normalized events");

  const eventIds = new Set<string>();
  const spanIds = new Set(selectedEvents.map((event) => event.span_id));
  const sequenceCounts = new Map<number, number>();
  const calls = new Map<string, Event[]>();
  const results = new Map<string, Event[]>();
  let previousSequence = -1;
  let reasoningParts = 0;
  let missingParentSpanCount = 0;
  let missingLinkSpanCount = 0;

  for (const event of selectedEvents) {
    if (event.trace_id !== bundle.manifest.trace_id) pushIssue(issues, "TRACE_ID_MISMATCH", "error", "Event belongs to another trace", event.event_id);
    if (eventIds.has(event.event_id)) pushIssue(issues, "DUPLICATE_EVENT_ID", "error", "Event id is not unique", event.event_id);
    eventIds.add(event.event_id);
    sequenceCounts.set(event.sequence, (sequenceCounts.get(event.sequence) ?? 0) + 1);
    if (event.sequence <= previousSequence) pushIssue(issues, "NON_MONOTONIC_SEQUENCE", "error", "Sequence must increase strictly in stored event order", event.event_id);
    previousSequence = event.sequence;
    if (event.parent_span_id && !spanIds.has(event.parent_span_id)) {
      missingParentSpanCount += 1;
      pushIssue(issues, "MISSING_PARENT_SPAN", "warning", "Parent span is outside this trace", event.event_id);
    }
    for (const link of event.links) {
      if (link.trace_id === bundle.manifest.trace_id && !spanIds.has(link.span_id)) {
        missingLinkSpanCount += 1;
        pushIssue(issues, "MISSING_LINKED_SPAN", "warning", "A local span link has no target event", event.event_id);
      }
    }
    if (event.event_type === "tool.call") {
      if (event.tool?.call_id) {
        const occurrences = calls.get(event.tool.call_id) ?? [];
        occurrences.push(event);
        calls.set(event.tool.call_id, occurrences);
      } else pushIssue(issues, "TOOL_CALL_ID_MISSING", "error", "Tool call cannot be paired without a call id", event.event_id);
    }
    if (event.event_type === "tool.result") {
      if (event.tool?.call_id) {
        const occurrences = results.get(event.tool.call_id) ?? [];
        occurrences.push(event);
        results.set(event.tool.call_id, occurrences);
      } else pushIssue(issues, "TOOL_RESULT_CALL_ID_MISSING", "error", "Tool result cannot be paired without a call id", event.event_id);
    }
    reasoningParts += event.content.filter((part) => part.review_disposition === "include" && part.type === "reasoning").length;
  }

  const uniqueSequences = [...sequenceCounts.keys()].sort((left, right) => left - right);
  let sequenceGapCount = 0;
  for (let index = 1; index < uniqueSequences.length; index += 1) sequenceGapCount += Math.max(0, uniqueSequences[index]! - uniqueSequences[index - 1]! - 1);
  if (sequenceGapCount > 0) pushIssue(issues, "SEQUENCE_GAP", "warning", `${sequenceGapCount} sequence value(s) are absent between captured events`);
  const duplicateSequenceCount = [...sequenceCounts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
  for (const [sequence, count] of sequenceCounts) if (count > 1) pushIssue(issues, "DUPLICATE_SEQUENCE", "error", `Sequence ${sequence} is used by ${count} events`);

  let duplicateToolCallIdCount = 0;
  let duplicateToolResultCount = 0;
  for (const [callId, occurrences] of calls) {
    if (occurrences.length > 1) {
      duplicateToolCallIdCount += occurrences.length - 1;
      pushIssue(issues, "DUPLICATE_TOOL_CALL_ID", "error", `Tool call id ${callId} is repeated`, occurrences[1]!.event_id);
    }
    if (!results.has(callId)) pushIssue(issues, "DANGLING_TOOL_CALL", "error", `No result for tool call ${callId}`, occurrences[0]!.event_id);
  }
  for (const [callId, occurrences] of results) {
    if (occurrences.length > 1) {
      duplicateToolResultCount += occurrences.length - 1;
      pushIssue(issues, "DUPLICATE_TOOL_RESULT", "error", `Tool call ${callId} has repeated results`, occurrences[1]!.event_id);
    }
    if (!calls.has(callId)) pushIssue(issues, "ORPHAN_TOOL_RESULT", "error", `No call for tool result ${callId}`, occurrences[0]!.event_id);
  }

  let outOfOrderToolResultCount = 0;
  const orderedToolPairs = new Map<string, { call: Event; result: Event }>();
  for (const [callId, callEvents] of calls) {
    const resultEvents = results.get(callId) ?? [];
    for (const result of resultEvents) {
      if (!callEvents.some((call) => call.sequence < result.sequence)) {
        outOfOrderToolResultCount += 1;
        pushIssue(issues, "TOOL_RESULT_BEFORE_CALL", "error", `Result for ${callId} does not follow its call`, result.event_id);
      }
    }
    const firstCall = sorted(callEvents)[0];
    if (firstCall === undefined) continue;
    const firstOrderedResult = sorted(resultEvents).find((result) => result.sequence > firstCall.sequence);
    if (firstOrderedResult !== undefined) orderedToolPairs.set(callId, { call: firstCall, result: firstOrderedResult });
  }

  const activeCalls = new Set<string>();
  const seenCalls = new Set<string>();
  let inParallelGroup = false;
  let parallelToolCallGroupCount = 0;
  let parallelToolCallCount = 0;
  for (const event of orderedEvents) {
    const callId = event.tool?.call_id;
    if (event.event_type === "tool.call" && callId && !seenCalls.has(callId)) {
      seenCalls.add(callId);
      if (activeCalls.size > 0) {
        parallelToolCallCount += 1;
        if (!inParallelGroup) {
          parallelToolCallGroupCount += 1;
          inParallelGroup = true;
        }
      }
      activeCalls.add(callId);
    } else if (event.event_type === "tool.result" && callId) {
      activeCalls.delete(callId);
      if (activeCalls.size === 0) inParallelGroup = false;
    }
  }

  const retryEvents = selectedEvents.filter(explicitRetry);
  if (retryEvents.length > 0) pushIssue(issues, "RETRY_ACTIVITY_OBSERVED", "warning", `${retryEvents.length} event(s) carry explicit retry evidence`, retryEvents[0]!.event_id);
  const partialEvents = selectedEvents.filter((event) => event.status === "partial");
  if (partialEvents.length > 0) pushIssue(issues, "PARTIAL_EVENTS_PRESENT", "warning", `${partialEvents.length} partial event(s) require downstream interpretation`, partialEvents[0]!.event_id);
  const cancelledEvents = selectedEvents.filter((event) => event.status === "cancelled");
  if (cancelledEvents.length > 0) pushIssue(issues, "CANCELLED_EVENTS_PRESENT", "warning", `${cancelledEvents.length} cancelled event(s) are preserved`, cancelledEvents[0]!.event_id);

  const compactionEvents = orderedEvents.filter((event) => event.event_type === "compaction");
  const openCompactions = new Map<string, number>();
  let unpairedCompactionBoundaryCount = 0;
  for (const event of compactionEvents) {
    const phase = compactionPhase(event);
    if (phase === null) continue;
    const key = turnKey(event);
    if (phase === "start") openCompactions.set(key, (openCompactions.get(key) ?? 0) + 1);
    else if ((openCompactions.get(key) ?? 0) > 0) openCompactions.set(key, (openCompactions.get(key) ?? 0) - 1);
    else unpairedCompactionBoundaryCount += 1;
  }
  unpairedCompactionBoundaryCount += [...openCompactions.values()].reduce((sum, count) => sum + count, 0);
  if (unpairedCompactionBoundaryCount > 0) pushIssue(issues, "COMPACTION_BOUNDARY_MISMATCH", "warning", `${unpairedCompactionBoundaryCount} compaction boundary/boundaries are unpaired`);
  const failedCompactions = compactionEvents.filter((event) => event.status === "error" || event.status === "cancelled");
  if (failedCompactions.length > 0) pushIssue(issues, "COMPACTION_FAILED", "warning", `${failedCompactions.length} compaction event(s) failed or were cancelled`, failedCompactions[0]!.event_id);

  const invokes = orderedEvents.filter(isExplicitSubagentInvoke);
  const handoffs = orderedEvents.filter((event) => event.event_type === "handoff");
  const invokesById = new Map<string, Event[]>();
  const handoffsById = new Map<string, Event[]>();
  let unpairedSubagentCount = 0;
  let missingSubagentEdgeCount = 0;
  for (const event of [...invokes, ...handoffs]) {
    const id = subagentCorrelationId(event);
    if (id === null) {
      unpairedSubagentCount += 1;
      pushIssue(issues, "SUBAGENT_CORRELATION_ID_MISSING", "warning", `${event.event_type} has no child agent/step id`, event.event_id);
      continue;
    }
    const target = event.event_type === "agent.invoke" ? invokesById : handoffsById;
    const occurrences = target.get(id) ?? [];
    occurrences.push(event);
    target.set(id, occurrences);
  }
  for (const id of new Set([...invokesById.keys(), ...handoffsById.keys()])) {
    const invoke = sorted(invokesById.get(id) ?? [])[0];
    const handoff = sorted(handoffsById.get(id) ?? [])[0];
    if (invoke === undefined || handoff === undefined) {
      unpairedSubagentCount += 1;
      pushIssue(issues, invoke === undefined ? "ORPHAN_HANDOFF" : "SUBAGENT_HANDOFF_MISSING", "warning", `Subagent ${id} lacks a complete invoke/handoff pair`, (invoke ?? handoff)?.event_id);
      continue;
    }
    if (handoff.sequence <= invoke.sequence) pushIssue(issues, "HANDOFF_BEFORE_INVOKE", "warning", `Subagent ${id} hands off before it is invoked`, handoff.event_id);
    if (!eventsStructurallyLinked(invoke, handoff)) {
      missingSubagentEdgeCount += 1;
      pushIssue(issues, "SUBAGENT_TOPOLOGY_EDGE_MISSING", "warning", `Subagent ${id} is correlated but has no parent/link edge`, handoff.event_id);
    }
  }

  const errorEvents = orderedEvents.filter((event) => event.status === "error" || event.event_type === "error");
  const firstError = errorEvents[0];
  let recoveryAfterErrorCount = 0;
  if (firstError !== undefined) {
    recoveryAfterErrorCount = orderedEvents.filter((event) => {
      if (event.sequence <= firstError.sequence || event.status !== "ok") return false;
      if (event.event_type === "evaluation") return true;
      if (event.event_type === "tool.result" && event.tool?.call_id) return orderedToolPairs.get(event.tool.call_id)?.result.event_id === event.event_id;
      return keyedValues(event.metadata, new Set(["recovered", "recovery", "retry_success"])).some((value) => value === true || value === "true");
    }).length;
    if (recoveryAfterErrorCount === 0) pushIssue(issues, "UNRECOVERED_ERROR", "warning", "No later successful result/evaluation explicitly evidences recovery", firstError.event_id);
  }

  const repoCommitEvidence = new Set<string>();
  if (bundle.manifest.environment.repo_commit) repoCommitEvidence.add(bundle.manifest.environment.repo_commit);
  for (const event of selectedEvents) {
    for (const value of keyedValues(event.metadata, new Set(["repo_commit", "git_commit", "commit_sha"]))) {
      if (typeof value === "string" && value.trim() !== "") repoCommitEvidence.add(value.trim());
    }
  }
  const patchEvidenceEvents = selectedEvents.filter((event) => event.event_type === "artifact.patch"
    || event.content.some((part) => part.review_disposition === "include" && part.type === "patch")
    || keyedValues(event.metadata, new Set(["patch", "diff", "patch_sha256"])).some((value) => value !== null && value !== undefined && value !== ""));
  const testCallIds = new Set(selectedEvents.filter(isTestCall).flatMap((event) => event.tool?.call_id ? [event.tool.call_id] : []));
  const testEvidenceEvents = selectedEvents.filter((event) => hasExplicitTestMetadata(event)
    || (event.event_type === "tool.result" && event.tool?.call_id !== null && event.tool?.call_id !== undefined
      && testCallIds.has(event.tool.call_id)
      && (event.tool.exit_code !== null || event.tool.result !== null || event.content.some((part) => part.review_disposition === "include"))));
  const verifierEvidenceEvents = selectedEvents.filter((event) => verifierIdentity(event) !== null);
  const verifierIdentities = new Set(verifierEvidenceEvents.flatMap((event) => {
    const identity = verifierIdentity(event);
    return identity === null ? [] : [identity];
  }));
  const evaluationEvents = selectedEvents.filter((event) => event.event_type === "evaluation");
  if (patchEvidenceEvents.length > 0 && repoCommitEvidence.size === 0) pushIssue(issues, "REPO_COMMIT_EVIDENCE_MISSING", "warning", "Patch evidence exists without a repository commit identifier", patchEvidenceEvents[0]!.event_id);
  if (patchEvidenceEvents.length > 0 && testEvidenceEvents.length === 0) pushIssue(issues, "TEST_EVIDENCE_MISSING", "warning", "Patch evidence exists without explicit test-result evidence", patchEvidenceEvents[0]!.event_id);
  if (evaluationEvents.length > 0 && verifierIdentities.size === 0) pushIssue(issues, "VERIFIER_VERSION_EVIDENCE_MISSING", "warning", "Evaluation events do not identify a versioned verifier/grader", evaluationEvents[0]!.event_id);

  const textRecords: TextRecord[] = [];
  for (const event of selectedEvents) {
    for (const part of event.content) {
      if (part.review_disposition !== "include" || part.value === null || part.value.trim() === "") continue;
      const normalized = normalizedText(part.value);
      textRecords.push({ event, text: part.value, normalized, shingles: shingles(normalized), split: eventSplit(event), repo: eventRepo(event, bundle) });
    }
  }
  const exactSeen = new Map<string, TextRecord>();
  let exactDuplicateTextCount = 0;
  let crossSplitDuplicateCount = 0;
  let firstExactDuplicateEvent: string | undefined;
  for (const record of textRecords) {
    const previous = exactSeen.get(record.text);
    if (previous === undefined) exactSeen.set(record.text, record);
    else {
      exactDuplicateTextCount += 1;
      firstExactDuplicateEvent ??= record.event.event_id;
      if (previous.split !== null && record.split !== null && previous.split !== record.split) crossSplitDuplicateCount += 1;
    }
  }
  if (exactDuplicateTextCount > 0) pushIssue(issues, "EXACT_DUPLICATE_TEXT", "warning", `${exactDuplicateTextCount} repeated text payload(s) were detected`, firstExactDuplicateEvent);

  const nearScanRecords = textRecords.slice(0, MAX_NEAR_DUPLICATE_RECORDS);
  const nearDuplicateScanTruncated = textRecords.length > nearScanRecords.length ? 1 : 0;
  let nearDuplicateTextCount = 0;
  let firstNearDuplicateEvent: string | undefined;
  for (let leftIndex = 0; leftIndex < nearScanRecords.length; leftIndex += 1) {
    const left = nearScanRecords[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < nearScanRecords.length; rightIndex += 1) {
      const right = nearScanRecords[rightIndex]!;
      if (!isNearDuplicate(left, right)) continue;
      nearDuplicateTextCount += 1;
      firstNearDuplicateEvent ??= right.event.event_id;
      if (left.split !== null && right.split !== null && left.split !== right.split) crossSplitDuplicateCount += 1;
    }
  }
  if (nearDuplicateTextCount > 0) pushIssue(issues, "NEAR_DUPLICATE_TEXT", "warning", `${nearDuplicateTextCount} near-duplicate text pair(s) were detected`, firstNearDuplicateEvent);
  if (nearDuplicateScanTruncated === 1) pushIssue(issues, "NEAR_DUPLICATE_SCAN_TRUNCATED", "warning", `Near-duplicate comparison is limited to ${MAX_NEAR_DUPLICATE_RECORDS} included text parts`);
  if (crossSplitDuplicateCount > 0) pushIssue(issues, "CROSS_SPLIT_DUPLICATE_TEXT", "warning", `${crossSplitDuplicateCount} duplicate/near-duplicate pair(s) cross explicit split labels`);

  const repoSplitContaminationSignalCount = splitSetsByKey(selectedEvents, (event) => eventRepo(event, bundle));
  if (repoSplitContaminationSignalCount > 0) pushIssue(issues, "REPO_SPLIT_CONTAMINATION_SIGNAL", "warning", `${repoSplitContaminationSignalCount} repository identity/identities occur in multiple explicit splits`);
  const sessionSplitSignals = splitSetsByKey(selectedEvents, (event) => event.source_turn_id ?? event.source_session_id);
  const trainTimes = selectedEvents.filter((event) => eventSplit(event) !== null && TRAIN_SPLITS.has(eventSplit(event)!)).map((event) => Date.parse(event.started_at));
  const evaluationTimes = selectedEvents.filter((event) => eventSplit(event) !== null && EVALUATION_SPLITS.has(eventSplit(event)!)).map((event) => Date.parse(event.started_at));
  const chronologySignal = trainTimes.length > 0 && evaluationTimes.length > 0 && Math.max(...trainTimes) > Math.min(...evaluationTimes) ? 1 : 0;
  const timeSplitContaminationSignalCount = sessionSplitSignals + chronologySignal;
  if (timeSplitContaminationSignalCount > 0) pushIssue(issues, "TIME_SPLIT_CONTAMINATION_SIGNAL", "warning", `${timeSplitContaminationSignalCount} session/chronology split contamination signal(s) were detected`);

  const verificationEventIds = new Set([
    ...evaluationEvents.map((event) => event.event_id),
    ...testEvidenceEvents.map((event) => event.event_id),
    ...verifierEvidenceEvents.map((event) => event.event_id),
  ]);
  const turnGroups = new Map<string, Event[]>();
  for (const event of orderedEvents) {
    const key = turnKey(event);
    const events = turnGroups.get(key) ?? [];
    events.push(event);
    turnGroups.set(key, events);
  }
  const actionTurns = [...turnGroups.values()].filter((events) => events.some(isEnvironmentAction));
  let environmentGroundedTurnCount = 0;
  let egsCompleteTurnCount = 0;
  let egsPhaseTotal = 0;
  for (const events of actionTurns) {
    const orderedTurn = sorted(events);
    const firstAction = orderedTurn.filter(isEnvironmentAction)[0]!;
    const observation = orderedTurn.find((event) => isEnvironmentObservation(event) && event.sequence < firstAction.sequence);
    const result = orderedTurn.find((event) => isEnvironmentResult(event) && event.sequence > firstAction.sequence);
    const verification = result === undefined ? undefined : orderedTurn.find((event) => verificationEventIds.has(event.event_id) && event.sequence >= result.sequence);
    const phaseCount = 1 + (observation === undefined ? 0 : 1) + (result === undefined ? 0 : 1) + (verification === undefined ? 0 : 1);
    egsPhaseTotal += phaseCount;
    if (observation !== undefined && result !== undefined) environmentGroundedTurnCount += 1;
    if (phaseCount === 4) egsCompleteTurnCount += 1;
    if (observation === undefined) pushIssue(issues, "ENVIRONMENT_OBSERVATION_MISSING", "warning", "Action-bearing turn lacks a preceding environment observation", firstAction.event_id);
    if (result === undefined) pushIssue(issues, "ENVIRONMENT_RESULT_MISSING", "warning", "Action-bearing turn lacks a later environment result", firstAction.event_id);
    else if (verification === undefined) pushIssue(issues, "VERIFICATION_EVIDENCE_MISSING", "warning", "Environment result lacks later test/evaluation/verifier evidence", result.event_id);
  }
  const egsCompletenessRatio = actionTurns.length === 0 ? 1 : egsPhaseTotal / (actionTurns.length * 4);

  let torCompleteActionCount = 0;
  const torCompleteTurns = new Set<string>();
  for (const { call, result } of orderedToolPairs.values()) {
    const callTurn = turnKey(call);
    if (turnKey(result) !== callTurn) continue;
    const verification = orderedEvents.find((event) => turnKey(event) === callTurn && verificationEventIds.has(event.event_id) && event.sequence >= result.sequence);
    if (verification !== undefined) {
      torCompleteActionCount += 1;
      torCompleteTurns.add(callTurn);
    }
  }

  const actionCount = calls.size;
  const pairedActions = [...calls.keys()].filter((callId) => results.has(callId)).length;
  return {
    passed: !issues.some((issue) => issue.severity === "error"),
    issues,
    metrics: {
      event_count: selectedEvents.length,
      tool_call_count: actionCount,
      tool_result_count: results.size,
      failed_event_count: selectedEvents.filter((event) => event.status === "error").length,
      verified_action_ratio: actionCount === 0 ? 1 : pairedActions / actionCount,
      reasoning_part_count: reasoningParts,
      sequence_gap_count: sequenceGapCount,
      duplicate_sequence_count: duplicateSequenceCount,
      duplicate_tool_call_id_count: duplicateToolCallIdCount,
      duplicate_tool_result_count: duplicateToolResultCount,
      out_of_order_tool_result_count: outOfOrderToolResultCount,
      ordered_tool_pair_count: orderedToolPairs.size,
      parallel_tool_call_group_count: parallelToolCallGroupCount,
      parallel_tool_call_count: parallelToolCallCount,
      retry_event_count: retryEvents.length,
      compaction_event_count: compactionEvents.length,
      unpaired_compaction_boundary_count: unpairedCompactionBoundaryCount,
      failed_compaction_count: failedCompactions.length,
      partial_event_count: partialEvents.length,
      cancelled_event_count: cancelledEvents.length,
      subagent_invoke_count: invokes.length,
      handoff_count: handoffs.length,
      unpaired_subagent_count: unpairedSubagentCount,
      missing_parent_span_count: missingParentSpanCount,
      missing_link_span_count: missingLinkSpanCount,
      missing_subagent_edge_count: missingSubagentEdgeCount,
      first_error_sequence: firstError?.sequence ?? null,
      recovery_after_error_count: recoveryAfterErrorCount,
      repo_commit_evidence_count: repoCommitEvidence.size,
      patch_evidence_count: patchEvidenceEvents.length,
      test_evidence_count: testEvidenceEvents.length,
      verifier_evidence_count: verifierIdentities.size,
      evaluation_event_count: evaluationEvents.length,
      exact_duplicate_text_count: exactDuplicateTextCount,
      near_duplicate_text_count: nearDuplicateTextCount,
      near_duplicate_scan_truncated: nearDuplicateScanTruncated,
      cross_split_duplicate_count: crossSplitDuplicateCount,
      repo_split_contamination_signal_count: repoSplitContaminationSignalCount,
      time_split_contamination_signal_count: timeSplitContaminationSignalCount,
      environment_observation_count: selectedEvents.filter(isEnvironmentObservation).length,
      environment_action_count: selectedEvents.filter(isEnvironmentAction).length,
      environment_result_count: selectedEvents.filter(isEnvironmentResult).length,
      verification_evidence_count: verificationEventIds.size,
      environment_grounded_turn_count: environmentGroundedTurnCount,
      egs_complete_turn_count: egsCompleteTurnCount,
      egs_completeness_ratio: egsCompletenessRatio,
      tor_complete_turn_count: torCompleteTurns.size,
      tor_complete_action_count: torCompleteActionCount,
      tor_completeness_ratio: actionCount === 0 ? 1 : torCompleteActionCount / actionCount,
      raw_record_count: bundle.raw.length,
      raw_sequence_gap_count: rawSequenceGapCount,
      raw_duplicate_sequence_count: rawDuplicateSequenceCount,
      raw_integrity_error_count: rawReasons.length,
    },
  };
}

export function applyAutomatedReview(bundle: TraceBundle): { bundle: TraceBundle; report: QualityReport } {
  const report = inspectQuality(bundle);
  return {
    bundle: {
      ...bundle,
      manifest: {
        ...bundle.manifest,
        review: { ...bundle.manifest.review, automated_checks: report.passed ? "passed" : "failed" },
      },
    },
    report,
  };
}
