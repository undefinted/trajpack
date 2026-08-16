import type { Host, RawEnvelope, TrajectoryEvent } from "@trajpack/schema";

import {
  CLAUDE_HOOK_INTERFACE,
  CLAUDE_STREAM_INTERFACE,
  normalizeClaudeHook,
  normalizeClaudeStreamEvent,
} from "./claude.js";
import { createRawEnvelope, isRecord, type NormalizeOptions } from "./common.js";
import {
  CODEX_APP_SERVER_INTERFACE_VERSION,
  CODEX_HOOK_INTERFACE_VERSION,
  CODEX_JSONL_INTERFACE_VERSION,
  createCodexAppServerRawEnvelope,
  isCodexAppServerMessage,
  normalizeCodexAppServerEvent,
  normalizeCodexHook,
  normalizeCodexJsonEvent,
} from "./codex.js";
import {
  DEEPSEEK_HARNESS_INTERFACE_VERSION,
  normalizeDeepSeekSessionEvent,
} from "./deepseek.js";
import {
  GEMINI_CLI_HOOK_INTERFACE_VERSION,
  normalizeGeminiCliHook,
} from "./gemini.js";
import { normalizeAuthorizedDomCapture, normalizeManualImport } from "./imported.js";

export * from "./common.js";
export * from "./codex.js";
export * from "./claude.js";
export * from "./deepseek.js";
export * from "./gemini.js";
export * from "./imported.js";

export interface NormalizationContext {
  traceId: string;
  nextSequence: number;
}

export const CLAUDE_TRANSCRIPT_OPAQUE_INTERFACE_VERSION = "claude-transcript-opaque/1";

const DEFAULT_INTERFACES: Partial<Record<Host, string>> = {
  codex: CODEX_JSONL_INTERFACE_VERSION,
  claude_code: CLAUDE_STREAM_INTERFACE,
  gemini_cli: GEMINI_CLI_HOOK_INTERFACE_VERSION,
  deepseek_harness: DEEPSEEK_HARNESS_INTERFACE_VERSION,
  browser: "authorized-dom-capture/1",
  manual_import: "manual-import/1",
};

/**
 * Parses one official host JSONL record into the raw in-memory envelope used by
 * the encrypted collector. Invalid JSON, non-object JSON, and unsupported hosts
 * return null. This function never writes or logs the payload.
 */
export function classifyJsonLine(host: Host, line: string, sequence: number, declaredInterface?: string): RawEnvelope | null {
  const interfaceVersion = DEFAULT_INTERFACES[host];
  if (interfaceVersion === undefined || line.trim().length === 0) return null;
  try {
    const payload: unknown = JSON.parse(line);
    if (!isRecord(payload)) return null;
    if (declaredInterface !== undefined) {
      const allowed = host === "codex"
        ? [CODEX_JSONL_INTERFACE_VERSION, CODEX_HOOK_INTERFACE_VERSION, CODEX_APP_SERVER_INTERFACE_VERSION]
        : host === "claude_code"
          ? [CLAUDE_STREAM_INTERFACE, CLAUDE_HOOK_INTERFACE]
          : host === "gemini_cli"
            ? [GEMINI_CLI_HOOK_INTERFACE_VERSION]
          : host === "deepseek_harness"
            ? [DEEPSEEK_HARNESS_INTERFACE_VERSION]
            : [];
      if (!allowed.includes(declaredInterface)) return null;
      if (declaredInterface === CODEX_APP_SERVER_INTERFACE_VERSION && !isCodexAppServerMessage(payload)) return null;
      return createRawEnvelope(host, payload, { sequence, interfaceVersion: declaredInterface }, declaredInterface);
    }
    if (host === "codex" && isCodexAppServerMessage(payload)) {
      return createCodexAppServerRawEnvelope(payload, { sequence });
    }
    return createRawEnvelope(host, payload, { sequence }, interfaceVersion);
  } catch {
    return null;
  }
}

/**
 * Deterministically maps an already-encrypted/ingested raw envelope into the
 * canonical event view. The caller supplies the trace and next global sequence.
 */
export function normalizeRawEnvelope(envelope: RawEnvelope, context: NormalizationContext): TrajectoryEvent[] {
  // Claude Code's internal JSONL transcript is retained solely as an encrypted,
  // opaque provenance artifact. Its private schema is intentionally never read
  // or interpreted by the normalizer.
  if (
    envelope.adapter === "claude_code" &&
    envelope.interface_version === CLAUDE_TRANSCRIPT_OPAQUE_INTERFACE_VERSION
  ) {
    return [];
  }
  if (
    envelope.adapter === "gemini_cli" &&
    envelope.interface_version !== GEMINI_CLI_HOOK_INTERFACE_VERSION
  ) {
    return [];
  }
  if (
    envelope.adapter === "deepseek_harness" &&
    envelope.interface_version !== DEEPSEEK_HARNESS_INTERFACE_VERSION
  ) {
    return [];
  }
  if (
    envelope.adapter === "claude_code" &&
    envelope.interface_version !== CLAUDE_STREAM_INTERFACE &&
    envelope.interface_version !== CLAUDE_HOOK_INTERFACE
  ) {
    return [];
  }
  if (
    envelope.adapter === "codex" &&
    envelope.interface_version !== CODEX_JSONL_INTERFACE_VERSION &&
    envelope.interface_version !== CODEX_HOOK_INTERFACE_VERSION &&
    envelope.interface_version !== CODEX_APP_SERVER_INTERFACE_VERSION
  ) {
    return [];
  }

  const options: NormalizeOptions = {
    traceId: context.traceId,
    sequence: envelope.sequence,
    capturedAt: envelope.captured_at,
    adapterVersion: envelope.adapter_version,
    interfaceVersion: envelope.interface_version,
  };
  if (envelope.session_id !== null) options.sessionId = envelope.session_id;
  if (envelope.turn_id !== null) options.turnId = envelope.turn_id;

  const capture = envelope.adapter === "codex"
    ? envelope.interface_version === CODEX_HOOK_INTERFACE_VERSION
      ? normalizeCodexHook(envelope.payload, options)
      : envelope.interface_version === CODEX_APP_SERVER_INTERFACE_VERSION
        ? normalizeCodexAppServerEvent(envelope.payload, options)
        : normalizeCodexJsonEvent(envelope.payload, options)
    : envelope.adapter === "claude_code"
      ? envelope.interface_version.includes("hook")
        ? normalizeClaudeHook(envelope.payload, options)
        : normalizeClaudeStreamEvent(envelope.payload, options)
      : envelope.adapter === "gemini_cli"
        ? normalizeGeminiCliHook(envelope.payload, options)
      : envelope.adapter === "deepseek_harness"
        ? normalizeDeepSeekSessionEvent(envelope.payload, options)
        : envelope.adapter === "browser"
          ? normalizeAuthorizedDomCapture(envelope.payload, options)
          : envelope.adapter === "manual_import"
            ? normalizeManualImport(envelope.payload, options)
            : { raw: envelope, events: [] };

  return capture.events.map((event, index) => {
    // Provider payloads are untrusted and may contain arbitrary metadata. The
    // trajpack_* namespace is reserved for local deterministic/reviewer passes;
    // accepting it here would let a provider forge approvals or verifier labels.
    const providerMetadata = Object.fromEntries(
      Object.entries(event.metadata).filter(([key]) => !key.startsWith("trajpack_")),
    );
    return {
      ...event,
      event_id: event.source_event_id === null && envelope.source_event_id !== null
        ? `${envelope.adapter}:${envelope.source_event_id}:${event.event_type}:${index}`
        : event.event_id,
      trace_id: context.traceId,
      sequence: context.nextSequence + index,
      source_event_id: event.source_event_id ?? envelope.source_event_id,
      source_session_id: event.source_session_id ?? envelope.session_id,
      source_turn_id: event.source_turn_id ?? envelope.turn_id,
      metadata: {
        ...providerMetadata,
        raw_payload_sha256: envelope.payload_sha256,
        adapter_version: envelope.adapter_version,
        interface_version: envelope.interface_version,
      },
    };
  });
}
