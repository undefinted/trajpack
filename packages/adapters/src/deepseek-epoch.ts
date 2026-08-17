import {
  DEEPSEEK_HARNESS_DURABLE_EVENT_TYPES,
  DEEPSEEK_HARNESS_SESSION_FORMAT_VERSION,
} from "./deepseek.js";
import { firstString, isRecord, nestedRecord, sha256, stableJson } from "./common.js";

export const DEEPSEEK_EPOCH_COMPILER_VERSION = "dsh-epoch/0.1" as const;

type JsonObject = Record<string, unknown>;

export interface DeepSeekEpochMessage {
  surface_seq: number;
  event_type: "user/message" | "assistant/message" | "tool/result";
  role: "user" | "assistant" | "tool";
  message: JsonObject;
  message_sha256: string;
  source_event_seqs: number[] | null;
}

export interface DeepSeekRequestEpoch {
  schema_version: typeof DEEPSEEK_EPOCH_COMPILER_VERSION;
  epoch_id: string;
  session_id: string;
  parent_session_id: string | null;
  turn: number;
  step: number;
  request_header_seq: number;
  output_event_seq: number;
  provider: string;
  model: string;
  config: JsonObject;
  adapter_defaults: JsonObject | null;
  system: string | null;
  tools: JsonObject[];
  surface_before: DeepSeekEpochMessage[];
  output_message: JsonObject;
  output_source_event_seqs: number[] | null;
  input_sha256: string;
  output_sha256: string;
  reconstructable: boolean;
  exclusion_reasons: string[];
}

export interface DeepSeekEpochDiagnostic {
  session_id: string | null;
  seq: number | null;
  severity: "warning" | "error";
  code:
    | "invalid_capsule"
    | "sequence_does_not_start_at_zero"
    | "sequence_gap_or_duplicate"
    | "unknown_required_event"
    | "unknown_ignorable_event"
    | "surface_operation_missing"
    | "surface_replace_invalid"
    | "surface_sources_incomplete"
    | "request_header_missing"
    | "request_route_missing"
    | "output_route_missing"
    | "output_route_mismatch"
    | "step_boundary_mismatch";
}

export interface DeepSeekEpochCompilation {
  compiler_version: typeof DEEPSEEK_EPOCH_COMPILER_VERSION;
  complete: boolean;
  epochs: DeepSeekRequestEpoch[];
  diagnostics: DeepSeekEpochDiagnostic[];
}

interface ParsedCapsule {
  sessionId: string;
  parentSessionId: string | null;
  event: JsonObject;
  data: JsonObject;
  type: string;
  seq: number;
}

interface HeaderState {
  seq: number;
  config: JsonObject;
  adapterDefaults: JsonObject | null;
  system: string | null;
  tools: JsonObject[];
}

interface SessionState {
  sessionId: string;
  parentSessionId: string | null;
  expectedSeq: number;
  blocked: boolean;
  header: HeaderState | null;
  route: { provider: string; model: string } | null;
  surface: number[];
  surfaceEvents: Map<number, ParsedCapsule>;
  activeTurn: number | null;
  activeStep: number | null;
}

const KNOWN_DURABLE_EVENTS = new Set<string>(DEEPSEEK_HARNESS_DURABLE_EVENT_TYPES);
const SURFACE_EVENTS = new Set(["user/message", "assistant/message", "tool/result"]);

function jsonClone<T>(value: T): T {
  return JSON.parse(stableJson(value)) as T;
}

function safeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function parseCapsule(value: unknown): ParsedCapsule | null {
  if (!isRecord(value)) return null;
  const header = nestedRecord(value, "session_header");
  const event = nestedRecord(value, "event");
  const data = event === null ? null : nestedRecord(event, "data");
  const sessionId = firstString(value, ["session_id"]);
  const type = event === null ? null : firstString(event, ["type"]);
  const seq = event === null ? null : safeInteger(event.seq);
  if (
    header === null || event === null || data === null || sessionId === null || type === null || seq === null ||
    header.version !== DEEPSEEK_HARNESS_SESSION_FORMAT_VERSION || firstString(header, ["id"]) !== sessionId ||
    (event.ignorable !== undefined && event.ignorable !== true)
  ) return null;
  return {
    sessionId,
    parentSessionId: firstString(header, ["parent_session"]),
    event,
    data,
    type,
    seq,
  };
}

function messageForSurface(info: ParsedCapsule): JsonObject | null {
  if (info.type === "user/message") return info.data;
  return nestedRecord(info.data, "message");
}

function sourceEventSeqs(event: JsonObject): number[] | null {
  if (!Array.isArray(event.sourceEventSeqs)) return null;
  const values = event.sourceEventSeqs.map(safeInteger);
  if (values.some((value) => value === null)) return null;
  return [...new Set(values as number[])].sort((left, right) => left - right);
}

function surfaceMessage(info: ParsedCapsule): DeepSeekEpochMessage | null {
  const message = messageForSurface(info);
  if (message === null) return null;
  return {
    surface_seq: info.seq,
    event_type: info.type as DeepSeekEpochMessage["event_type"],
    role: info.type === "assistant/message" ? "assistant" : info.type === "tool/result" ? "tool" : "user",
    message: jsonClone(message),
    message_sha256: sha256(message),
    source_event_seqs: sourceEventSeqs(info.event),
  };
}

function addDiagnostic(
  diagnostics: DeepSeekEpochDiagnostic[],
  info: ParsedCapsule | null,
  severity: DeepSeekEpochDiagnostic["severity"],
  code: DeepSeekEpochDiagnostic["code"],
): void {
  diagnostics.push({
    session_id: info?.sessionId ?? null,
    seq: info?.seq ?? null,
    severity,
    code,
  });
}

function applySurface(
  state: SessionState,
  info: ParsedCapsule,
  diagnostics: DeepSeekEpochDiagnostic[],
): void {
  const message = messageForSurface(info);
  if (message === null) {
    state.blocked = true;
    addDiagnostic(diagnostics, info, "error", "surface_operation_missing");
    return;
  }
  const operation = info.event.surfaceOp;
  if (operation === "append") {
    state.surface.push(info.seq);
    state.surfaceEvents.set(info.seq, info);
    return;
  }
  if (!isRecord(operation) || operation.op !== "replace") {
    state.blocked = true;
    addDiagnostic(diagnostics, info, "error", "surface_operation_missing");
    return;
  }
  const start = safeInteger(operation.start);
  const end = safeInteger(operation.end);
  const startIndex = start === null ? -1 : state.surface.indexOf(start);
  const endIndex = end === null ? -1 : state.surface.indexOf(end);
  if (startIndex < 0 || endIndex < startIndex) {
    state.blocked = true;
    addDiagnostic(diagnostics, info, "error", "surface_replace_invalid");
    return;
  }
  const shadowed = state.surface.slice(startIndex, endIndex + 1);
  const sources = sourceEventSeqs(info.event);
  if (sources === null || shadowed.some((seq) => !sources.includes(seq))) {
    state.blocked = true;
    addDiagnostic(diagnostics, info, "error", "surface_sources_incomplete");
    return;
  }
  state.surface.splice(startIndex, endIndex - startIndex + 1, info.seq);
  state.surfaceEvents.set(info.seq, info);
}

function headerFrom(info: ParsedCapsule): HeaderState | null {
  const header = nestedRecord(info.data, "header");
  const config = header === null ? null : nestedRecord(header, "config");
  if (header === null || config === null) return null;
  const tools = Array.isArray(header.tools)
    ? header.tools.filter(isRecord).map((tool) => jsonClone(tool))
    : [];
  return {
    seq: info.seq,
    config: jsonClone(config),
    adapterDefaults: nestedRecord(header, "adapterDefaults") === null
      ? null
      : jsonClone(nestedRecord(header, "adapterDefaults")!),
    system: typeof header.system === "string" ? header.system : null,
    tools,
  };
}

function routeFromConfig(config: JsonObject): { provider: string; model: string } | null {
  const provider = firstString(config, ["provider"]);
  const model = firstString(config, ["model"]);
  return provider === null || model === null ? null : { provider, model };
}

function createEpoch(
  state: SessionState,
  info: ParsedCapsule,
  diagnostics: DeepSeekEpochDiagnostic[],
): DeepSeekRequestEpoch {
  const header = state.header;
  const turn = safeInteger(info.data.turn);
  const step = safeInteger(info.data.step);
  const reasons: string[] = [];
  if (header === null) {
    reasons.push("request_header_missing");
    addDiagnostic(diagnostics, info, "error", "request_header_missing");
  }
  const route = header === null ? null : routeFromConfig(header.config) ?? state.route;
  if (route === null) {
    reasons.push("request_route_missing");
    addDiagnostic(diagnostics, info, "error", "request_route_missing");
  }
  if (turn === null || step === null || state.activeTurn !== turn || state.activeStep !== step) {
    reasons.push("step_boundary_mismatch");
    addDiagnostic(diagnostics, info, "error", "step_boundary_mismatch");
  }
  if (state.blocked) reasons.push("session_reconstruction_blocked");

  const surfaceBefore = state.surface
    .map((seq) => state.surfaceEvents.get(seq))
    .filter((value): value is ParsedCapsule => value !== undefined)
    .map(surfaceMessage)
    .filter((value): value is DeepSeekEpochMessage => value !== null);
  const output = nestedRecord(info.data, "message") ?? {};
  const requestHeaderSeq = header?.seq ?? -1;
  const provider = route?.provider ?? "unknown";
  const model = route?.model ?? "unknown";
  const outputSource = nestedRecord(output, "source");
  const outputProvider = outputSource?.kind === "model" ? firstString(outputSource, ["provider"]) : null;
  const outputModel = outputSource?.kind === "model" ? firstString(outputSource, ["model"]) : null;
  if (outputProvider === null || outputModel === null) {
    reasons.push("output_route_missing");
    addDiagnostic(diagnostics, info, "error", "output_route_missing");
  } else if (outputProvider !== provider || outputModel !== model) {
    reasons.push("output_route_mismatch");
    addDiagnostic(diagnostics, info, "error", "output_route_mismatch");
  }
  const input = {
    request_header_seq: requestHeaderSeq,
    config: header?.config ?? {},
    adapter_defaults: header?.adapterDefaults ?? null,
    system: header?.system ?? null,
    tools: header?.tools ?? [],
    surface: surfaceBefore.map((message) => ({
      seq: message.surface_seq,
      type: message.event_type,
      message_sha256: message.message_sha256,
    })),
  };
  return {
    schema_version: DEEPSEEK_EPOCH_COMPILER_VERSION,
    epoch_id: sha256({ compiler: DEEPSEEK_EPOCH_COMPILER_VERSION, session: state.sessionId, seq: info.seq }),
    session_id: state.sessionId,
    parent_session_id: state.parentSessionId,
    turn: turn ?? -1,
    step: step ?? -1,
    request_header_seq: requestHeaderSeq,
    output_event_seq: info.seq,
    provider,
    model,
    config: jsonClone(header?.config ?? {}),
    adapter_defaults: header?.adapterDefaults === null || header?.adapterDefaults === undefined
      ? null
      : jsonClone(header.adapterDefaults),
    system: header?.system ?? null,
    tools: jsonClone(header?.tools ?? []),
    surface_before: surfaceBefore,
    output_message: jsonClone(output),
    output_source_event_seqs: sourceEventSeqs(info.event),
    input_sha256: sha256(input),
    output_sha256: sha256(output),
    reconstructable: reasons.length === 0,
    exclusion_reasons: reasons,
  };
}

/**
 * Replays pinned DeepSeek Harness session/event capsules into the exact
 * model-visible surface that preceded each assembled assistant message.
 *
 * This is intentionally a strict compiler rather than a transcript parser:
 * sequence gaps, unknown required records, invalid replace operations, missing
 * request headers, and turn/step mismatches make the affected epoch
 * non-trainable. Raw capsules remain the source of truth in the encrypted vault.
 */
export function compileDeepSeekRequestEpochs(values: readonly unknown[]): DeepSeekEpochCompilation {
  const diagnostics: DeepSeekEpochDiagnostic[] = [];
  const epochs: DeepSeekRequestEpoch[] = [];
  const sessions = new Map<string, SessionState>();

  for (const value of values) {
    const info = parseCapsule(value);
    if (info === null) {
      addDiagnostic(diagnostics, null, "error", "invalid_capsule");
      continue;
    }
    let state = sessions.get(info.sessionId);
    if (state === undefined) {
      state = {
        sessionId: info.sessionId,
        parentSessionId: info.parentSessionId,
        expectedSeq: info.seq,
        blocked: false,
        header: null,
        route: null,
        surface: [],
        surfaceEvents: new Map(),
        activeTurn: null,
        activeStep: null,
      };
      sessions.set(info.sessionId, state);
      if (info.seq !== 0) {
        state.blocked = true;
        addDiagnostic(diagnostics, info, "error", "sequence_does_not_start_at_zero");
      }
    }
    if (info.seq !== state.expectedSeq) {
      state.blocked = true;
      addDiagnostic(diagnostics, info, "error", "sequence_gap_or_duplicate");
    }
    state.expectedSeq = info.seq + 1;

    if (!KNOWN_DURABLE_EVENTS.has(info.type)) {
      if (info.event.ignorable === true) {
        addDiagnostic(diagnostics, info, "warning", "unknown_ignorable_event");
      } else {
        state.blocked = true;
        addDiagnostic(diagnostics, info, "error", "unknown_required_event");
      }
      continue;
    }

    if (info.type === "request/header") {
      state.header = headerFrom(info);
      if (state.header !== null) state.route = routeFromConfig(state.header.config) ?? state.route;
    } else if (info.type === "request/context") {
      const provider = firstString(info.data, ["provider"]);
      const model = firstString(info.data, ["model"]);
      if (provider !== null && model !== null) state.route = { provider, model };
    } else if (info.type === "turn/start") {
      state.activeTurn = safeInteger(info.data.turn);
      state.activeStep = null;
    } else if (info.type === "step/start") {
      state.activeTurn = safeInteger(info.data.turn);
      state.activeStep = safeInteger(info.data.step);
    } else if (info.type === "assistant/message") {
      epochs.push(createEpoch(state, info, diagnostics));
    } else if (info.type === "step/end") {
      const turn = safeInteger(info.data.turn);
      const step = safeInteger(info.data.step);
      if (turn !== state.activeTurn || step !== state.activeStep) {
        state.blocked = true;
        addDiagnostic(diagnostics, info, "error", "step_boundary_mismatch");
      }
      state.activeStep = null;
    } else if (info.type === "turn/end") {
      state.activeTurn = null;
      state.activeStep = null;
    }

    if (SURFACE_EVENTS.has(info.type)) applySurface(state, info, diagnostics);
  }

  epochs.sort((left, right) => left.session_id < right.session_id ? -1
    : left.session_id > right.session_id ? 1
      : left.output_event_seq - right.output_event_seq);
  return {
    compiler_version: DEEPSEEK_EPOCH_COMPILER_VERSION,
    complete: diagnostics.every((diagnostic) => diagnostic.severity !== "error")
      && epochs.every((epoch) => epoch.reconstructable),
    epochs,
    diagnostics,
  };
}
