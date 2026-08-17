import { createHash, type Hash } from "node:crypto";
import { stat } from "node:fs/promises";
import type { Host, RawEnvelope, Source, TraceBundle, TraceManifest, TrajectoryEvent } from "@trajpack/schema";
import { rawEnvelopeSchema, trajectoryEventSchema } from "@trajpack/schema";
import {
  VaultWriter,
  VaultSizeLimitError,
  applyAutomatedReview,
  canonicalJson,
  observedRawSource,
  sanitizeBundle,
  sha256,
  vaultPath,
  type TrajpackPaths,
} from "@trajpack/core";
import {
  CLAUDE_TRANSCRIPT_OPAQUE_INTERFACE_VERSION,
  DEEPSEEK_HARNESS_INTERFACE_VERSION,
  normalizeRawEnvelope,
} from "@trajpack/adapters";

export type CaptureLimitReason =
  | "CAPTURE_EVENT_LIMIT_EXCEEDED"
  | "CAPTURE_RAW_BYTE_LIMIT_EXCEEDED"
  | "CAPTURE_VAULT_LIMIT_EXCEEDED";

export class CaptureLimitError extends Error {
  constructor(readonly reason: CaptureLimitReason) {
    super(`Capture aborted by hard limit: ${reason}`);
    this.name = "CaptureLimitError";
  }
}

export interface CaptureSessionLimits {
  maxRawEvents?: number;
  maxRawBytes?: number;
  maxVaultBytes?: number;
  maxPendingIngest?: number;
}

export const DEFAULT_MAX_PENDING_CAPTURE_INGEST = 1024;
export const MAX_CONFIGURABLE_PENDING_CAPTURE_INGEST = 65_536;

export class CaptureBackpressureError extends Error {
  constructor(readonly limit: number) {
    super(`Capture ingest queue is full at ${limit} pending events`);
    this.name = "CaptureBackpressureError";
  }
}

type JsonRecord = Record<string, unknown>;

export type HarnessCaptureIntegrityReason =
  | "HARNESS_CAPSULE_INVALID"
  | "HARNESS_SEQUENCE_START_MISMATCH"
  | "HARNESS_SEQUENCE_GAP"
  | "HARNESS_SEQUENCE_CONFLICT";

export class HarnessCaptureIntegrityError extends Error {
  constructor(readonly reason: HarnessCaptureIntegrityReason) {
    super(`DeepSeek Harness capture quarantined: ${reason}`);
    this.name = "HarnessCaptureIntegrityError";
  }
}

interface HarnessCapsuleEvidence {
  payload: JsonRecord;
  event: JsonRecord;
  data: JsonRecord;
  header: JsonRecord;
  route: JsonRecord | null;
  sessionId: string;
  seq: number;
  firstLiveSeq: number;
  firstObservedSeq: number;
}

interface HarnessSequenceState {
  nextSeq: number;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function firstNestedString(containers: Array<JsonRecord | null>, keys: string[]): string | null {
  for (const container of containers) {
    if (!container) continue;
    for (const key of keys) {
      const value = container[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * Parse the exact live capsule emitted by the rc.6 plugin. `first_live_seq` is
 * the official Session.firstLiveSeq process boundary: it lets resumed sessions
 * start above zero without treating an actually missed live prefix as valid.
 */
function liveHarnessCapsule(envelope: RawEnvelope): HarnessCapsuleEvidence | null {
  if (envelope.adapter !== "deepseek_harness"
    || envelope.interface_version !== DEEPSEEK_HARNESS_INTERFACE_VERSION) return null;
  const payload = record(envelope.payload);
  const event = payload === null ? null : record(payload.event);
  const data = event === null ? null : record(event.data);
  const header = payload === null ? null : record(payload.session_header);
  const route = payload === null ? null : record(payload.route);
  const sessionId = payload === null ? null : firstNestedString([payload], ["session_id"]);
  const headerId = header === null ? null : firstNestedString([header], ["id"]);
  const eventId = payload === null ? null : firstNestedString([payload], ["event_id"]);
  const seq = event?.seq;
  const firstLiveSeq = header?.first_live_seq;
  const firstObservedSeq = header?.first_observed_seq;
  const boundaryMarker = record(header?.unpublished_boundary_marker);
  const seededBoundaryMarkerOmitted = boundaryMarker?.type === "session/end-seed"
    && nonNegativeSafeInteger(boundaryMarker.seq)
    && nonNegativeSafeInteger(firstLiveSeq) && nonNegativeSafeInteger(firstObservedSeq)
    && boundaryMarker.seq === firstLiveSeq && firstObservedSeq === firstLiveSeq + 1;
  if (
    payload === null || event === null || data === null || header === null || sessionId === null ||
    headerId !== sessionId || header.version !== 0 || !nonNegativeSafeInteger(seq) ||
    !nonNegativeSafeInteger(firstLiveSeq) || !nonNegativeSafeInteger(firstObservedSeq) ||
    (firstObservedSeq !== firstLiveSeq && !seededBoundaryMarkerOmitted) ||
    eventId !== `${sessionId}:${String(seq)}` ||
    envelope.session_id !== sessionId || envelope.source_event_id !== eventId
  ) {
    throw new HarnessCaptureIntegrityError("HARNESS_CAPSULE_INVALID");
  }
  return { payload, event, data, header, route, sessionId, seq, firstLiveSeq, firstObservedSeq };
}

function canonicalProviderRoute(value: string): Source["provider"] | null {
  const route = value.toLowerCase();
  if (route === "deepseek" || route.startsWith("deepseek-")) return "deepseek";
  if (route === "anthropic" || route.startsWith("anthropic-")
    || route === "claude" || route.startsWith("claude-")) return "anthropic";
  if (route === "google" || route.startsWith("google-")
    || route === "gemini" || route.startsWith("gemini-")) return "google";
  if (route === "openai" || route.startsWith("openai-")) return "openai";
  if (["local", "ollama", "lmstudio", "llama.cpp", "vllm", "sglang"].includes(route)
    || route.startsWith("local-") || route.startsWith("ollama-")) return "self_hosted";
  return null;
}

/**
 * Reconcile a claimed Harness teacher with the durable request/header event.
 * Local process observation is not a provider signature, but it prevents a
 * CLI model label from silently disagreeing with the model actually requested
 * through the pinned Harness event surface.
 */
export function reconcileObservedHarnessTeacher(source: Source, raw: readonly RawEnvelope[]): Source {
  if (source.host !== "deepseek_harness") return source;
  const observations: Array<{
    provider: string;
    model: string;
    route_provider: string | null;
    route_model: string | null;
    session_id: string;
    parent_session_id: string | null;
    delegation_depth: number | null;
    observed_order: number;
    request_seq: number;
    payload_sha256: string;
  }> = [];
  for (const [observedOrder, envelope] of raw.entries()) {
    if (envelope.adapter !== "deepseek_harness"
      || envelope.interface_version !== DEEPSEEK_HARNESS_INTERFACE_VERSION) continue;
    const capsule = liveHarnessCapsule(envelope);
    if (capsule === null) continue;
    const type = firstNestedString([capsule.event], ["type"]);
    if (type !== "request/header") continue;
    const requestHeader = record(capsule.data.header);
    const config = requestHeader === null ? null : record(requestHeader.config);
    const provider = firstNestedString([config], ["provider"]);
    const model = firstNestedString([config], ["model"]);
    if (provider === null || model === null) {
      throw new Error("Harness request header is missing the resolved provider/model route");
    }
    const routeProvider = firstNestedString([capsule.route], ["provider"]);
    const routeModel = firstNestedString([capsule.route], ["model"]);
    if (routeProvider === null || routeModel === null
      || routeProvider.toLowerCase() !== provider.toLowerCase()
      || routeModel !== model) {
      throw new Error("Harness capsule route conflicts with the durable request header");
    }
    observations.push({
      provider,
      model,
      route_provider: routeProvider,
      route_model: routeModel,
      session_id: capsule.sessionId,
      parent_session_id: firstNestedString([capsule.header], ["parent_session"]),
      delegation_depth: nonNegativeSafeInteger(capsule.header.delegation_depth)
        ? capsule.header.delegation_depth
        : null,
      observed_order: observedOrder,
      request_seq: capsule.seq,
      payload_sha256: envelope.payload_sha256,
    });
  }
  if (observations.length === 0) return source;
  const rootCandidates = observations.filter((observation) => observation.parent_session_id === null
    && (observation.delegation_depth === null || observation.delegation_depth === 0));
  const primarySessionId = (rootCandidates[0] ?? observations[0])!.session_id;
  const primaryObservations = observations.filter((observation) => observation.session_id === primarySessionId);
  // A Harness session may deliberately switch routes between request epochs.
  // Keep the complete inventory in the evidence digest, but bind the manifest's
  // singular teacher fields to the first durable request of the root session.
  // Training-view compilers independently bind each target to its request epoch
  // and fail closed when that epoch does not match the approved primary route.
  const primaryObservation = primaryObservations[0]!;
  const observedProvider = primaryObservation.provider.toLowerCase();
  const observedModel = primaryObservation.model;
  if (source.model_id !== null && source.model_id !== observedModel) {
    throw new Error("Declared teacher model does not match the Harness request header");
  }
  const canonicalObservedProvider = canonicalProviderRoute(observedProvider);
  if (source.provider !== "unknown" && canonicalObservedProvider !== source.provider) {
    throw new Error("Declared teacher provider does not match the Harness request header");
  }
  return {
    ...source,
    provider: source.provider === "unknown" && canonicalObservedProvider !== null
      ? canonicalObservedProvider
      : source.provider,
    model_id: source.model_id ?? observedModel,
    // A self-hosted teacher's content-bound weight digest is the stronger
    // identity proof and is required verbatim by policy. Its request route is
    // still present in encrypted raw lineage; do not replace the artifact ref.
    authenticity_evidence_ref: source.provider === "self_hosted"
      && source.model_snapshot_or_weights_digest !== null
      && source.authenticity_evidence_ref === `local-model-artifact:${source.model_snapshot_or_weights_digest}`
      ? source.authenticity_evidence_ref
      : `native-request-header:sha256:${sha256(canonicalJson({
        primary_session_id: primarySessionId,
        observations,
        prior_evidence_ref: source.authenticity_evidence_ref,
      }))}`,
  };
}

function positiveLimit(value: number | undefined, label: string): number {
  if (value === undefined) return Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

export class CaptureSession {
  private readonly raw: RawEnvelope[] = [];
  private readonly dedupe = new Map<string, string>();
  private readonly harnessSequences = new Map<string, HarnessSequenceState>();
  private operationQueue: Promise<void> = Promise.resolve();
  private operationFailure: unknown = null;
  private rawBytes = 0;
  private readonly rawLineageHash: Hash = createHash("sha256");
  private rawLineageStarted = false;
  private readonly maxRawEvents: number;
  private readonly maxRawBytes: number;
  private readonly maxPendingIngest: number;
  private pendingIngest = 0;
  private finalized = false;

  private constructor(
    readonly host: Host,
    readonly manifest: TraceManifest,
    private readonly writer: VaultWriter,
    limits: CaptureSessionLimits,
  ) {
    this.maxRawEvents = positiveLimit(limits.maxRawEvents, "Capture maxRawEvents");
    this.maxRawBytes = positiveLimit(limits.maxRawBytes, "Capture maxRawBytes");
    this.maxPendingIngest = positiveLimit(
      limits.maxPendingIngest ?? DEFAULT_MAX_PENDING_CAPTURE_INGEST,
      "Capture maxPendingIngest",
    );
    if (this.maxPendingIngest > MAX_CONFIGURABLE_PENDING_CAPTURE_INGEST) {
      throw new Error(`Capture maxPendingIngest must be at most ${MAX_CONFIGURABLE_PENDING_CAPTURE_INGEST}`);
    }
  }

  static async create(
    host: Host,
    manifest: TraceManifest,
    passphrase: string,
    paths?: TrajpackPaths,
    limits: CaptureSessionLimits = {},
  ): Promise<CaptureSession> {
    const target = vaultPath(manifest.trace_id, paths);
    await stat(target).then(
      () => { throw new Error(`Trace already exists: ${manifest.trace_id}`); },
      (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; },
    );
    const writer = await VaultWriter.create(
      target,
      passphrase,
      limits.maxVaultBytes === undefined ? {} : { maxFileBytes: limits.maxVaultBytes },
    );
    try {
      const session = new CaptureSession(host, manifest, writer, limits);
      await writer.append({ kind: "manifest", value: manifest });
      return session;
    } catch (error) {
      await writer.abort().catch(() => undefined);
      throw error;
    }
  }

  async ingest(input: unknown): Promise<boolean> {
    if (this.finalized) throw new Error("Capture is already finalized");
    if (this.pendingIngest >= this.maxPendingIngest) {
      throw new CaptureBackpressureError(this.maxPendingIngest);
    }
    this.pendingIngest += 1;
    const operation = this.operationQueue.then(async () => {
      if (this.operationFailure !== null) throw this.operationFailure;
      return this.ingestExclusive(input);
    });
    this.operationQueue = operation.then(
      () => undefined,
      (error: unknown) => { this.operationFailure = error; },
    );
    try {
      return await operation;
    } finally {
      this.pendingIngest -= 1;
    }
  }

  private async ingestExclusive(input: unknown): Promise<boolean> {
    const parsed = rawEnvelopeSchema.parse(input);
    if (parsed.adapter !== this.host) throw new Error(`Envelope adapter ${parsed.adapter} does not match ${this.host}`);
    if (sha256(canonicalJson(parsed.payload)) !== parsed.payload_sha256) throw new Error("Raw envelope payload hash mismatch");
    const key = parsed.source_event_id
      ? `${parsed.adapter}:${parsed.source_event_id}`
      : `${parsed.adapter}:${parsed.payload_sha256}`;
    const duplicateHash = this.dedupe.get(key);
    if (duplicateHash !== undefined) {
      if (duplicateHash === parsed.payload_sha256) return false;
      throw parsed.adapter === "deepseek_harness"
        ? new HarnessCaptureIntegrityError("HARNESS_SEQUENCE_CONFLICT")
        : new Error("Conflicting duplicate raw event identity");
    }
    const harnessCapsule = liveHarnessCapsule(parsed);
    let harnessState: HarnessSequenceState | null = null;
    if (harnessCapsule !== null) {
      harnessState = this.harnessSequences.get(harnessCapsule.sessionId) ?? null;
      if (harnessState === null) {
        if (harnessCapsule.seq !== harnessCapsule.firstObservedSeq) {
          throw new HarnessCaptureIntegrityError("HARNESS_SEQUENCE_START_MISMATCH");
        }
        harnessState = { nextSeq: harnessCapsule.firstObservedSeq };
        this.harnessSequences.set(harnessCapsule.sessionId, harnessState);
      }
      if (harnessCapsule.seq !== harnessState.nextSeq) {
        throw new HarnessCaptureIntegrityError(
          harnessCapsule.seq > harnessState.nextSeq ? "HARNESS_SEQUENCE_GAP" : "HARNESS_SEQUENCE_CONFLICT",
        );
      }
    }
    // `sequence` is the append-only vault order. Provider/channel-local order
    // remains inside the opaque payload/source identifiers; assigning it here
    // prevents two concurrently observed official channels from colliding.
    const envelope: RawEnvelope = { ...parsed, sequence: this.raw.length };
    const encodedEnvelope = canonicalJson(envelope);
    const envelopeBytes = Buffer.byteLength(encodedEnvelope, "utf8");
    if (this.raw.length + 1 > this.maxRawEvents) {
      throw new CaptureLimitError("CAPTURE_EVENT_LIMIT_EXCEEDED");
    }
    if (this.rawBytes + envelopeBytes > this.maxRawBytes) {
      throw new CaptureLimitError("CAPTURE_RAW_BYTE_LIMIT_EXCEEDED");
    }
    try {
      await this.writer.append({ kind: "raw", value: envelope });
    } catch (error) {
      if (error instanceof VaultSizeLimitError) {
        throw new CaptureLimitError("CAPTURE_VAULT_LIMIT_EXCEEDED");
      }
      throw error;
    }
    this.dedupe.set(key, parsed.payload_sha256);
    if (harnessCapsule !== null && harnessState !== null) {
      harnessState.nextSeq = harnessCapsule.seq + 1;
    }
    if (!this.rawLineageStarted) {
      this.rawLineageHash.update("[");
      this.rawLineageStarted = true;
    } else {
      this.rawLineageHash.update(",");
    }
    this.rawLineageHash.update(encodedEnvelope);
    this.raw.push(envelope);
    this.rawBytes += envelopeBytes;
    return true;
  }

  async finalize(): Promise<TraceBundle> {
    if (this.finalized) throw new Error("Capture is already finalized");
    this.finalized = true;
    try {
      await this.operationQueue;
      if (this.operationFailure !== null) throw this.operationFailure;
      const events: TrajectoryEvent[] = [];
      let nextSequence = 0;
      const eventIds = new Set<string>();
      for (const envelope of this.raw) {
        const normalized = normalizeRawEnvelope(envelope, { traceId: this.manifest.trace_id, nextSequence });
        if (normalized.length === 0
          && !(envelope.adapter === "claude_code"
            && envelope.interface_version === CLAUDE_TRANSCRIPT_OPAQUE_INTERFACE_VERSION)) {
          throw new Error(`Unsupported or incomplete ${envelope.adapter} event on pinned interface ${envelope.interface_version}`);
        }
        for (const candidate of normalized) {
          const event = trajectoryEventSchema.parse(candidate);
          nextSequence = Math.max(nextSequence, event.sequence + 1);
          if (eventIds.has(event.event_id)) continue;
          eventIds.add(event.event_id);
          events.push(event);
        }
      }
      if (this.raw.length === 0) {
        throw new Error("Capture produced no authoritative raw events; verify that the native plugin or structured stream is installed and enabled");
      }
      if (events.length === 0) {
        throw new Error("Capture produced no supported normalized events; verify the pinned host and adapter interface versions");
      }
      events.sort((left, right) => left.sequence - right.sequence
        || (left.event_id < right.event_id ? -1 : left.event_id > right.event_id ? 1 : 0));
      const observed = observedRawSource(this.raw);
      const observedSource = reconcileObservedHarnessTeacher(this.manifest.source, this.raw);
      if (!this.rawLineageStarted) this.rawLineageHash.update("[");
      this.rawLineageHash.update("]");
      const rawLineageSha256 = this.rawLineageHash.digest("hex");
      let bundle: TraceBundle = {
        manifest: {
          ...this.manifest,
          source: observed === null ? observedSource : {
            ...observedSource,
            interface_version: observed.interfaceVersion,
            adapter_version: observed.adapterVersion,
          },
          lineage: {
            ...this.manifest.lineage,
            raw_sha256: rawLineageSha256,
          },
        },
        raw: this.raw,
        events,
      };
      bundle = sanitizeBundle(bundle).bundle;
      bundle = applyAutomatedReview(bundle).bundle;
      for (const event of bundle.events) await this.writer.append({ kind: "event", value: event });
      await this.writer.append({ kind: "manifest", value: bundle.manifest });
      await this.writer.finalize();
      return bundle;
    } catch (error) {
      await this.writer.abort().catch(() => undefined);
      throw error;
    }
  }

  async abort(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;
    await this.operationQueue.catch(() => undefined);
    await this.writer.abort();
  }
}
