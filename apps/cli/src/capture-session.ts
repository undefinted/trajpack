import { stat } from "node:fs/promises";
import type { Host, RawEnvelope, TraceBundle, TraceManifest, TrajectoryEvent } from "@trajpack/schema";
import { rawEnvelopeSchema, trajectoryEventSchema } from "@trajpack/schema";
import {
  VaultWriter,
  applyAutomatedReview,
  canonicalJson,
  observedRawSource,
  sanitizeBundle,
  sha256,
  vaultPath,
  type TrajpackPaths,
} from "@trajpack/core";
import { normalizeRawEnvelope } from "@trajpack/adapters";

export class CaptureSession {
  private readonly raw: RawEnvelope[] = [];
  private readonly dedupe = new Set<string>();
  private appendQueue: Promise<void> = Promise.resolve();
  private finalized = false;

  private constructor(
    readonly host: Host,
    readonly manifest: TraceManifest,
    private readonly writer: VaultWriter,
  ) {}

  static async create(host: Host, manifest: TraceManifest, passphrase: string, paths?: TrajpackPaths): Promise<CaptureSession> {
    const target = vaultPath(manifest.trace_id, paths);
    await stat(target).then(
      () => { throw new Error(`Trace already exists: ${manifest.trace_id}`); },
      (error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; },
    );
    const writer = await VaultWriter.create(target, passphrase);
    const session = new CaptureSession(host, manifest, writer);
    await writer.append({ kind: "manifest", value: manifest });
    return session;
  }

  async ingest(input: unknown): Promise<boolean> {
    if (this.finalized) throw new Error("Capture is already finalized");
    const parsed = rawEnvelopeSchema.parse(input);
    if (parsed.adapter !== this.host) throw new Error(`Envelope adapter ${parsed.adapter} does not match ${this.host}`);
    if (sha256(canonicalJson(parsed.payload)) !== parsed.payload_sha256) throw new Error("Raw envelope payload hash mismatch");
    const key = parsed.source_event_id
      ? `${parsed.adapter}:${parsed.source_event_id}`
      : `${parsed.adapter}:${parsed.payload_sha256}`;
    if (this.dedupe.has(key)) return false;
    this.dedupe.add(key);
    // `sequence` is the append-only vault order. Provider/channel-local order
    // remains inside the opaque payload/source identifiers; assigning it here
    // prevents two concurrently observed official channels from colliding.
    const envelope: RawEnvelope = { ...parsed, sequence: this.raw.length };
    this.raw.push(envelope);
    this.appendQueue = this.appendQueue.then(() => this.writer.append({ kind: "raw", value: envelope }));
    await this.appendQueue;
    return true;
  }

  async finalize(): Promise<TraceBundle> {
    if (this.finalized) throw new Error("Capture is already finalized");
    this.finalized = true;
    try {
      await this.appendQueue;
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
      let bundle: TraceBundle = {
        manifest: {
          ...this.manifest,
          source: observed === null ? this.manifest.source : {
            ...this.manifest.source,
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
    await this.writer.abort();
  }
}
