import type {
  Source,
  TraceBundle,
  TrajectoryEvent,
  VerifierConfirmation,
  VerifierEvidence,
} from "@trajpack/schema";
import {
  traceBundleSchema,
  verifierConfirmationSchema,
  verifierEvidenceSchema,
} from "@trajpack/schema";
import {
  DEEPSEEK_HARNESS_INTERFACE_VERSION,
  normalizeRawEnvelope,
} from "@trajpack/adapters";
import {
  compileDeepSeekRequestEpochs,
  DEEPSEEK_EPOCH_COMPILER_VERSION,
  type DeepSeekEpochMessage,
  type DeepSeekRequestEpoch,
} from "@trajpack/adapters/deepseek-epoch";
import { canonicalJson, sha256, stableId } from "./canonical.js";
import { rawIntegrityReasons } from "./integrity.js";
import { approvalFingerprint, reviewEvidenceFingerprint } from "./policy.js";
import { structuredToolProjectionExcluded } from "./selection.js";

/**
 * This compiler deliberately produces evidence-bearing training views rather
 * than labels. In particular, it never constructs a preference pair, a step
 * reward, or a success label from ordering, status, or a tool exit code.
 */
export const TRAINING_VIEW_COMPILER_VERSION = "training-view-compiler/0.2" as const;

export const TRAINING_VIEW_RECIPE_VERSIONS = Object.freeze({
  answer_sft: "answer-sft/0.1",
  reasoning_sft: "provider-exposed-reasoning-sft/0.1",
  tool_use_sft: "native-tool-use-sft/0.1",
  deepseek_epoch_sft: "deepseek-exact-request-epoch-sft/0.1",
  failure_recovery: "evidenced-failure-recovery-sft/0.1",
  subagent_handoff: "subagent-handoff-sft/0.1",
  pointwise_reward_rl_ready: "verified-pointwise-reward/0.1",
} as const);

export type TrainingViewRecipe = keyof typeof TRAINING_VIEW_RECIPE_VERSIONS;
export type TrainingViewObjective = "sft" | "pointwise_reward";
export type TrainingLossComponent =
  | "answer_text"
  | "reasoning"
  | "tool_name"
  | "tool_arguments"
  | "plan";

export interface TrainingViewMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string | null;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
  /** Canonical ids remain attached after messages are grouped. */
  source_event_ids: string[];
}

export interface TrainingViewLossTarget {
  message_index: number;
  components: TrainingLossComponent[];
  loss_weight: number;
  source_event_ids: string[];
}

export interface TrainingViewTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
  source_event_id: string;
}

export interface TrainingViewVerifierProvenance {
  label_kind: "verified_pointwise_reward";
  source_event_id: string;
  reward: number;
  verifier: VerifierEvidence;
  confirmation: Pick<
    VerifierConfirmation,
    "schema_version" | "reviewer" | "evidence_ref" | "confirmed_at" | "event_sha256"
  >;
}

export interface CompiledTrainingView {
  schema_version: "training-view/0.1";
  view_id: string;
  trace_id: string;
  recipe: TrainingViewRecipe;
  recipe_version: string;
  compiler_version: typeof TRAINING_VIEW_COMPILER_VERSION;
  objective: TrainingViewObjective;
  source_event_ids: string[];
  target_event_ids: string[];
  evidence_event_ids: string[];
  messages: TrainingViewMessage[];
  tools: TrainingViewTool[];
  loss_targets: TrainingViewLossTarget[];
  reward: number | null;
  verifier_provenance: TrainingViewVerifierProvenance | null;
  metadata: Record<string, unknown>;
}

export interface TrainingViewExclusion {
  exclusion_id: string;
  trace_id: string;
  recipe: TrainingViewRecipe;
  candidate_event_ids: string[];
  reason_codes: string[];
  detail: string;
}

export interface TrainingViewCompilation {
  schema_version: "training-view-compilation/0.1";
  trace_id: string;
  recipe: TrainingViewRecipe;
  recipe_version: string;
  compiler_version: typeof TRAINING_VIEW_COMPILER_VERSION;
  views: CompiledTrainingView[];
  exclusions: TrainingViewExclusion[];
  compilation_sha256: string;
}

interface ConversationResult {
  messages: TrainingViewMessage[];
  tools: TrainingViewTool[];
  lossTargets: TrainingViewLossTarget[];
  issues: string[];
  droppedContextEventIds: string[];
}

interface VerifiedReward {
  event: TrajectoryEvent;
  reward: number;
  verifier: VerifierEvidence;
  confirmation: VerifierConfirmation;
  targetEventId: string;
  targetEventSha256: string;
}

const ALL_RECIPES = Object.freeze(Object.keys(TRAINING_VIEW_RECIPE_VERSIONS) as TrainingViewRecipe[]);
const PRIVACY_CLEARED = new Set(["passed", "redacted"]);

function orderedEvents(bundle: TraceBundle): TrajectoryEvent[] {
  return [...bundle.events]
    .filter((event) => event.review_disposition === "include")
    .filter((event) => !structuredToolProjectionExcluded(event))
    .sort((left, right) => left.sequence - right.sequence
      || (left.event_id < right.event_id ? -1 : left.event_id > right.event_id ? 1 : 0));
}

function uniqueInOrder(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function boundary(event: TrajectoryEvent): string | null {
  if (event.source_session_id === null || event.source_turn_id === null || event.source_step_id === null) return null;
  return canonicalJson([event.source_session_id, event.source_turn_id, event.source_step_id]);
}

function sameRun(left: TrajectoryEvent, right: TrajectoryEvent): boolean {
  if (left.source_session_id !== null && right.source_session_id !== null
    && left.source_session_id !== right.source_session_id) return false;
  if (left.source_turn_id !== null && right.source_turn_id !== null
    && left.source_turn_id !== right.source_turn_id) return false;
  return true;
}

function sameToolBoundary(left: TrajectoryEvent, right: TrajectoryEvent): boolean {
  if (!sameRun(left, right)) return false;
  return left.source_step_id === null || right.source_step_id === null
    || left.source_step_id === right.source_step_id;
}

function canonicalTeacherProvider(value: string): Source["provider"] | null {
  const route = value.trim().toLowerCase();
  if (!route) return null;
  if (route === "deepseek" || route.startsWith("deepseek-")) return "deepseek";
  if (route === "openai" || route.startsWith("openai-")) return "openai";
  if (route === "anthropic" || route.startsWith("anthropic-")
    || route === "claude" || route.startsWith("claude-")) return "anthropic";
  if (route === "google" || route.startsWith("google-")
    || route === "gemini" || route.startsWith("gemini-")) return "google";
  if (route === "self_hosted" || route === "self-hosted" || route === "local"
    || route.startsWith("ollama") || route.startsWith("vllm")) return "self_hosted";
  return null;
}

function teacherRouteIssues(bundle: TraceBundle, targets: TrajectoryEvent[]): string[] {
  if (bundle.manifest.source.host !== "deepseek_harness") return [];
  const expectedProvider = bundle.manifest.source.provider;
  const expectedModel = bundle.manifest.source.model_id;
  if (expectedProvider === "unknown" || expectedModel === null) return ["TEACHER_ROUTE_MISMATCH"];
  for (const event of targets) {
    if (event.source_session_id === null) return ["TEACHER_ROUTE_MISMATCH"];
    const targetHarnessSeq = event.metadata.harness_seq;
    if (Number.isSafeInteger(targetHarnessSeq) && bundle.raw.some((envelope) => {
      const identity = rawHarnessIdentity(envelope.payload);
      const payload = jsonObject(envelope.payload);
      const rawEvent = jsonObject(payload?.event);
      const surfaceOp = jsonObject(rawEvent?.surfaceOp);
      return identity?.sessionId === event.source_session_id
        && identity.seq <= (targetHarnessSeq as number) && surfaceOp?.op === "replace";
    })) return ["DEEPSEEK_SURFACE_REPLACEMENT_REQUIRES_EXACT_RECIPE"];
    const header = bundle.events
      .filter((candidate) => candidate.source_session_id === event.source_session_id
        && candidate.sequence <= event.sequence
        && candidate.review_disposition === "include"
        && candidate.metadata.durable_event_type === "request/header")
      .sort((left, right) => right.sequence - left.sequence)[0] ?? null;
    if (header === null) return ["REQUEST_HEADER_MISSING"];
    if (header.content.some((part) => part.review_disposition !== "include")) {
      return ["REQUEST_HEADER_CONTENT_UNAVAILABLE"];
    }
    if (header.content.some((part) => !PRIVACY_CLEARED.has(part.redaction_status))) {
      return ["REQUEST_HEADER_NOT_PRIVACY_CLEARED"];
    }
    const requestConfig = jsonObject(header?.metadata.request_config);
    const headerProvider = requestConfig?.provider;
    const headerModel = requestConfig?.model;
    const provider = event.metadata.provider_route;
    const model = event.metadata.model;
    if (typeof headerProvider !== "string" || canonicalTeacherProvider(headerProvider) !== expectedProvider
      || typeof headerModel !== "string" || headerModel !== expectedModel
      || typeof provider !== "string" || canonicalTeacherProvider(provider) !== expectedProvider
      || typeof model !== "string" || model !== expectedModel) return ["TEACHER_ROUTE_MISMATCH"];
    if (canonicalTeacherProvider(provider) !== canonicalTeacherProvider(headerProvider) || model !== headerModel) {
      return ["TEACHER_ROUTE_MISMATCH"];
    }
  }
  return [];
}

function roleFor(event: TrajectoryEvent): TrainingViewMessage["role"] {
  if (event.actor === "assistant" || event.actor === "agent") return "assistant";
  if (event.actor === "user" || event.actor === "developer" || event.actor === "system") return event.actor;
  return "system";
}

function selectedParts(event: TrajectoryEvent) {
  return [...event.content]
    .filter((part) => part.review_disposition === "include")
    .sort((left, right) => left.ordinal - right.ordinal);
}

function privacyIssues(events: TrajectoryEvent[]): string[] {
  const issues: string[] = [];
  for (const event of events) {
    for (const part of selectedParts(event)) {
      if (!PRIVACY_CLEARED.has(part.redaction_status)) issues.push("CONTENT_NOT_PRIVACY_CLEARED");
      if (part.value === null && part.blob_ref !== null) issues.push("BLOB_CONTENT_UNAVAILABLE");
    }
  }
  return [...new Set(issues)].sort();
}

function ordinaryText(event: TrajectoryEvent): string {
  return selectedParts(event)
    .filter((part) => !["reasoning", "tool_call", "tool_result"].includes(part.type))
    .map((part) => part.value)
    .filter((value): value is string => value !== null && value.length > 0)
    .join("\n");
}

function reasoningParts(event: TrajectoryEvent) {
  return selectedParts(event).filter((part) => part.type === "reasoning");
}

function isStrictProviderExposedReasoning(event: TrajectoryEvent): boolean {
  const parts = reasoningParts(event);
  return parts.length > 0 && parts.every((part) => {
    const reasoning = part.reasoning;
    return reasoning?.representation === "provider_exposed_reasoning"
      && reasoning.provider_claim === "chain_of_thought"
      && reasoning.visibility !== "not_returned"
      && typeof reasoning.source_field === "string"
      && reasoning.source_field.length > 0
      && part.value !== null;
  });
}

function strictReasoningText(events: TrajectoryEvent[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const event of events) {
    for (const part of reasoningParts(event)) {
      if (part.value !== null && !seen.has(part.sha256)) {
        seen.add(part.sha256);
        parts.push(part.value);
      }
    }
  }
  return parts.join("\n");
}

function isDeepSeekHarnessCanonicalEvent(event: TrajectoryEvent): boolean {
  return event.metadata.interface_version === DEEPSEEK_HARNESS_INTERFACE_VERSION
    || event.metadata.capture_channel === DEEPSEEK_HARNESS_INTERFACE_VERSION;
}

function isAssembledHarnessToolCall(event: TrajectoryEvent): boolean {
  return event.event_type === "tool.call"
    && isDeepSeekHarnessCanonicalEvent(event)
    && event.metadata.durable_event_type === "assistant/message";
}

function toolArguments(event: TrajectoryEvent): string {
  return typeof event.tool?.arguments === "string"
    ? event.tool.arguments
    : canonicalJson(event.tool?.arguments ?? {});
}

function requestHeaderContext(events: TrajectoryEvent[]): {
  system: TrainingViewMessage | null;
  tools: TrainingViewTool[];
  issues: string[];
} {
  const header = [...events].reverse().find((event) => event.metadata.durable_event_type === "request/header") ?? null;
  if (header === null) return { system: null, tools: [], issues: [] };
  const issues: string[] = [];
  const roles = Array.isArray(header.metadata.request_content_roles)
    ? header.metadata.request_content_roles
    : [];
  const roleByOrdinal = new Map<number, string>();
  for (const value of roles) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push("REQUEST_CONTENT_ROLE_INVALID");
      continue;
    }
    const ordinal = (value as Record<string, unknown>).ordinal;
    const role = (value as Record<string, unknown>).role;
    if (!Number.isSafeInteger(ordinal) || typeof role !== "string" || roleByOrdinal.has(ordinal as number)) {
      issues.push("REQUEST_CONTENT_ROLE_INVALID");
      continue;
    }
    roleByOrdinal.set(ordinal as number, role);
  }
  const parts = selectedParts(header);
  const systemText = parts
    .filter((part) => roleByOrdinal.get(part.ordinal) === "system")
    .map((part) => part.value)
    .filter((value): value is string => value !== null && value.length > 0)
    .join("\n");
  const tools: TrainingViewTool[] = [];
  const toolOrdinals = [...roleByOrdinal.entries()]
    .filter(([, role]) => role === "tool_schema")
    .map(([ordinal]) => ordinal);
  const toolNames = new Set<string>();
  for (const ordinal of toolOrdinals) {
    const part = header.content.find((candidate) => candidate.ordinal === ordinal) ?? null;
    if (part === null || part.review_disposition !== "include" || part.redaction_status !== "passed"
      || part.value === null || part.blob_ref !== null) {
      issues.push("TOOL_SCHEMA_INVALID_OR_UNAVAILABLE");
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(part.value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        issues.push("TOOL_SCHEMA_INVALID_OR_UNAVAILABLE");
        continue;
      }
      const schema = parsed as Record<string, unknown>;
      const name = typeof schema.name === "string" ? schema.name : null;
      if (name === null || name.length === 0 || toolNames.has(name)) {
        issues.push("TOOL_SCHEMA_INVALID_OR_UNAVAILABLE");
        continue;
      }
      const input = schema.inputSchema ?? schema.input_schema ?? schema.parameters;
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        issues.push("TOOL_SCHEMA_INVALID_OR_UNAVAILABLE");
        continue;
      }
      const parameters = input as Record<string, unknown>;
      toolNames.add(name);
      tools.push({
        type: "function",
        function: {
          name,
          ...(typeof schema.description === "string" ? { description: schema.description } : {}),
          parameters,
        },
        source_event_id: header.event_id,
      });
    } catch {
      issues.push("TOOL_SCHEMA_INVALID_OR_UNAVAILABLE");
    }
  }
  return {
    system: systemText.length === 0
      ? null
      : { role: "system", content: systemText, source_event_ids: [header.event_id] },
    tools,
    issues: [...new Set(issues)].sort(),
  };
}

/**
 * Maps a canonical prefix to a conversational view. The caller identifies the
 * exact canonical target events and components; every other assistant message
 * is context-only. Provider summaries and opaque states are intentionally
 * omitted, never relabelled as ordinary assistant text.
 */
function conversation(
  events: TrajectoryEvent[],
  targetIds: Set<string>,
  targetComponents: TrainingLossComponent[],
  contextSessionId?: string | null,
): ConversationResult {
  const targets = events.filter((event) => targetIds.has(event.event_id));
  const targetSessions = new Set(targets.map((event) => event.source_session_id));
  const sessionId = contextSessionId !== undefined
    ? contextSessionId
    : targetSessions.size === 1 ? [...targetSessions][0]! : undefined;
  const scopedEvents = sessionId === undefined
    ? []
    : events.filter((event) => event.source_session_id === sessionId);
  const requestHeader = requestHeaderContext(scopedEvents);
  const messages: TrainingViewMessage[] = requestHeader.system === null ? [] : [requestHeader.system];
  const lossTargets: TrainingViewLossTarget[] = [];
  const issues = [...privacyIssues(scopedEvents), ...requestHeader.issues];
  if (sessionId === undefined || targetSessions.size > 1) issues.push("CROSS_SESSION_CONTEXT_BLOCKED");
  const droppedContextEventIds: string[] = [];
  const knownCalls = new Set<string>();
  const consumedTargets = new Set<string>();

  for (let index = 0; index < scopedEvents.length; index += 1) {
    const event = scopedEvents[index]!;
    if (event.event_type === "tool.call") {
      // Harness exposes the same logical call as a streaming delta, an
      // assembled assistant/message block, and an execution lifecycle record.
      // Only the assembled provider message belongs in conversational context.
      if (isDeepSeekHarnessCanonicalEvent(event) && !isAssembledHarnessToolCall(event)) continue;
      const callBoundary = boundary(event);
      const calls = [event];
      while (callBoundary !== null && index + 1 < scopedEvents.length) {
        const candidate = scopedEvents[index + 1]!;
        if (candidate.event_type !== "tool.call" || boundary(candidate) !== callBoundary) break;
        calls.push(candidate);
        index += 1;
      }
      if (calls.some((call) => !call.tool?.call_id || !call.tool.name)) {
        issues.push("TOOL_CALL_ID_OR_NAME_MISSING");
        continue;
      }
      const sourceIds = calls.map((call) => call.event_id);
      const messageIndex = messages.length;
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: calls.map((call) => ({
          id: call.tool!.call_id!,
          type: "function",
          function: { name: call.tool!.name!, arguments: toolArguments(call) },
        })),
        source_event_ids: sourceIds,
      });
      calls.forEach((call) => knownCalls.add(call.tool!.call_id!));
      const targeted = sourceIds.filter((id) => targetIds.has(id));
      if (targeted.length > 0) {
        targeted.forEach((id) => consumedTargets.add(id));
        lossTargets.push({
          message_index: messageIndex,
          components: targetComponents,
          loss_weight: 1,
          source_event_ids: targeted,
        });
      }
      continue;
    }

    if (event.event_type === "tool.result") {
      const callId = event.tool?.call_id;
      if (!callId || !knownCalls.has(callId)) {
        issues.push("ORPHAN_TOOL_RESULT_IN_CONTEXT");
        continue;
      }
      messages.push({
        role: "tool",
        content: typeof event.tool?.result === "string"
          ? event.tool.result
          : canonicalJson(event.tool?.result ?? null),
        tool_call_id: callId,
        ...(event.tool?.name ? { name: event.tool.name } : {}),
        source_event_ids: [event.event_id],
      });
      continue;
    }

    if (event.event_type === "reasoning") {
      if (!isStrictProviderExposedReasoning(event)) {
        droppedContextEventIds.push(event.event_id);
        continue;
      }
      const target = targetIds.has(event.event_id);
      const messageIndex = messages.length;
      messages.push({
        role: "assistant",
        content: null,
        reasoning_content: strictReasoningText([event]),
        source_event_ids: [event.event_id],
      });
      if (target) {
        consumedTargets.add(event.event_id);
        lossTargets.push({
          message_index: messageIndex,
          components: targetComponents,
          loss_weight: 1,
          source_event_ids: [event.event_id],
        });
      }
      continue;
    }

    if (!["message", "plan"].includes(event.event_type)) continue;
    if (event.status === "partial" && roleFor(event) === "assistant" && !targetIds.has(event.event_id)) {
      droppedContextEventIds.push(event.event_id);
      continue;
    }
    const content = ordinaryText(event);
    if (!content) continue;
    const target = targetIds.has(event.event_id);
    const messageIndex = messages.length;
    messages.push({ role: roleFor(event), content, source_event_ids: [event.event_id] });
    if (target) {
      consumedTargets.add(event.event_id);
      lossTargets.push({
        message_index: messageIndex,
        components: targetComponents,
        loss_weight: 1,
        source_event_ids: [event.event_id],
      });
    }
  }

  if ([...targetIds].some((id) => !consumedTargets.has(id))) issues.push("TARGET_NOT_MAPPABLE_TO_MESSAGE");
  return {
    messages,
    tools: requestHeader.tools,
    lossTargets,
    issues: [...new Set(issues)].sort(),
    droppedContextEventIds: uniqueInOrder(droppedContextEventIds),
  };
}

function exclusion(
  traceId: string,
  recipe: TrainingViewRecipe,
  candidateEventIds: string[],
  reasonCodes: string[],
  detail: string,
): TrainingViewExclusion {
  const ids = uniqueInOrder(candidateEventIds);
  const codes = [...new Set(reasonCodes)].sort();
  return {
    exclusion_id: stableId("view_exclusion", { traceId, recipe, ids, codes, detail }),
    trace_id: traceId,
    recipe,
    candidate_event_ids: ids,
    reason_codes: codes,
    detail,
  };
}

function compiledView(input: Omit<CompiledTrainingView,
  "schema_version" | "view_id" | "recipe_version" | "compiler_version" | "source_event_ids" | "tools"
> & { source_event_ids?: string[]; tools?: TrainingViewTool[] }): CompiledTrainingView {
  const recipeVersion = TRAINING_VIEW_RECIPE_VERSIONS[input.recipe];
  const tools = input.tools ?? [];
  const sourceIds = uniqueInOrder(input.source_event_ids ?? [
    ...input.messages.flatMap((message) => message.source_event_ids),
    ...input.evidence_event_ids,
  ]);
  const identity = {
    trace_id: input.trace_id,
    recipe: input.recipe,
    recipe_version: recipeVersion,
    objective: input.objective,
    target_event_ids: input.target_event_ids,
    evidence_event_ids: input.evidence_event_ids,
    source_event_ids: sourceIds,
    messages: input.messages,
    tools,
    loss_targets: input.loss_targets,
    reward: input.reward,
    verifier_provenance: input.verifier_provenance,
    metadata: input.metadata,
  };
  return {
    schema_version: "training-view/0.1",
    view_id: stableId("training_view", identity, 32),
    trace_id: input.trace_id,
    recipe: input.recipe,
    recipe_version: recipeVersion,
    compiler_version: TRAINING_VIEW_COMPILER_VERSION,
    objective: input.objective,
    source_event_ids: sourceIds,
    target_event_ids: uniqueInOrder(input.target_event_ids),
    evidence_event_ids: uniqueInOrder(input.evidence_event_ids),
    messages: input.messages,
    tools,
    loss_targets: input.loss_targets,
    reward: input.reward,
    verifier_provenance: input.verifier_provenance,
    metadata: input.metadata,
  };
}

function contextSourceIds(result: ConversationResult, evidence: TrajectoryEvent[]): string[] {
  return uniqueInOrder([
    ...result.messages.flatMap((message) => message.source_event_ids),
    ...result.tools.map((tool) => tool.source_event_id),
    ...evidence.map((event) => event.event_id),
  ]);
}

type JsonObject = Record<string, unknown>;

interface EpochMessageProjection {
  messages: TrainingViewMessage[];
  targetComponents: TrainingLossComponent[];
  includesProviderExposedReasoning: boolean;
  issues: string[];
}

interface CanonicalEpochProjection {
  events: TrajectoryEvent[];
  eventIds: string[];
  issues: string[];
}

function jsonObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function rawHarnessIdentity(payload: unknown): { sessionId: string; seq: number; firstLiveSeq: number | null } | null {
  const capsule = jsonObject(payload);
  const event = jsonObject(capsule?.event);
  const header = jsonObject(capsule?.session_header);
  const sessionId = nonEmptyString(capsule?.session_id);
  const headerId = nonEmptyString(header?.id);
  const seq = event?.seq;
  const firstLiveSeq = header?.first_live_seq;
  if (capsule === null || event === null || header === null || sessionId === null || headerId !== sessionId
    || header.version !== 0 || !Number.isSafeInteger(seq) || (seq as number) < 0) return null;
  if (firstLiveSeq !== undefined && (!Number.isSafeInteger(firstLiveSeq) || (firstLiveSeq as number) < 0)) return null;
  return {
    sessionId,
    seq: seq as number,
    firstLiveSeq: firstLiveSeq === undefined ? null : firstLiveSeq as number,
  };
}

function canonicalProjectionForHarnessSeq(
  bundle: TraceBundle,
  sessionId: string,
  seq: number,
  requireExactClearedContent: boolean,
): CanonicalEpochProjection {
  const matches = bundle.raw.filter((envelope) => {
    const identity = rawHarnessIdentity(envelope.payload);
    return identity?.sessionId === sessionId && identity.seq === seq;
  });
  if (matches.length !== 1) {
    return { events: [], eventIds: [], issues: [matches.length === 0 ? "RAW_SEQUENCE_NOT_FOUND" : "RAW_SEQUENCE_AMBIGUOUS"] };
  }
  const envelope = matches[0]!;
  const expected = normalizeRawEnvelope(envelope, { traceId: bundle.manifest.trace_id, nextSequence: 0 });
  if (expected.length === 0) return { events: [], eventIds: [], issues: ["RAW_SEQUENCE_HAS_NO_CANONICAL_PROJECTION"] };
  const events: TrajectoryEvent[] = [];
  const issues: string[] = [];
  for (const projected of expected) {
    const actual = bundle.events.find((candidate) => candidate.event_id === projected.event_id) ?? null;
    if (actual === null) {
      issues.push("CANONICAL_PROJECTION_MISSING");
      continue;
    }
    if (actual.source_session_id !== sessionId || actual.metadata.harness_seq !== seq
      || actual.event_type !== projected.event_type || actual.actor !== projected.actor
      || actual.status !== projected.status || canonicalJson(actual.tool) !== canonicalJson(projected.tool)
      || actual.metadata.provider_route !== projected.metadata.provider_route
      || actual.metadata.model !== projected.metadata.model) {
      issues.push("CANONICAL_PROJECTION_CHANGED");
      continue;
    }
    if (requireExactClearedContent) {
      if (actual.review_disposition !== "include") issues.push("CANONICAL_EVENT_EXCLUDED");
      if (actual.content.length !== projected.content.length) issues.push("CANONICAL_CONTENT_CHANGED");
      for (const expectedPart of projected.content) {
        const actualPart = actual.content.find((part) => part.ordinal === expectedPart.ordinal) ?? null;
        if (actualPart === null
          || actualPart.type !== expectedPart.type
          || actualPart.mime_type !== expectedPart.mime_type
          || actualPart.value !== expectedPart.value
          || actualPart.blob_ref !== expectedPart.blob_ref
          || actualPart.sha256 !== expectedPart.sha256
          || canonicalJson(actualPart.reasoning) !== canonicalJson(expectedPart.reasoning)) {
          issues.push("CANONICAL_CONTENT_CHANGED");
          continue;
        }
        if (actualPart.review_disposition !== "include") issues.push("CANONICAL_CONTENT_EXCLUDED");
        if (actualPart.redaction_status !== "passed") issues.push("EXACT_EPOCH_CONTENT_NOT_PRIVACY_CLEARED");
      }
    }
    events.push(actual);
  }
  return { events, eventIds: events.map((event) => event.event_id), issues: [...new Set(issues)].sort() };
}

function jsonToolArguments(value: unknown): string | null {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return jsonObject(parsed) === null ? null : value;
    } catch {
      return null;
    }
  }
  return jsonObject(value) === null ? null : canonicalJson(value);
}

function toolResultText(block: JsonObject): string | null {
  if (!Array.isArray(block.content) || block.content.length === 0) return null;
  const text: string[] = [];
  for (const item of block.content) {
    const content = jsonObject(item);
    if (content?.type !== "text" || typeof content.text !== "string") return null;
    text.push(content.text);
  }
  return text.join("\n");
}

function projectEpochMessage(
  rawMessage: JsonObject,
  role: "user" | "assistant" | "tool",
  provider: string,
  sourceEventIds: string[],
): EpochMessageProjection {
  const issues: string[] = [];
  const messages: TrainingViewMessage[] = [];
  const targetComponents: TrainingLossComponent[] = [];
  if (!Array.isArray(rawMessage.content) || rawMessage.content.length === 0) {
    return { messages, targetComponents, includesProviderExposedReasoning: false, issues: ["HARNESS_MESSAGE_CONTENT_MISSING"] };
  }

  if (role === "tool") {
    for (const item of rawMessage.content) {
      const block = jsonObject(item);
      if (block?.type !== "tool-result") {
        issues.push("UNSUPPORTED_HARNESS_TOOL_RESULT_CONTENT");
        continue;
      }
      const callId = nonEmptyString(block.toolCallId);
      const content = toolResultText(block);
      if (callId === null || content === null) {
        issues.push("HARNESS_TOOL_RESULT_INCOMPLETE");
        continue;
      }
      messages.push({ role: "tool", content, tool_call_id: callId, source_event_ids: sourceEventIds });
    }
    return {
      messages,
      targetComponents,
      includesProviderExposedReasoning: false,
      issues: [...new Set(issues)].sort(),
    };
  }

  if (rawMessage.role !== role) issues.push("HARNESS_MESSAGE_ROLE_MISMATCH");
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolCalls: NonNullable<TrainingViewMessage["tool_calls"]> = [];
  const callIds = new Set<string>();
  for (const item of rawMessage.content) {
    const block = jsonObject(item);
    const type = nonEmptyString(block?.type);
    if (block === null || type === null) {
      issues.push("UNSUPPORTED_HARNESS_CONTENT");
    } else if (type === "text") {
      if (typeof block.text !== "string") issues.push("HARNESS_TEXT_CONTENT_INVALID");
      else textParts.push(block.text);
    } else if (type === "reasoning") {
      if (role !== "assistant" || canonicalTeacherProvider(provider) !== "deepseek" || typeof block.text !== "string") {
        issues.push("REASONING_NOT_EXPLICIT_DEEPSEEK_PROVIDER_OUTPUT");
      } else {
        reasoningParts.push(block.text);
      }
    } else if (type === "tool-call") {
      const id = nonEmptyString(block.id);
      const name = nonEmptyString(block.name);
      const args = jsonToolArguments(block.arguments);
      if (role !== "assistant" || id === null || name === null || args === null || callIds.has(id)) {
        issues.push("HARNESS_TOOL_CALL_INVALID");
      } else {
        callIds.add(id);
        toolCalls.push({ id, type: "function", function: { name, arguments: args } });
      }
    } else {
      issues.push("UNSUPPORTED_HARNESS_CONTENT");
    }
  }
  if (textParts.length === 0 && reasoningParts.length === 0 && toolCalls.length === 0) {
    issues.push("HARNESS_MESSAGE_HAS_NO_TRAINABLE_CONTENT");
  }
  if (issues.length === 0) {
    messages.push({
      role,
      content: textParts.length === 0 ? null : textParts.join("\n"),
      ...(reasoningParts.length === 0 ? {} : { reasoning_content: reasoningParts.join("\n") }),
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
      source_event_ids: sourceEventIds,
    });
    if (reasoningParts.length > 0) targetComponents.push("reasoning");
    if (textParts.length > 0) targetComponents.push("answer_text");
    if (toolCalls.length > 0) targetComponents.push("tool_name", "tool_arguments");
  }
  return {
    messages,
    targetComponents,
    includesProviderExposedReasoning: reasoningParts.length > 0,
    issues: [...new Set(issues)].sort(),
  };
}

function projectEpochTools(
  epoch: DeepSeekRequestEpoch,
  headerEventId: string,
): { tools: TrainingViewTool[]; hashes: string[]; issues: string[] } {
  const tools: TrainingViewTool[] = [];
  const hashes: string[] = [];
  const names = new Set<string>();
  const issues: string[] = [];
  for (const schema of epoch.tools) {
    const name = nonEmptyString(schema.name);
    const parameters = jsonObject(schema.inputSchema ?? schema.input_schema ?? schema.parameters);
    if (name === null || parameters === null || names.has(name)) {
      issues.push("HARNESS_TOOL_SCHEMA_INVALID");
      continue;
    }
    names.add(name);
    hashes.push(sha256(canonicalJson(schema)));
    tools.push({
      type: "function",
      function: {
        name,
        ...(typeof schema.description === "string" ? { description: schema.description } : {}),
        parameters,
      },
      source_event_id: headerEventId,
    });
  }
  return { tools, hashes, issues: [...new Set(issues)].sort() };
}

function epochSeqs(epoch: DeepSeekRequestEpoch): number[] {
  return uniqueInOrder([
    epoch.request_header_seq,
    ...epoch.surface_before.map((message) => message.surface_seq),
    ...epoch.surface_before.flatMap((message) => message.source_event_seqs ?? []),
    epoch.output_event_seq,
    ...(epoch.output_source_event_seqs ?? []),
  ].filter((seq) => Number.isSafeInteger(seq) && seq >= 0).map(String)).map(Number);
}

function deepSeekEpochViews(bundle: TraceBundle) {
  const recipe: TrainingViewRecipe = "deepseek_epoch_sft";
  const globalIssues: string[] = [];
  if (bundle.manifest.source.host !== "deepseek_harness") globalIssues.push("DEEPSEEK_HARNESS_SOURCE_REQUIRED");
  if (bundle.manifest.source.interface_version !== DEEPSEEK_HARNESS_INTERFACE_VERSION) {
    globalIssues.push("DEEPSEEK_HARNESS_PINNED_INTERFACE_REQUIRED");
  }
  if (bundle.raw.length === 0) globalIssues.push("DEEPSEEK_HARNESS_RAW_REQUIRED");
  globalIssues.push(...rawIntegrityReasons(bundle));
  for (const envelope of bundle.raw) {
    if (envelope.adapter !== "deepseek_harness" || envelope.interface_version !== DEEPSEEK_HARNESS_INTERFACE_VERSION) {
      globalIssues.push("DEEPSEEK_HARNESS_PINNED_CAPSULE_REQUIRED");
      continue;
    }
    const identity = rawHarnessIdentity(envelope.payload);
    if (identity === null) globalIssues.push("DEEPSEEK_HARNESS_CAPSULE_INVALID");
    else if (identity.firstLiveSeq !== null && identity.firstLiveSeq !== 0) {
      globalIssues.push("RESUMED_PARTIAL_HARNESS_SESSION");
    }
  }
  if (globalIssues.length > 0) {
    return {
      views: [] as CompiledTrainingView[],
      exclusions: [exclusion(bundle.manifest.trace_id, recipe, [], globalIssues,
        "Exact Harness epoch SFT requires a complete, integrity-bound raw log on the pinned rc.6 event interface.")],
    };
  }

  const epochCompilation = compileDeepSeekRequestEpochs(bundle.raw.map((envelope) => envelope.payload));
  const epochErrors = epochCompilation.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (!epochCompilation.complete || epochErrors.length > 0) {
    const diagnosticCodes = epochErrors.map((diagnostic) =>
      `DEEPSEEK_EPOCH_${diagnostic.code.toUpperCase()}`);
    return {
      views: [] as CompiledTrainingView[],
      exclusions: [exclusion(bundle.manifest.trace_id, recipe, [], diagnosticCodes.length > 0
        ? diagnosticCodes : ["DEEPSEEK_EPOCH_INCOMPLETE"],
      "Harness replay reported a gap, unknown record, invalid replacement, or incomplete request epoch.")],
    };
  }
  if (epochCompilation.epochs.length === 0) {
    return {
      views: [] as CompiledTrainingView[],
      exclusions: [exclusion(bundle.manifest.trace_id, recipe, [], ["NO_COMPLETE_DEEPSEEK_REQUEST_EPOCH"],
        "The complete Harness log contains no assembled assistant/message output epoch.")],
    };
  }

  const views: CompiledTrainingView[] = [];
  const exclusions: TrainingViewExclusion[] = [];
  for (const epoch of epochCompilation.epochs) {
    const issues = [...epoch.exclusion_reasons.map((reason) => `DEEPSEEK_EPOCH_${reason.toUpperCase()}`)];
    if (!epoch.reconstructable) issues.push("DEEPSEEK_EPOCH_NOT_RECONSTRUCTABLE");
    if (bundle.manifest.source.provider === "unknown"
      || canonicalTeacherProvider(epoch.provider) !== bundle.manifest.source.provider
      || bundle.manifest.source.model_id === null || bundle.manifest.source.model_id !== epoch.model) {
      issues.push("TEACHER_ROUTE_MISMATCH");
    }

    const exactSeqs = uniqueInOrder([
      epoch.request_header_seq,
      ...epoch.surface_before.map((message) => message.surface_seq),
      epoch.output_event_seq,
    ].map(String)).map(Number);
    const exactProjections = new Map<number, CanonicalEpochProjection>();
    for (const seq of exactSeqs) {
      const projected = canonicalProjectionForHarnessSeq(bundle, epoch.session_id, seq, true);
      exactProjections.set(seq, projected);
      issues.push(...projected.issues);
    }
    const headerProjection = exactProjections.get(epoch.request_header_seq)!;
    if (headerProjection.eventIds.length !== 1) issues.push("REQUEST_HEADER_CANONICAL_BINDING_INVALID");
    const headerEventId = headerProjection.eventIds[0] ?? "";
    const tools = projectEpochTools(epoch, headerEventId);
    issues.push(...tools.issues);

    const messages: TrainingViewMessage[] = [];
    if (epoch.system !== null) {
      if (epoch.system.length === 0) issues.push("HARNESS_SYSTEM_PROMPT_INVALID");
      else messages.push({ role: "system", content: epoch.system, source_event_ids: headerProjection.eventIds });
    }

    let inputIncludesReasoning = false;
    for (const surface of epoch.surface_before) {
      const projected = exactProjections.get(surface.surface_seq)!;
      const mapped = projectEpochMessage(surface.message, surface.role, epoch.provider, projected.eventIds);
      if (mapped.includesProviderExposedReasoning
        && !projected.events.filter((event) => event.event_type === "reasoning").every(isStrictProviderExposedReasoning)) {
        issues.push("REASONING_CANONICAL_CLASSIFICATION_MISMATCH");
      }
      inputIncludesReasoning ||= mapped.includesProviderExposedReasoning;
      issues.push(...mapped.issues);
      messages.push(...mapped.messages);
    }

    const outputProjection = exactProjections.get(epoch.output_event_seq)!;
    if (outputProjection.events.some((event) => event.metadata.provider_route !== epoch.provider
      || event.metadata.model !== epoch.model)) {
      issues.push("TEACHER_ROUTE_MISMATCH");
    }
    const output = projectEpochMessage(epoch.output_message, "assistant", epoch.provider, outputProjection.eventIds);
    if (output.includesProviderExposedReasoning
      && !outputProjection.events.filter((event) => event.event_type === "reasoning").every(isStrictProviderExposedReasoning)) {
      issues.push("REASONING_CANONICAL_CLASSIFICATION_MISMATCH");
    }
    issues.push(...output.issues);
    if (output.messages.length !== 1 || output.targetComponents.length === 0) {
      issues.push("DEEPSEEK_EPOCH_OUTPUT_NOT_TRAINABLE");
    }

    const provenanceSeqs = uniqueInOrder([
      ...epoch.surface_before.flatMap((message) => message.source_event_seqs ?? []),
      ...(epoch.output_source_event_seqs ?? []),
    ].map(String)).map(Number);
    const evidenceEventIds: string[] = [];
    for (const seq of provenanceSeqs) {
      const projection = canonicalProjectionForHarnessSeq(bundle, epoch.session_id, seq, false);
      issues.push(...projection.issues);
      evidenceEventIds.push(...projection.eventIds);
    }
    if (issues.length > 0) {
      exclusions.push(exclusion(bundle.manifest.trace_id, recipe, outputProjection.eventIds,
        issues, "The exact Harness request epoch could not be mapped to reviewed canonical content without loss or reinterpretation."));
      continue;
    }

    const outputMessageIndex = messages.length;
    messages.push(output.messages[0]!);
    const sourceEventIds = uniqueInOrder([
      ...headerProjection.eventIds,
      ...messages.flatMap((message) => message.source_event_ids),
      ...tools.tools.map((tool) => tool.source_event_id),
      ...evidenceEventIds,
    ]);
    views.push(compiledView({
      trace_id: bundle.manifest.trace_id,
      recipe,
      objective: "sft",
      target_event_ids: outputProjection.eventIds,
      evidence_event_ids: uniqueInOrder(evidenceEventIds),
      source_event_ids: sourceEventIds,
      messages,
      tools: tools.tools,
      loss_targets: [{
        message_index: outputMessageIndex,
        components: output.targetComponents,
        loss_weight: 1,
        source_event_ids: outputProjection.eventIds,
      }],
      reward: null,
      verifier_provenance: null,
      metadata: {
        epoch_id: epoch.epoch_id,
        epoch_compiler_version: DEEPSEEK_EPOCH_COMPILER_VERSION,
        epoch_replay_warnings: epochCompilation.diagnostics
          .filter((diagnostic) => diagnostic.severity === "warning")
          .map((diagnostic) => ({ code: diagnostic.code, session_id: diagnostic.session_id, seq: diagnostic.seq })),
        epoch_input_sha256: epoch.input_sha256,
        epoch_output_sha256: epoch.output_sha256,
        harness_session_id: epoch.session_id,
        parent_session_id: epoch.parent_session_id,
        turn: epoch.turn,
        step: epoch.step,
        provider: epoch.provider,
        model: epoch.model,
        request_header_seq: epoch.request_header_seq,
        input_surface_seqs: epoch.surface_before.map((message) => message.surface_seq),
        input_surface_source_event_seqs: epoch.surface_before.map((message) => ({
          surface_seq: message.surface_seq,
          source_event_seqs: message.source_event_seqs,
        })),
        output_event_seq: epoch.output_event_seq,
        output_source_event_seqs: epoch.output_source_event_seqs,
        source_raw_seqs: epochSeqs(epoch),
        native_tool_schema_sha256s: tools.hashes,
        exact_model_visible_surface: true,
        input_contains_provider_exposed_reasoning: inputIncludesReasoning,
        target_contains_provider_exposed_reasoning: output.includesProviderExposedReasoning,
        reasoning_loss_enabled: output.includesProviderExposedReasoning,
        hidden_chain_of_thought_claimed: false,
      },
    }));
  }
  return { views, exclusions };
}

function answerViews(bundle: TraceBundle, events: TrajectoryEvent[]) {
  const recipe: TrainingViewRecipe = "answer_sft";
  const views: CompiledTrainingView[] = [];
  const exclusions: TrainingViewExclusion[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.event_type !== "message" || !["assistant", "agent"].includes(event.actor)) continue;
    if (event.status !== "ok") continue;
    const routeIssues = teacherRouteIssues(bundle, [event]);
    if (routeIssues.length > 0) {
      exclusions.push(exclusion(bundle.manifest.trace_id, recipe, [event.event_id], routeIssues,
        "Candidate target does not match the manifest-approved primary Harness teacher route."));
      continue;
    }
    if (!ordinaryText(event)) {
      exclusions.push(exclusion(bundle.manifest.trace_id, recipe, [event.event_id],
        ["ANSWER_TEXT_MISSING"], "Completed assistant message has no included textual answer."));
      continue;
    }
    const result = conversation(events.slice(0, index + 1), new Set([event.event_id]), ["answer_text"]);
    if (result.issues.length > 0) {
      exclusions.push(exclusion(bundle.manifest.trace_id, recipe, [event.event_id], result.issues,
        "Answer candidate could not be compiled without altering its canonical context."));
      continue;
    }
    views.push(compiledView({
      trace_id: bundle.manifest.trace_id,
      recipe,
      objective: "sft",
      target_event_ids: [event.event_id],
      evidence_event_ids: [],
      source_event_ids: contextSourceIds(result, []),
      messages: result.messages,
      tools: result.tools,
      loss_targets: result.lossTargets,
      reward: null,
      verifier_provenance: null,
      metadata: { dropped_context_event_ids: result.droppedContextEventIds },
    }));
  }
  if (views.length === 0 && exclusions.length === 0) {
    exclusions.push(exclusion(bundle.manifest.trace_id, recipe, [], ["NO_COMPLETED_ASSISTANT_ANSWER"],
      "Trace contains no completed assistant answer candidate."));
  }
  return { views, exclusions };
}

function reasoningGroups(events: TrajectoryEvent[]): TrajectoryEvent[][] {
  const groups = new Map<string, TrajectoryEvent[]>();
  for (const event of events.filter((candidate) => candidate.event_type === "reasoning")) {
    const key = boundary(event) ?? `event:${event.event_id}`;
    groups.set(key, [...(groups.get(key) ?? []), event]);
  }
  return [...groups.values()].sort((left, right) => left[0]!.sequence - right[0]!.sequence);
}

function reasoningViews(bundle: TraceBundle, events: TrajectoryEvent[]) {
  const recipe: TrainingViewRecipe = "reasoning_sft";
  const views: CompiledTrainingView[] = [];
  const exclusions: TrainingViewExclusion[] = [];
  for (const group of reasoningGroups(events)) {
    const complete = group.filter((event) => event.status === "ok");
    const source = complete.length > 0 ? complete : group;
    const ids = source.map((event) => event.event_id);
    if (complete.length === 0) {
      exclusions.push(exclusion(bundle.manifest.trace_id, recipe, ids,
        ["PARTIAL_REASONING_WITHOUT_COMPLETION"], "Streaming reasoning deltas are not trained without a completed canonical event."));
      continue;
    }
    const routeIssues = teacherRouteIssues(bundle, source);
    if (routeIssues.length > 0) {
      exclusions.push(exclusion(bundle.manifest.trace_id, recipe, ids, routeIssues,
        "Reasoning target does not match the manifest-approved primary Harness teacher route."));
      continue;
    }
    if (!source.every(isStrictProviderExposedReasoning)) {
      exclusions.push(exclusion(bundle.manifest.trace_id, recipe, ids,
        ["REASONING_REPRESENTATION_NOT_TRAINABLE"],
        "Only provider_exposed_reasoning with a visible source field and chain_of_thought provider claim is eligible."));
      continue;
    }
    const endIndex = Math.max(...source.map((event) => events.indexOf(event)));
    // Complete provider messages are authoritative training targets. Streaming
    // deltas in the same logical step remain lineage evidence but are removed
    // from the conversational prefix so they cannot duplicate the completed
    // reasoning payload or accidentally teach prefix fragments as turns.
    const partialEvidence = group.filter((event) => event.status === "partial");
    const partialIds = new Set(partialEvidence.map((event) => event.event_id));
    const prefix = events.slice(0, endIndex + 1).filter((event) => !partialIds.has(event.event_id));
    const result = conversation(prefix, new Set(ids), ["reasoning"]);
    if (result.issues.length > 0) {
      exclusions.push(exclusion(bundle.manifest.trace_id, recipe, ids, result.issues,
        "Reasoning candidate could not be compiled without altering its canonical context."));
      continue;
    }
    views.push(compiledView({
      trace_id: bundle.manifest.trace_id,
      recipe,
      objective: "sft",
      target_event_ids: ids,
      evidence_event_ids: partialEvidence.map((event) => event.event_id),
      source_event_ids: contextSourceIds(result, partialEvidence),
      messages: result.messages,
      tools: result.tools,
      loss_targets: result.lossTargets,
      reward: null,
      verifier_provenance: null,
      metadata: {
        reasoning_representation: "provider_exposed_reasoning",
        explicit_recipe_opt_in: true,
        original_include_in_loss: source.map((event) => reasoningParts(event).map((part) => part.reasoning!.include_in_loss)),
        streaming_evidence_event_ids: partialEvidence.map((event) => event.event_id),
        dropped_context_event_ids: result.droppedContextEventIds,
      },
    }));
  }
  if (views.length === 0 && exclusions.length === 0) {
    exclusions.push(exclusion(bundle.manifest.trace_id, recipe, [], ["NO_REASONING_CANDIDATE"],
      "Trace contains no observable reasoning candidate."));
  }
  return { views, exclusions };
}

function parallelToolGroups(bundle: TraceBundle, events: TrajectoryEvent[]): TrajectoryEvent[][] {
  const groups: TrajectoryEvent[][] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.event_type !== "tool.call") continue;
    if (bundle.manifest.source.host === "deepseek_harness" && !isAssembledHarnessToolCall(event)) continue;
    const key = boundary(event);
    const group = [event];
    while (key !== null && index + 1 < events.length) {
      const candidate = events[index + 1]!;
      if (candidate.event_type !== "tool.call" || boundary(candidate) !== key) break;
      if (bundle.manifest.source.host === "deepseek_harness" && !isAssembledHarnessToolCall(candidate)) break;
      group.push(candidate);
      index += 1;
    }
    groups.push(group);
  }
  return groups;
}

function matchingToolResult(events: TrajectoryEvent[], call: TrajectoryEvent): TrajectoryEvent | null {
  const callIndex = events.indexOf(call);
  const candidates = events.slice(callIndex + 1).filter((candidate) => candidate.event_type === "tool.result"
    && candidate.tool?.call_id !== null
    && candidate.tool?.call_id === call.tool?.call_id
    && sameToolBoundary(call, candidate));
  // A missing step id is a legacy fallback only. Reused call ids make the
  // association ambiguous, so fail closed instead of choosing the first row.
  return candidates.length === 1 ? candidates[0]! : null;
}

function toolViews(bundle: TraceBundle, events: TrajectoryEvent[]) {
  const recipe: TrainingViewRecipe = "tool_use_sft";
  const views: CompiledTrainingView[] = [];
  const exclusions: TrainingViewExclusion[] = [];
  for (const calls of parallelToolGroups(bundle, events)) {
    const ids = calls.map((event) => event.event_id);
    const routeIssues = teacherRouteIssues(bundle, calls);
    if (routeIssues.length > 0) {
      exclusions.push(exclusion(bundle.manifest.trace_id, recipe, ids, routeIssues,
        "Tool-call target does not match the manifest-approved primary Harness teacher route."));
      continue;
    }
    if (calls.some((event) => !event.tool?.call_id || !event.tool.name)) {
      exclusions.push(exclusion(bundle.manifest.trace_id, recipe, ids, ["TOOL_CALL_ID_OR_NAME_MISSING"],
        "Tool-use supervision requires canonical call ids and tool names."));
      continue;
    }
    const results = calls.map((call) => matchingToolResult(events, call));
    if (results.some((result) => result === null)) {
      exclusions.push(exclusion(bundle.manifest.trace_id, recipe, ids, ["TOOL_RESULT_MISSING"],
        "Tool-use supervision requires an observed result for every call, including parallel calls."));
      continue;
    }
    const endIndex = Math.max(...calls.map((event) => events.indexOf(event)));
    const result = conversation(events.slice(0, endIndex + 1), new Set(ids), ["tool_name", "tool_arguments"]);
    if (result.issues.length > 0) {
      exclusions.push(exclusion(bundle.manifest.trace_id, recipe, ids, result.issues,
        "Tool-call candidate could not be compiled without altering its canonical context."));
      continue;
    }
    const callIds = new Set(calls.map((call) => call.tool!.call_id!));
    const lifecycleEvidence = bundle.manifest.source.host === "deepseek_harness"
      ? events.filter((candidate) => candidate.event_type === "tool.call"
        && candidate.tool?.call_id !== null && candidate.tool?.call_id !== undefined
        && callIds.has(candidate.tool.call_id) && !ids.includes(candidate.event_id)
        && calls.some((call) => sameToolBoundary(call, candidate)))
      : [];
    const evidence = [...results as TrajectoryEvent[], ...lifecycleEvidence];
    if (lifecycleEvidence.length > 0) {
      const message = result.messages.find((candidate) => candidate.tool_calls?.some((call) => callIds.has(call.id)));
      if (message !== undefined) {
        message.source_event_ids = uniqueInOrder([
          ...message.source_event_ids,
          ...lifecycleEvidence.map((event) => event.event_id),
        ]);
      }
    }
    views.push(compiledView({
      trace_id: bundle.manifest.trace_id,
      recipe,
      objective: "sft",
      target_event_ids: ids,
      evidence_event_ids: evidence.map((event) => event.event_id),
      source_event_ids: contextSourceIds(result, evidence),
      messages: result.messages,
      tools: result.tools,
      loss_targets: result.lossTargets,
      reward: null,
      verifier_provenance: null,
      metadata: {
        parallel_call_count: calls.length,
        observed_result_statuses: (results as TrajectoryEvent[]).map((event) => event.status),
        call_lineage_event_ids: lifecycleEvidence.map((event) => event.event_id),
        dropped_context_event_ids: result.droppedContextEventIds,
      },
    }));
  }
  if (views.length === 0 && exclusions.length === 0) {
    exclusions.push(exclusion(bundle.manifest.trace_id, recipe, [], ["NO_TOOL_CALL_CANDIDATE"],
      "Trace contains no canonical tool-call candidate."));
  }
  return { views, exclusions };
}

function explicitRetry(event: TrajectoryEvent): boolean {
  return event.metadata.retry === true
    || event.metadata.is_retry === true
    || event.metadata.retried === true
    || (typeof event.metadata.retry_attempt === "number" && event.metadata.retry_attempt > 0)
    || (typeof event.metadata.retry_count === "number" && event.metadata.retry_count > 0);
}

function failedOutcome(event: TrajectoryEvent): boolean {
  return event.event_type === "tool.result"
    && (event.status === "error" || (event.tool?.exit_code !== null && event.tool?.exit_code !== undefined
      && event.tool.exit_code !== 0));
}

function successfulOutcome(event: TrajectoryEvent): boolean {
  return event.event_type === "tool.result" && event.status === "ok"
    && (event.tool?.exit_code === null || event.tool?.exit_code === undefined || event.tool.exit_code === 0);
}

function recoveryViews(bundle: TraceBundle, events: TrajectoryEvent[]) {
  const recipe: TrainingViewRecipe = "failure_recovery";
  const views: CompiledTrainingView[] = [];
  const exclusions: TrainingViewExclusion[] = [];
  for (const failure of events.filter(failedOutcome)) {
    const failureIndex = events.indexOf(failure);
    const later = events.slice(failureIndex + 1).filter((candidate) => sameRun(failure, candidate));
    const marker = later.find(explicitRetry) ?? null;
    if (marker === null) {
      exclusions.push(exclusion(bundle.manifest.trace_id, recipe, [failure.event_id], ["EXPLICIT_RETRY_EVIDENCE_MISSING"],
        "A failed outcome is not labelled as recovery without an explicit retry event or retry metadata."));
      continue;
    }
    const markerIndex = events.indexOf(marker);
    const recoveryAction = events.slice(Math.max(failureIndex + 1, markerIndex))
      .find((candidate) => sameRun(failure, candidate)
        && ((candidate.event_type === "tool.call"
          && (bundle.manifest.source.host !== "deepseek_harness" || isAssembledHarnessToolCall(candidate)))
          || (candidate.event_type === "message" && ["assistant", "agent"].includes(candidate.actor)
            && candidate.status === "ok"))) ?? null;
    if (recoveryAction === null) {
      exclusions.push(exclusion(bundle.manifest.trace_id, recipe, [failure.event_id, marker.event_id],
        ["RECOVERY_ACTION_MISSING"], "Explicit retry evidence is not followed by an observable recovery action."));
      continue;
    }
    const routeIssues = teacherRouteIssues(bundle, [recoveryAction]);
    if (routeIssues.length > 0) {
      exclusions.push(exclusion(bundle.manifest.trace_id, recipe,
        [failure.event_id, marker.event_id, recoveryAction.event_id], routeIssues,
        "Recovery target does not match the manifest-approved primary Harness teacher route."));
      continue;
    }
    const outcome = recoveryAction.event_type === "tool.call"
      ? matchingToolResult(events, recoveryAction)
      : recoveryAction;
    if (outcome === null || (recoveryAction.event_type === "tool.call" && !successfulOutcome(outcome))) {
      exclusions.push(exclusion(bundle.manifest.trace_id, recipe,
        [failure.event_id, marker.event_id, recoveryAction.event_id, ...(outcome ? [outcome.event_id] : [])],
        ["RECOVERY_SUCCESS_EVIDENCE_MISSING"],
        "Recovery SFT requires an observed successful result; this does not create a reward or success label."));
      continue;
    }
    const components: TrainingLossComponent[] = recoveryAction.event_type === "tool.call"
      ? ["tool_name", "tool_arguments"]
      : ["answer_text"];
    const actionIndex = events.indexOf(recoveryAction);
    const result = conversation(events.slice(0, actionIndex + 1), new Set([recoveryAction.event_id]), components);
    if (result.issues.length > 0) {
      exclusions.push(exclusion(bundle.manifest.trace_id, recipe, [failure.event_id, recoveryAction.event_id], result.issues,
        "Recovery candidate could not be compiled without altering its canonical context."));
      continue;
    }
    const evidence = uniqueInOrder([failure.event_id, marker.event_id, outcome.event_id]);
    views.push(compiledView({
      trace_id: bundle.manifest.trace_id,
      recipe,
      objective: "sft",
      target_event_ids: [recoveryAction.event_id],
      evidence_event_ids: evidence,
      source_event_ids: uniqueInOrder([...contextSourceIds(result, []), ...evidence]),
      messages: result.messages,
      tools: result.tools,
      loss_targets: result.lossTargets,
      reward: null,
      verifier_provenance: null,
      metadata: {
        failed_event_id: failure.event_id,
        retry_evidence_event_id: marker.event_id,
        recovery_outcome_event_id: outcome.event_id,
        observed_recovery: true,
        synthetic_success_label: false,
        dropped_context_event_ids: result.droppedContextEventIds,
      },
    }));
  }
  if (views.length === 0 && exclusions.length === 0) {
    exclusions.push(exclusion(bundle.manifest.trace_id, recipe, [], ["NO_FAILED_OUTCOME_CANDIDATE"],
      "Trace contains no failed tool outcome from which to derive an observed recovery sequence."));
  }
  return { views, exclusions };
}

function agentCorrelation(event: TrajectoryEvent): string | null {
  if (event.source_step_id) return event.source_step_id;
  for (const key of ["agent_id", "subagent_id", "child_agent_id"]) {
    const value = event.metadata[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function handoffViews(bundle: TraceBundle, events: TrajectoryEvent[]) {
  const recipe: TrainingViewRecipe = "subagent_handoff";
  const views: CompiledTrainingView[] = [];
  const exclusions: TrainingViewExclusion[] = [];
  for (const invoke of events.filter((event) => event.event_type === "agent.invoke")) {
    const correlation = agentCorrelation(invoke);
    if (correlation === null) {
      exclusions.push(exclusion(bundle.manifest.trace_id, recipe, [invoke.event_id], ["SUBAGENT_CORRELATION_ID_MISSING"],
        "Subagent views require a canonical correlation id."));
      continue;
    }
    const invokeIndex = events.indexOf(invoke);
    const handoff = events.slice(invokeIndex + 1).find((candidate) => candidate.event_type === "handoff"
      && agentCorrelation(candidate) === correlation) ?? null;
    if (handoff === null) {
      exclusions.push(exclusion(bundle.manifest.trace_id, recipe, [invoke.event_id], ["SUBAGENT_HANDOFF_MISSING"],
        "Subagent invocation has no correlated handoff event."));
      continue;
    }
    const routeIssues = teacherRouteIssues(bundle, [handoff]);
    if (routeIssues.length > 0) {
      exclusions.push(exclusion(bundle.manifest.trace_id, recipe, [invoke.event_id, handoff.event_id], routeIssues,
        "Handoff target does not match the manifest-approved primary Harness teacher route."));
      continue;
    }
    const delegatedContext = ordinaryText(invoke);
    const handoffText = ordinaryText(handoff);
    const issues = privacyIssues([invoke, handoff]);
    if (!delegatedContext) issues.push("DELEGATED_CONTEXT_MISSING");
    if (!handoffText) issues.push("HANDOFF_TEXT_MISSING");
    if (handoff.status !== "ok") issues.push("HANDOFF_NOT_COMPLETED");
    if (issues.length > 0) {
      exclusions.push(exclusion(bundle.manifest.trace_id, recipe, [invoke.event_id, handoff.event_id], issues,
        "Correlated subagent events do not contain a complete, privacy-cleared delegated task and response."));
      continue;
    }
    const messages: TrainingViewMessage[] = [
      { role: "user", content: delegatedContext, source_event_ids: [invoke.event_id] },
      { role: "assistant", content: handoffText, source_event_ids: [handoff.event_id] },
    ];
    views.push(compiledView({
      trace_id: bundle.manifest.trace_id,
      recipe,
      objective: "sft",
      target_event_ids: [handoff.event_id],
      evidence_event_ids: [invoke.event_id],
      messages,
      loss_targets: [{
        message_index: 1,
        components: ["answer_text"],
        loss_weight: 1,
        source_event_ids: [handoff.event_id],
      }],
      reward: null,
      verifier_provenance: null,
      metadata: {
        correlation_id_sha256: sha256(`trajpack.subagent-correlation/v1\0${correlation}`),
        transformation: "delegated_context_and_observed_handoff",
        synthetic_handoff: false,
      },
    }));
  }
  if (views.length === 0 && exclusions.length === 0) {
    exclusions.push(exclusion(bundle.manifest.trace_id, recipe, [], ["NO_SUBAGENT_INVOCATION_CANDIDATE"],
      "Trace contains no canonical subagent invocation."));
  }
  return { views, exclusions };
}

function verifiedRewards(events: TrajectoryEvent[]): { valid: VerifiedReward[]; invalid: TrajectoryEvent[] } {
  const valid: VerifiedReward[] = [];
  const invalid: TrajectoryEvent[] = [];
  for (const event of events) {
    if (!["evaluation", "feedback"].includes(event.event_type)) continue;
    const reward = event.metadata.reward;
    const targetEventId = event.metadata.target_event_id;
    const targetEventSha256 = event.metadata.target_event_sha256;
    if (typeof reward !== "number" || !Number.isFinite(reward)) continue;
    const review = event.metadata.trajpack_review;
    const verifier = verifierEvidenceSchema.safeParse(event.metadata.verifier);
    const confirmation = verifierConfirmationSchema.safeParse(
      review && typeof review === "object" && !Array.isArray(review)
        ? (review as Record<string, unknown>).verifier_confirmation
        : undefined,
    );
    if (typeof targetEventId !== "string" || targetEventId.length === 0
      || typeof targetEventSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(targetEventSha256)
      || !verifier.success || !confirmation.success
      || confirmation.data.event_sha256 !== reviewEvidenceFingerprint(event)
      || confirmation.data.reward !== reward
      || canonicalJson(confirmation.data.verifier) !== canonicalJson(verifier.data)) {
      invalid.push(event);
      continue;
    }
    valid.push({
      event,
      reward,
      verifier: verifier.data,
      confirmation: confirmation.data,
      targetEventId,
      targetEventSha256,
    });
  }
  return { valid, invalid };
}

function rlReadyViews(bundle: TraceBundle, events: TrajectoryEvent[]) {
  const recipe: TrainingViewRecipe = "pointwise_reward_rl_ready";
  const views: CompiledTrainingView[] = [];
  const exclusions: TrainingViewExclusion[] = [];
  const rewards = verifiedRewards(events);
  for (const event of rewards.invalid) {
    exclusions.push(exclusion(bundle.manifest.trace_id, recipe, [event.event_id],
      ["VERIFIER_CONFIRMATION_INVALID_OR_MISSING"],
      "Numeric reward was observed but is not bound to a matching, versioned verifier result and reviewer confirmation."));
  }
  for (const label of rewards.valid) {
    const labelIndex = events.indexOf(label.event);
    const target = events.find((event) => event.event_id === label.targetEventId) ?? null;
    if (target === null || events.indexOf(target) >= labelIndex
      || target.event_type !== "message" || !["assistant", "agent"].includes(target.actor)
      || target.status !== "ok" || !ordinaryText(target)
      || reviewEvidenceFingerprint(target) !== label.targetEventSha256) {
      exclusions.push(exclusion(bundle.manifest.trace_id, recipe, [label.event.event_id],
        ["REWARD_TARGET_BINDING_INVALID_OR_MISSING"],
        "Verified pointwise reward requires an explicit, digest-bound completed assistant target; no positional inference is permitted."));
      continue;
    }
    const routeIssues = teacherRouteIssues(bundle, [target]);
    if (routeIssues.length > 0) {
      exclusions.push(exclusion(bundle.manifest.trace_id, recipe, [target.event_id, label.event.event_id], routeIssues,
        "Reward target does not match the manifest-approved primary Harness teacher route."));
      continue;
    }
    const targetIndex = events.indexOf(target);
    const result = conversation(events.slice(0, targetIndex + 1), new Set(), [], target.source_session_id);
    if (result.issues.length > 0) {
      exclusions.push(exclusion(bundle.manifest.trace_id, recipe, [target.event_id, label.event.event_id], result.issues,
        "Verified reward context could not be compiled without altering canonical content."));
      continue;
    }
    const provenance: TrainingViewVerifierProvenance = {
      label_kind: "verified_pointwise_reward",
      source_event_id: label.event.event_id,
      reward: label.reward,
      verifier: label.verifier,
      confirmation: {
        schema_version: label.confirmation.schema_version,
        reviewer: label.confirmation.reviewer,
        evidence_ref: label.confirmation.evidence_ref,
        confirmed_at: label.confirmation.confirmed_at,
        event_sha256: label.confirmation.event_sha256,
      },
    };
    views.push(compiledView({
      trace_id: bundle.manifest.trace_id,
      recipe,
      objective: "pointwise_reward",
      target_event_ids: [target.event_id],
      evidence_event_ids: [label.event.event_id],
      source_event_ids: uniqueInOrder([...contextSourceIds(result, []), label.event.event_id]),
      messages: result.messages,
      tools: result.tools,
      loss_targets: [],
      reward: label.reward,
      verifier_provenance: provenance,
      metadata: {
        label_semantics: "verified_pointwise_reward",
        explicit_target_event_id: label.targetEventId,
        explicit_target_event_sha256: label.targetEventSha256,
        preference_pair: null,
        step_rewards: [],
        synthetic_preference_pair: false,
        synthetic_step_reward: false,
        dropped_context_event_ids: result.droppedContextEventIds,
      },
    }));
  }
  if (views.length === 0 && exclusions.length === 0) {
    exclusions.push(exclusion(bundle.manifest.trace_id, recipe, [], ["NO_VERIFIED_REWARD_CANDIDATE"],
      "No concrete numeric reward with versioned verifier evidence and reviewer confirmation is present."));
  }
  return { views, exclusions };
}

function prerequisites(bundle: TraceBundle): string[] {
  const reasons: string[] = [];
  if (bundle.manifest.lineage.tombstoned) reasons.push("TRACE_TOMBSTONED");
  if (bundle.manifest.review.automated_checks !== "passed") reasons.push("AUTOMATED_CHECKS_NOT_PASSED");
  if (bundle.manifest.review.human_approval !== "approved") reasons.push("HUMAN_APPROVAL_REQUIRED");
  const approval = bundle.manifest.review.approval_scope;
  if (approval === null) {
    reasons.push("APPROVAL_SCOPE_REQUIRED");
  } else {
    if (approval.bundle_sha256 !== approvalFingerprint(bundle)) reasons.push("APPROVAL_SCOPE_STALE");
    if (!approval.decisions.some((decision) => decision.mode === "training_noncompetitive"
      || decision.mode === "training_competitive_distillation")) {
      reasons.push("TRAINING_APPROVAL_SCOPE_REQUIRED");
    }
  }
  if (bundle.events.some((event) => event.trace_id !== bundle.manifest.trace_id)) reasons.push("EVENT_TRACE_ID_MISMATCH");
  if (bundle.manifest.source.host === "deepseek_harness" && bundle.raw.some((envelope) => {
    const identity = rawHarnessIdentity(envelope.payload);
    return identity?.firstLiveSeq !== null && identity?.firstLiveSeq !== 0;
  })) reasons.push("DEEPSEEK_RESUMED_CONTEXT_INCOMPLETE");
  return reasons.sort();
}

function compileRecipe(bundle: TraceBundle, recipe: TrainingViewRecipe) {
  const events = orderedEvents(bundle);
  switch (recipe) {
    case "answer_sft": return answerViews(bundle, events);
    case "reasoning_sft": return reasoningViews(bundle, events);
    case "tool_use_sft": return toolViews(bundle, events);
    case "deepseek_epoch_sft": return deepSeekEpochViews(bundle);
    case "failure_recovery": return recoveryViews(bundle, events);
    case "subagent_handoff": return handoffViews(bundle, events);
    case "pointwise_reward_rl_ready": return rlReadyViews(bundle, events);
  }
}

export function compileTrainingView(
  input: TraceBundle,
  recipe: TrainingViewRecipe,
): TrainingViewCompilation {
  const bundle = traceBundleSchema.parse(input);
  const blocking = prerequisites(bundle);
  const result = blocking.length > 0
    ? {
      views: [] as CompiledTrainingView[],
      exclusions: [exclusion(bundle.manifest.trace_id, recipe, [], blocking,
        "Trace-level review prerequisites block every training candidate.")],
    }
    : compileRecipe(bundle, recipe);
  const base = {
    schema_version: "training-view-compilation/0.1" as const,
    trace_id: bundle.manifest.trace_id,
    recipe,
    recipe_version: TRAINING_VIEW_RECIPE_VERSIONS[recipe],
    compiler_version: TRAINING_VIEW_COMPILER_VERSION,
    views: result.views,
    exclusions: result.exclusions,
  };
  return { ...base, compilation_sha256: sha256(canonicalJson(base)) };
}

export function compileTrainingViews(
  input: TraceBundle,
  recipes: readonly TrainingViewRecipe[] = ALL_RECIPES,
): TrainingViewCompilation[] {
  const uniqueRecipes = [...new Set(recipes)];
  return uniqueRecipes.map((recipe) => compileTrainingView(input, recipe));
}
