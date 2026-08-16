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
import { normalizeRawEnvelope } from "@trajpack/adapters";

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
}

type JsonRecord = Record<string, unknown>;

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

/**
 * Reconcile a claimed Harness teacher with the durable request/header event.
 * Local process observation is not a provider signature, but it prevents a
 * CLI model label from silently disagreeing with the model actually requested
 * through the pinned Harness event surface.
 */
export function reconcileObservedHarnessTeacher(source: Source, raw: readonly RawEnvelope[]): Source {
  if (source.host !== "deepseek_harness") return source;
  const observations: Array<{ provider: string; model: string; payload_sha256: string }> = [];
  for (const envelope of raw) {
    if (envelope.adapter !== "deepseek_harness"
      || envelope.interface_version !== "deepseek-harness@0.1.0-rc.6/session-event/0") continue;
    const payload = record(envelope.payload);
    if (!payload) continue;
    const event = record(payload.event) ?? payload;
    const body = record(event.data) ?? event;
    const type = firstNestedString([body, event, payload], ["type", "event_type", "eventType"]);
    if (type !== "request/header") continue;
    const header = record(body.header) ?? record(event.header);
    const request = record(body.request) ?? record(event.request);
    const config = record(body.config) ?? record(request?.config);
    const providerObject = record(body.provider) ?? record(header?.provider) ?? record(request?.provider);
    const model = firstNestedString(
      [body, header, request, config, providerObject],
      ["model", "model_id", "modelId", "model_name", "modelName"],
    );
    const provider = typeof body.provider === "string"
      ? body.provider.trim()
      : firstNestedString(
        [body, header, request, providerObject],
        ["provider_id", "providerId", "provider_name", "providerName", "id", "name"],
      );
    if (provider && model) observations.push({ provider, model, payload_sha256: envelope.payload_sha256 });
  }
  if (observations.length === 0) {
    return source.provider === "deepseek"
      ? { ...source, authenticity_evidence_ref: null }
      : source;
  }
  const providers = new Set(observations.map(({ provider }) => provider.toLowerCase()));
  const models = new Set(observations.map(({ model }) => model));
  if (providers.size !== 1 || models.size !== 1) throw new Error("Harness teacher provenance conflicts across request headers");
  const observedProvider = [...providers][0]!;
  const observedModel = [...models][0]!;
  if (source.model_id !== null && source.model_id !== observedModel) {
    throw new Error("Declared teacher model does not match the Harness request header");
  }
  if (source.provider === "deepseek" && observedProvider !== "deepseek") {
    throw new Error("Declared teacher provider does not match the Harness request header");
  }
  return {
    ...source,
    model_id: source.model_id ?? observedModel,
    ...(source.provider === "deepseek" ? {
      authenticity_evidence_ref: `native-request-header:sha256:${sha256(canonicalJson(observations))}`,
    } : {}),
  };
}

function positiveLimit(value: number | undefined, label: string): number {
  if (value === undefined) return Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

export class CaptureSession {
  private readonly raw: RawEnvelope[] = [];
  private readonly dedupe = new Set<string>();
  private operationQueue: Promise<void> = Promise.resolve();
  private operationFailure: unknown = null;
  private rawBytes = 0;
  private readonly maxRawEvents: number;
  private readonly maxRawBytes: number;
  private finalized = false;

  private constructor(
    readonly host: Host,
    readonly manifest: TraceManifest,
    private readonly writer: VaultWriter,
    limits: CaptureSessionLimits,
  ) {
    this.maxRawEvents = positiveLimit(limits.maxRawEvents, "Capture maxRawEvents");
    this.maxRawBytes = positiveLimit(limits.maxRawBytes, "Capture maxRawBytes");
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
    const operation = this.operationQueue.then(async () => {
      if (this.operationFailure !== null) throw this.operationFailure;
      return this.ingestExclusive(input);
    });
    this.operationQueue = operation.then(
      () => undefined,
      (error: unknown) => { this.operationFailure = error; },
    );
    return operation;
  }

  private async ingestExclusive(input: unknown): Promise<boolean> {
    const parsed = rawEnvelopeSchema.parse(input);
    if (parsed.adapter !== this.host) throw new Error(`Envelope adapter ${parsed.adapter} does not match ${this.host}`);
    if (sha256(canonicalJson(parsed.payload)) !== parsed.payload_sha256) throw new Error("Raw envelope payload hash mismatch");
    const key = parsed.source_event_id
      ? `${parsed.adapter}:${parsed.source_event_id}`
      : `${parsed.adapter}:${parsed.payload_sha256}`;
    if (this.dedupe.has(key)) return false;
    // `sequence` is the append-only vault order. Provider/channel-local order
    // remains inside the opaque payload/source identifiers; assigning it here
    // prevents two concurrently observed official channels from colliding.
    const envelope: RawEnvelope = { ...parsed, sequence: this.raw.length };
    const envelopeBytes = Buffer.byteLength(canonicalJson(envelope), "utf8");
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
    this.dedupe.add(key);
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
        for (const candidate of normalizeRawEnvelope(envelope, { traceId: this.manifest.trace_id, nextSequence })) {
          const event = trajectoryEventSchema.parse(candidate);
          nextSequence = Math.max(nextSequence, event.sequence + 1);
          if (eventIds.has(event.event_id)) continue;
          eventIds.add(event.event_id);
          events.push(event);
        }
      }
      events.sort((left, right) => left.sequence - right.sequence
        || (left.event_id < right.event_id ? -1 : left.event_id > right.event_id ? 1 : 0));
      const observed = observedRawSource(this.raw);
      const observedSource = reconcileObservedHarnessTeacher(this.manifest.source, this.raw);
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
            raw_sha256: sha256(canonicalJson(this.raw)),
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
