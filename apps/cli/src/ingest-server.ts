import { createHmac, timingSafeEqual } from "node:crypto";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { Host, RawEnvelope } from "@trajpack/schema";
import { rawEnvelopeSchema } from "@trajpack/schema";
import {
  CLAUDE_TRANSCRIPT_OPAQUE_INTERFACE_VERSION,
  classifyJsonLine,
} from "@trajpack/adapters";
import { canonicalJson, sha256 } from "@trajpack/core";
import { CaptureBackpressureError, CaptureLimitError, CaptureSession } from "./capture-session.js";

const MAX_CLAUDE_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_CAPTURE_EVENTS = 100_000;
// Raw capture is deliberately kept far below the 512 MiB vault reader bound:
// the same vault must also contain normalized events, manifests, frame lengths,
// authentication tags, and its final frame. VaultWriter remains the ultimate
// exact fail-closed boundary for unusually expansive normalization.
export const DEFAULT_MAX_CAPTURE_RAW_BYTES = 128 * 1024 * 1024;
export const MAX_CONFIGURABLE_CAPTURE_EVENTS = 1_000_000;
export const MAX_CONFIGURABLE_CAPTURE_RAW_BYTES = 192 * 1024 * 1024;
export const DEFAULT_MAX_INVALID_CAPTURE_ATTEMPTS = 64;
export const MAX_CONFIGURABLE_INVALID_CAPTURE_ATTEMPTS = 1024;
export const DEFAULT_MAX_CONCURRENT_INGEST_REQUESTS = 4;
export const MAX_CONFIGURABLE_CONCURRENT_INGEST_REQUESTS = 64;
export const MAX_HOOK_HTTP_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_BROWSER_HTTP_BODY_BYTES = 20 * 1024 * 1024;

export interface IngestServerOptions {
  host: Host;
  token: string;
  session: CaptureSession;
  pairingNonce?: string;
  expectedCwd?: string;
  bindNextSession?: boolean;
  claudeTranscriptRoot?: string;
  maxClaudeTranscriptBytes?: number;
  maxEvents?: number;
  maxTotalRawBytes?: number;
  maxInvalidAttempts?: number;
  maxConcurrentRequests?: number;
  onSessionEnd?: () => void;
  onLimitExceeded?: (reason: string) => void;
}

export interface RunningIngestServer {
  server: FastifyInstance;
  url: string;
  port: number;
  limitViolation(): string | null;
  close(): Promise<void>;
}

function equalSecret(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function extensionOrigin(value: string | undefined): value is string {
  return Boolean(value && /^chrome-extension:\/\/[a-p]{32}$/.test(value));
}

function browserRecipeSha256(envelope: RawEnvelope): string | null {
  if (!envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) return null;
  const provenance = (envelope.payload as Record<string, unknown>).provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return null;
  const digest = (provenance as Record<string, unknown>).selector_recipe_sha256;
  return typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest) ? digest : null;
}

function unwrapEnvelope(host: Host, body: unknown, sequence: number, declaredInterface?: string): RawEnvelope {
  const candidate = body && typeof body === "object" && "envelope" in body
    ? (body as { envelope: unknown }).envelope
    : body;
  const parsed = rawEnvelopeSchema.safeParse(candidate);
  if (parsed.success) {
    if (declaredInterface !== undefined && parsed.data.interface_version !== declaredInterface) {
      throw new Error("Declared interface does not match the envelope");
    }
    return parsed.data;
  }
  const classified = classifyJsonLine(host, JSON.stringify(candidate), sequence, declaredInterface);
  if (!classified) throw new Error("Adapter rejected the event payload");
  return classified;
}

function pathWithin(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

interface OpaqueClaudeTranscript {
  bytes: Buffer;
  realPath: string;
}

interface ClaudeTranscriptBinding {
  requestedPath: string;
  realPath: string;
  parentRealPath: string;
  device: number;
  inode: number;
}

interface OpenedClaudeTranscript extends ClaudeTranscriptBinding {
  handle: FileHandle;
  size: number;
}

async function openVerifiedClaudeTranscript(
  requestedPath: string,
  sessionId: string,
  configuredRoot: string,
  maxBytes: number,
  expectedBinding: ClaudeTranscriptBinding | null = null,
): Promise<OpenedClaudeTranscript | null> {
  if (!isAbsolute(requestedPath) || extname(requestedPath) !== ".jsonl") return null;
  if (basename(requestedPath, ".jsonl") !== sessionId) return null;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return null;

  const root = resolve(configuredRoot);
  const target = resolve(requestedPath);
  if (!pathWithin(root, target)) return null;

  try {
    // Reject a symlink (or junction on platforms that report it as one) at
    // every path component. realpath containment below separately protects
    // against links that resolve outside the configured tree.
    const rootDetails = await lstat(root);
    if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) return null;
    const child = relative(root, target);
    let current = root;
    for (const segment of child.split(sep).filter(Boolean)) {
      current = join(current, segment);
      const details = await lstat(current);
      if (details.isSymbolicLink()) return null;
    }

    const [rootRealPath, targetRealPath, parentRealPath, targetDetails] = await Promise.all([
      realpath(root),
      realpath(target),
      realpath(dirname(target)),
      lstat(target),
    ]);
    if (!pathWithin(rootRealPath, targetRealPath)) return null;
    if (!targetDetails.isFile() || targetDetails.isSymbolicLink() || targetDetails.size > maxBytes) return null;
    if (expectedBinding && (
      target !== expectedBinding.requestedPath
      || targetRealPath !== expectedBinding.realPath
      || parentRealPath !== expectedBinding.parentRealPath
      || targetDetails.dev !== expectedBinding.device
      || targetDetails.ino !== expectedBinding.inode
    )) return null;

    const handle = await open(targetRealPath, "r");
    try {
      const openedDetails = await handle.stat();
      if (!openedDetails.isFile() || openedDetails.size > maxBytes
        || openedDetails.dev !== targetDetails.dev || openedDetails.ino !== targetDetails.ino) {
        await handle.close().catch(() => undefined);
        return null;
      }
      if (expectedBinding && (
        openedDetails.dev !== expectedBinding.device || openedDetails.ino !== expectedBinding.inode
      )) {
        await handle.close().catch(() => undefined);
        return null;
      }
      return {
        handle,
        requestedPath: target,
        realPath: targetRealPath,
        parentRealPath,
        device: openedDetails.dev,
        inode: openedDetails.ino,
        size: openedDetails.size,
      };
    } catch {
      await handle.close().catch(() => undefined);
      return null;
    }
  } catch {
    // Hook ingestion is observational. Never log a path or transcript error.
    return null;
  }
}

async function bindOpaqueClaudeTranscript(
  requestedPath: string,
  sessionId: string,
  configuredRoot: string,
  maxBytes: number,
): Promise<ClaudeTranscriptBinding | null> {
  const opened = await openVerifiedClaudeTranscript(requestedPath, sessionId, configuredRoot, maxBytes);
  if (!opened) return null;
  const { handle, size: _size, ...binding } = opened;
  await handle.close().catch(() => undefined);
  return binding;
}

async function readOpaqueClaudeTranscript(
  requestedPath: string,
  sessionId: string,
  configuredRoot: string,
  maxBytes: number,
  binding: ClaudeTranscriptBinding,
): Promise<OpaqueClaudeTranscript | null> {
  const opened = await openVerifiedClaudeTranscript(
    requestedPath,
    sessionId,
    configuredRoot,
    maxBytes,
    binding,
  );
  if (!opened) return null;
  try {
    // Allocate from the verified file size, plus one byte to detect growth.
    // Reading through the already-verified handle prevents a path swap between
    // validation and ingestion.
    const bytes = Buffer.alloc(opened.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await opened.handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset !== opened.size || offset > maxBytes) return null;
    return { bytes: bytes.subarray(0, offset), realPath: opened.realPath };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

function opaqueClaudeEnvelope(
  transcript: OpaqueClaudeTranscript,
  source: RawEnvelope,
  sessionId: string,
  sequence: number,
  hmacKey: string,
): RawEnvelope {
  const contentSha256 = sha256(transcript.bytes);
  const payload = {
    bytes_base64: transcript.bytes.toString("base64"),
    path_hmac: createHmac("sha256", hmacKey).update(transcript.realPath).digest("hex"),
    sha256: contentSha256,
    size: transcript.bytes.length,
    not_parsed: true,
  };
  return {
    envelope_version: "raw/0.1",
    adapter: "claude_code",
    adapter_version: source.adapter_version,
    interface_version: CLAUDE_TRANSCRIPT_OPAQUE_INTERFACE_VERSION,
    captured_at: source.captured_at,
    sequence,
    source_event_id: `opaque_${sha256(`${sessionId}:${contentSha256}`).slice(0, 32)}`,
    session_id: sessionId,
    turn_id: null,
    payload_sha256: sha256(canonicalJson(payload)),
    payload,
  };
}

export async function startIngestServer(options: IngestServerOptions): Promise<RunningIngestServer> {
  const app = Fastify({ logger: false, bodyLimit: MAX_BROWSER_HTTP_BODY_BYTES });
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_CAPTURE_EVENTS;
  const maxTotalRawBytes = options.maxTotalRawBytes ?? DEFAULT_MAX_CAPTURE_RAW_BYTES;
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > MAX_CONFIGURABLE_CAPTURE_EVENTS) {
    throw new Error(`Collector maxEvents must be from 1 to ${MAX_CONFIGURABLE_CAPTURE_EVENTS}`);
  }
  if (!Number.isSafeInteger(maxTotalRawBytes) || maxTotalRawBytes < 1
    || maxTotalRawBytes > MAX_CONFIGURABLE_CAPTURE_RAW_BYTES) {
    throw new Error(`Collector maxTotalRawBytes must be from 1 to ${MAX_CONFIGURABLE_CAPTURE_RAW_BYTES}`);
  }
  const maxInvalidAttempts = options.maxInvalidAttempts ?? DEFAULT_MAX_INVALID_CAPTURE_ATTEMPTS;
  if (!Number.isSafeInteger(maxInvalidAttempts) || maxInvalidAttempts < 1
    || maxInvalidAttempts > MAX_CONFIGURABLE_INVALID_CAPTURE_ATTEMPTS) {
    throw new Error(`Collector maxInvalidAttempts must be from 1 to ${MAX_CONFIGURABLE_INVALID_CAPTURE_ATTEMPTS}`);
  }
  const maxConcurrentRequests = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_INGEST_REQUESTS;
  if (!Number.isSafeInteger(maxConcurrentRequests) || maxConcurrentRequests < 1
    || maxConcurrentRequests > MAX_CONFIGURABLE_CONCURRENT_INGEST_REQUESTS) {
    throw new Error(
      `Collector maxConcurrentRequests must be from 1 to ${MAX_CONFIGURABLE_CONCURRENT_INGEST_REQUESTS}`,
    );
  }
  let received = 0;
  let reservedEvents = 0;
  let totalRawBytes = 0;
  let invalidAttempts = 0;
  let captureLimitViolation: string | null = null;
  let browserNonce = options.pairingNonce;
  let pairedOrigin: string | null = null;
  let boundSessionId: string | null = null;
  let boundSessionEnded = false;
  let claudeTranscriptBindingPromise: Promise<ClaudeTranscriptBinding | null> | null = null;
  let activeRequests = 0;
  let preparseRequests = 0;
  const preparseTracked = new WeakSet<object>();
  const drainWaiters = new Set<() => void>();

  const releasePreparseRequest = (request: object): void => {
    if (!preparseTracked.delete(request)) return;
    preparseRequests -= 1;
  };

  // Authenticate and admit concurrency before Fastify parses a request body.
  // This bounds unauthenticated and concurrent loopback JSON allocations. The
  // handlers repeat capability checks at point of use so a browser nonce that
  // another request consumes still fails closed.
  app.addHook("onRequest", async (request, reply) => {
    if (request.method !== "POST") return;
    const path = request.url.split("?", 1)[0];
    if (path !== "/v1/hooks/events" && path !== "/v1/browser/captures") return;
    if (path === "/v1/hooks/events") {
      const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "");
      const alternate = request.headers["x-trajpack-capture-token"] as string | undefined;
      if (!equalSecret(bearer ?? alternate, options.token)) {
        await reply.code(401).send({ error: "unauthorized" });
        return;
      }
    } else {
      const origin = request.headers.origin;
      const nonce = request.headers["x-trajpack-pairing-nonce"] as string | undefined;
      if (!browserNonce || !extensionOrigin(origin) || !equalSecret(nonce, browserNonce)) {
        await reply.code(403).send({ error: "pairing_rejected" });
        return;
      }
    }
    if (preparseRequests >= maxConcurrentRequests) {
      await reply.code(429).send({ error: "collector_busy" });
      return;
    }
    preparseRequests += 1;
    preparseTracked.add(request);
  });
  app.addHook("onResponse", async (request) => { releasePreparseRequest(request); });
  app.addHook("onError", async (request) => { releasePreparseRequest(request); });

  const trackRequest = async <T>(operation: () => Promise<T>): Promise<T> => {
    activeRequests += 1;
    try {
      return await operation();
    } finally {
      activeRequests -= 1;
      if (activeRequests === 0) {
        for (const resolveDrain of drainWaiters) resolveDrain();
        drainWaiters.clear();
      }
    }
  };
  const waitForInFlight = (): Promise<void> => activeRequests === 0
    ? Promise.resolve()
    : new Promise<void>((resolveDrain) => { drainWaiters.add(resolveDrain); });

  const exceedLimit = (reason: string): string => {
    if (captureLimitViolation === null) {
      captureLimitViolation = reason;
      options.onLimitExceeded?.(reason);
    }
    return reason;
  };
  const rejectInvalid = (
    reply: FastifyReply,
    statusCode: number,
    body: Record<string, unknown>,
  ) => {
    invalidAttempts += 1;
    if (invalidAttempts > maxInvalidAttempts) {
      const reason = exceedLimit("CAPTURE_INVALID_ATTEMPT_LIMIT_EXCEEDED");
      return reply.code(429).send({ error: "capture_limit_exceeded", reason });
    }
    return reply.code(statusCode).send(body);
  };
  const reserve = (value: unknown, additionalEvents = 1): string | null => {
    if (captureLimitViolation !== null) return captureLimitViolation;
    let bytes: number;
    try {
      bytes = Buffer.byteLength(canonicalJson(value), "utf8");
    } catch {
      return exceedLimit("CAPTURE_PAYLOAD_UNMEASURABLE");
    }
    if (reservedEvents + additionalEvents > maxEvents) return exceedLimit("CAPTURE_EVENT_LIMIT_EXCEEDED");
    if (totalRawBytes + bytes > maxTotalRawBytes) return exceedLimit("CAPTURE_RAW_BYTE_LIMIT_EXCEEDED");
    reservedEvents += additionalEvents;
    totalRawBytes += bytes;
    return null;
  };
  const releaseReservation = (value: unknown, additionalEvents = 1): void => {
    // Only authenticated, structurally accepted retries/backpressure reach
    // this path. Invalid attempts have their own hard counter and never reserve.
    const bytes = Buffer.byteLength(canonicalJson(value), "utf8");
    reservedEvents = Math.max(0, reservedEvents - additionalEvents);
    totalRawBytes = Math.max(0, totalRawBytes - bytes);
  };

  app.post("/v1/hooks/events", { bodyLimit: MAX_HOOK_HTTP_BODY_BYTES }, (request, reply) => trackRequest(async () => {
    const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const alternate = request.headers["x-trajpack-capture-token"] as string | undefined;
    if (!equalSecret(bearer ?? alternate, options.token)) return reply.code(401).send({ error: "unauthorized" });
    if (captureLimitViolation !== null) {
      return reply.code(429).send({ error: "capture_limit_exceeded", reason: captureLimitViolation });
    }
    const declaredHost = request.headers["x-trajpack-host"];
    const declaredInterfaceHeader = request.headers["x-trajpack-interface"];
    if (typeof declaredHost !== "string" || declaredHost.length === 0) {
      return rejectInvalid(reply, 400, { error: "host_header_required" });
    }
    if (declaredHost !== options.host) {
      return rejectInvalid(reply, 409, { error: "host_header_mismatch" });
    }
    if (typeof declaredInterfaceHeader !== "string" || declaredInterfaceHeader.length === 0) {
      return rejectInvalid(reply, 400, { error: "interface_header_required" });
    }
    if (request.body && typeof request.body === "object" && !Array.isArray(request.body)
      && "envelope" in (request.body as Record<string, unknown>)) {
      return rejectInvalid(reply, 422, { error: "wrapped_hook_envelope_rejected" });
    }
    if (rawEnvelopeSchema.safeParse(request.body).success) {
      return rejectInvalid(reply, 422, { error: "raw_hook_envelope_rejected" });
    }
    let envelope: RawEnvelope;
    try {
      envelope = unwrapEnvelope(options.host, request.body, received, declaredInterfaceHeader);
    } catch {
      return rejectInvalid(reply, 422, { error: "event_rejected" });
    }
    if (envelope.adapter !== options.host) return rejectInvalid(reply, 409, { error: "adapter_mismatch" });
    if (
      envelope.adapter === "claude_code" &&
      envelope.interface_version === CLAUDE_TRANSCRIPT_OPAQUE_INTERFACE_VERSION
    ) {
      return rejectInvalid(reply, 409, { error: "collector_generated_interface" });
    }
    const payload = envelope.payload as Record<string, unknown>;
    const hookInterface = envelope.interface_version === "codex-hook/1"
      || envelope.interface_version === "claude-hook/1"
      || envelope.interface_version === "gemini-cli-hook/1";
    const claudeHook = options.host === "claude_code"
      && envelope.adapter === "claude_code"
      && envelope.interface_version === "claude-hook/1";
    const claudeSessionStart = claudeHook && payload.hook_event_name === "SessionStart";
    if (hookInterface && typeof payload.hook_event_name !== "string") {
      return rejectInvalid(reply, 422, { error: "hook_event_name_required" });
    }
    if (options.expectedCwd && hookInterface) {
      if (typeof payload.cwd !== "string" || payload.cwd.length === 0) {
        return rejectInvalid(reply, 422, { error: "cwd_required" });
      }
      if (payload.cwd !== options.expectedCwd) return rejectInvalid(reply, 409, { error: "cwd_mismatch" });
    }
    if (claudeSessionStart && typeof payload.transcript_path !== "string") {
      return rejectInvalid(reply, 422, { error: "transcript_path_required" });
    }
    const requestSessionId = envelope.session_id;
    let newlyBoundClaudeSession = false;
    if (options.bindNextSession) {
      if (typeof requestSessionId !== "string" || requestSessionId.trim().length === 0) {
        return rejectInvalid(reply, 422, { error: "session_id_required" });
      }
      if (claudeHook && boundSessionId === null && !claudeSessionStart) {
        return rejectInvalid(reply, 409, { error: "session_start_required" });
      }
      if (boundSessionId === null) {
        boundSessionId = requestSessionId;
        newlyBoundClaudeSession = claudeSessionStart;
      }
      else if (requestSessionId !== boundSessionId) {
        return rejectInvalid(reply, 409, { error: "session_mismatch" });
      }
    } else if (
      claudeSessionStart &&
      boundSessionId === null &&
      typeof requestSessionId === "string" &&
      requestSessionId.trim().length > 0
    ) {
      // Wrapper capture remains permissive for ordinary event ingestion, but
      // only a SessionStart may establish opaque-transcript provenance.
      boundSessionId = requestSessionId;
      newlyBoundClaudeSession = true;
    }
    if (claudeSessionStart && typeof requestSessionId === "string"
      && requestSessionId === boundSessionId && options.expectedCwd) {
      const transcriptPath = payload.transcript_path as string;
      const transcriptRoot = options.claudeTranscriptRoot ?? join(homedir(), ".claude", "projects");
      const transcriptMaxBytes = Math.min(
        options.maxClaudeTranscriptBytes ?? MAX_CLAUDE_TRANSCRIPT_BYTES,
        MAX_CLAUDE_TRANSCRIPT_BYTES,
      );
      if (newlyBoundClaudeSession) {
        const pendingBinding = bindOpaqueClaudeTranscript(
          transcriptPath,
          requestSessionId,
          transcriptRoot,
          transcriptMaxBytes,
        );
        claudeTranscriptBindingPromise = pendingBinding;
        const binding = await pendingBinding;
        if (!binding) {
          if (boundSessionId === requestSessionId && claudeTranscriptBindingPromise === pendingBinding) {
            boundSessionId = null;
            claudeTranscriptBindingPromise = null;
          }
          return rejectInvalid(reply, 422, { error: "transcript_binding_rejected" });
        }
      } else if (claudeTranscriptBindingPromise) {
        const binding = await claudeTranscriptBindingPromise;
        if (!binding || resolve(transcriptPath) !== binding.requestedPath) {
          return rejectInvalid(reply, 409, { error: "transcript_binding_mismatch" });
        }
      }
    }
    const limit = reserve(envelope);
    if (limit !== null) return reply.code(429).send({ error: "capture_limit_exceeded", reason: limit });
    let accepted: boolean;
    try {
      accepted = await options.session.ingest(envelope);
    } catch (error) {
      if (error instanceof CaptureBackpressureError) {
        releaseReservation(envelope);
        return reply.code(429).send({ error: "collector_busy" });
      }
      const reason = error instanceof CaptureLimitError
        ? exceedLimit(error.reason)
        : exceedLimit("CAPTURE_STORAGE_FAILURE");
      return reply.code(error instanceof CaptureLimitError ? 429 : 500)
        .send({ error: "capture_limit_exceeded", reason });
    }
    if (accepted) received += 1;
    else releaseReservation(envelope);

    const isBoundClaudeSessionEnd =
      options.host === "claude_code" &&
      envelope.adapter === "claude_code" &&
      envelope.interface_version === "claude-hook/1" &&
      payload.hook_event_name === "SessionEnd" &&
      typeof requestSessionId === "string" &&
      requestSessionId === boundSessionId &&
      (!options.expectedCwd || payload.cwd === options.expectedCwd) &&
      !boundSessionEnded;
    if (isBoundClaudeSessionEnd && typeof payload.transcript_path === "string" && claudeTranscriptBindingPromise) {
      const binding = await claudeTranscriptBindingPromise;
      const transcript = binding ? await readOpaqueClaudeTranscript(
        payload.transcript_path,
        requestSessionId,
        options.claudeTranscriptRoot ?? join(homedir(), ".claude", "projects"),
        Math.min(options.maxClaudeTranscriptBytes ?? MAX_CLAUDE_TRANSCRIPT_BYTES, MAX_CLAUDE_TRANSCRIPT_BYTES),
        binding,
      ) : null;
      if (transcript) {
        const opaque = opaqueClaudeEnvelope(transcript, envelope, requestSessionId, received, options.token);
        const opaqueLimit = reserve(opaque);
        if (opaqueLimit !== null) return reply.code(429).send({ error: "capture_limit_exceeded", reason: opaqueLimit });
        let opaqueAccepted: boolean;
        try {
          opaqueAccepted = await options.session.ingest(opaque);
        } catch (error) {
          if (error instanceof CaptureBackpressureError) {
            releaseReservation(opaque);
            return reply.code(429).send({ error: "collector_busy" });
          }
          const reason = error instanceof CaptureLimitError
            ? exceedLimit(error.reason)
            : exceedLimit("CAPTURE_STORAGE_FAILURE");
          return reply.code(error instanceof CaptureLimitError ? 429 : 500)
            .send({ error: "capture_limit_exceeded", reason });
        }
        if (opaqueAccepted) received += 1;
        else releaseReservation(opaque);
      }
    }
    if (
      hookInterface &&
      payload.hook_event_name === "SessionEnd" &&
      (!options.bindNextSession || requestSessionId === boundSessionId) &&
      !boundSessionEnded
    ) {
      boundSessionEnded = true;
      options.onSessionEnd?.();
    }
    return reply.code(accepted ? 202 : 200).send({ accepted });
  }));

  app.options("/v1/browser/captures", async (request, reply) => {
    const origin = request.headers.origin;
    if (!extensionOrigin(origin)) return reply.code(403).send();
    return reply
      .header("Access-Control-Allow-Origin", origin)
      .header("Access-Control-Allow-Headers", "Content-Type,X-Trajpack-Pairing-Nonce,X-Trajpack-Recipe-Sha256")
      .header("Access-Control-Allow-Methods", "POST,OPTIONS")
      .header("Vary", "Origin")
      .code(204)
      .send();
  });

  app.post("/v1/browser/captures", (request, reply) => trackRequest(async () => {
    const origin = request.headers.origin;
    const nonce = request.headers["x-trajpack-pairing-nonce"] as string | undefined;
    if (!browserNonce || !extensionOrigin(origin) || !equalSecret(nonce, browserNonce)) {
      return reply.code(403).send({ error: "pairing_rejected" });
    }
    if (captureLimitViolation !== null) {
      return reply.code(429).send({ error: "capture_limit_exceeded", reason: captureLimitViolation });
    }
    if (pairedOrigin && origin !== pairedOrigin) return rejectInvalid(reply, 403, { error: "origin_mismatch" });
    let envelope: RawEnvelope;
    try {
      envelope = unwrapEnvelope("browser", request.body, received);
    } catch {
      return rejectInvalid(reply, 422, { error: "event_rejected" });
    }
    const suppliedRecipe = request.headers["x-trajpack-recipe-sha256"] as string | undefined;
    const recordedRecipe = browserRecipeSha256(envelope);
    if (!recordedRecipe || !equalSecret(suppliedRecipe, recordedRecipe)) {
      return rejectInvalid(reply, 409, { error: "recipe_hash_mismatch" });
    }
    const limit = reserve(envelope);
    if (limit !== null) return reply.code(429).send({ error: "capture_limit_exceeded", reason: limit });
    const previousPairedOrigin = pairedOrigin;
    pairedOrigin = origin;
    browserNonce = undefined;
    let accepted: boolean;
    try {
      accepted = await options.session.ingest(envelope);
    } catch (error) {
      if (error instanceof CaptureBackpressureError) {
        releaseReservation(envelope);
        // This request atomically consumed the one-shot nonce immediately
        // before ingestion. Transient local pressure is retryable, so restore
        // exactly that capability; no other handler can consume it while it is
        // undefined in the single-threaded admission section above.
        if (browserNonce === undefined && pairedOrigin === origin) {
          browserNonce = nonce;
          pairedOrigin = previousPairedOrigin;
        }
        return reply.code(429).send({ error: "collector_busy" });
      }
      const reason = error instanceof CaptureLimitError
        ? exceedLimit(error.reason)
        : exceedLimit("CAPTURE_STORAGE_FAILURE");
      return reply.code(error instanceof CaptureLimitError ? 429 : 500)
        .send({ error: "capture_limit_exceeded", reason });
    }
    if (accepted) received += 1;
    else releaseReservation(envelope);
    return reply
      .header("Access-Control-Allow-Origin", origin)
      .header("Vary", "Origin")
      .code(accepted ? 201 : 200)
      .send({ accepted });
  }));

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Unable to determine collector port");
  let closePromise: Promise<void> | undefined;
  return {
    server: app,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    limitViolation: () => captureLimitViolation,
    // Fastify stops accepting new work and resolves close only after active
    // requests have completed. Memoizing makes command cleanup safely
    // idempotent and gives finalize a single in-flight drain barrier.
    close: () => {
      closePromise ??= Promise.all([app.close(), waitForInFlight()]).then(() => undefined);
      return closePromise;
    },
  };
}
