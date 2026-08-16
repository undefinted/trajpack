import { createHmac, timingSafeEqual } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type { Host, RawEnvelope } from "@trajpack/schema";
import { rawEnvelopeSchema } from "@trajpack/schema";
import {
  CLAUDE_TRANSCRIPT_OPAQUE_INTERFACE_VERSION,
  classifyJsonLine,
} from "@trajpack/adapters";
import { canonicalJson, sha256 } from "@trajpack/core";
import { CaptureSession } from "./capture-session.js";

const MAX_CLAUDE_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

export interface IngestServerOptions {
  host: Host;
  token: string;
  session: CaptureSession;
  pairingNonce?: string;
  expectedCwd?: string;
  bindNextSession?: boolean;
  claudeTranscriptRoot?: string;
  maxClaudeTranscriptBytes?: number;
  onSessionEnd?: () => void;
}

export interface RunningIngestServer {
  server: FastifyInstance;
  url: string;
  port: number;
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

async function readOpaqueClaudeTranscript(
  requestedPath: string,
  sessionId: string,
  configuredRoot: string,
  maxBytes: number,
): Promise<OpaqueClaudeTranscript | null> {
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

    const [rootRealPath, targetRealPath, targetDetails] = await Promise.all([
      realpath(root),
      realpath(target),
      lstat(target),
    ]);
    if (!pathWithin(rootRealPath, targetRealPath)) return null;
    if (!targetDetails.isFile() || targetDetails.isSymbolicLink() || targetDetails.size > maxBytes) return null;

    const handle = await open(targetRealPath, "r");
    try {
      const openedDetails = await handle.stat();
      if (!openedDetails.isFile() || openedDetails.size > maxBytes) return null;
      if (openedDetails.dev !== targetDetails.dev || openedDetails.ino !== targetDetails.ino) return null;

      // Allocate from the verified file size, plus one byte to detect growth.
      // This avoids readFile following a swapped path or allocating without a
      // collector-controlled upper bound.
      const bytes = Buffer.alloc(openedDetails.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      if (offset !== openedDetails.size || offset > maxBytes) return null;
      return { bytes: bytes.subarray(0, offset), realPath: targetRealPath };
    } finally {
      await handle.close();
    }
  } catch {
    // Hook ingestion is observational. Never log a path or transcript error.
    return null;
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
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024 });
  let received = 0;
  let browserNonce = options.pairingNonce;
  let pairedOrigin: string | null = null;
  let boundSessionId: string | null = null;
  let boundSessionEnded = false;

  app.post("/v1/hooks/events", async (request, reply) => {
    const bearer = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    const alternate = request.headers["x-trajpack-capture-token"] as string | undefined;
    if (!equalSecret(bearer ?? alternate, options.token)) return reply.code(401).send({ error: "unauthorized" });
    const declaredHost = request.headers["x-trajpack-host"];
    const declaredInterfaceHeader = request.headers["x-trajpack-interface"];
    if (typeof declaredHost !== "string" || declaredHost.length === 0) {
      return reply.code(400).send({ error: "host_header_required" });
    }
    if (declaredHost !== options.host) {
      return reply.code(409).send({ error: "host_header_mismatch" });
    }
    if (typeof declaredInterfaceHeader !== "string" || declaredInterfaceHeader.length === 0) {
      return reply.code(400).send({ error: "interface_header_required" });
    }
    if (request.body && typeof request.body === "object" && !Array.isArray(request.body)
      && "envelope" in (request.body as Record<string, unknown>)) {
      return reply.code(422).send({ error: "wrapped_hook_envelope_rejected" });
    }
    if (rawEnvelopeSchema.safeParse(request.body).success) {
      return reply.code(422).send({ error: "raw_hook_envelope_rejected" });
    }
    let envelope: RawEnvelope;
    try {
      envelope = unwrapEnvelope(options.host, request.body, received, declaredInterfaceHeader);
    } catch {
      return reply.code(422).send({ error: "event_rejected" });
    }
    if (envelope.adapter !== options.host) return reply.code(409).send({ error: "adapter_mismatch" });
    if (
      envelope.adapter === "claude_code" &&
      envelope.interface_version === CLAUDE_TRANSCRIPT_OPAQUE_INTERFACE_VERSION
    ) {
      return reply.code(409).send({ error: "collector_generated_interface" });
    }
    const payload = envelope.payload as Record<string, unknown>;
    const hookInterface = envelope.interface_version === "codex-hook/1"
      || envelope.interface_version === "claude-hook/1";
    if (hookInterface && typeof payload.hook_event_name !== "string") {
      return reply.code(422).send({ error: "hook_event_name_required" });
    }
    if (options.expectedCwd && hookInterface) {
      if (typeof payload.cwd !== "string" || payload.cwd.length === 0) {
        return reply.code(422).send({ error: "cwd_required" });
      }
      if (payload.cwd !== options.expectedCwd) return reply.code(409).send({ error: "cwd_mismatch" });
    }
    const requestSessionId = envelope.session_id;
    if (options.bindNextSession) {
      if (typeof requestSessionId !== "string" || requestSessionId.trim().length === 0) {
        return reply.code(422).send({ error: "session_id_required" });
      }
      if (boundSessionId === null) boundSessionId = requestSessionId;
      else if (requestSessionId !== boundSessionId) {
        return reply.code(409).send({ error: "session_mismatch" });
      }
    } else if (
      options.host === "claude_code" &&
      boundSessionId === null &&
      typeof requestSessionId === "string" &&
      requestSessionId.trim().length > 0 &&
      payload.hook_event_name !== "SessionEnd"
    ) {
      // Wrapper capture remains permissive for event ingestion, but an opaque
      // transcript is only accepted after this collector has observed and
      // bound a prior hook from the same Claude session.
      boundSessionId = requestSessionId;
    }
    const accepted = await options.session.ingest(envelope);
    if (accepted) received += 1;

    const isBoundClaudeSessionEnd =
      options.host === "claude_code" &&
      envelope.adapter === "claude_code" &&
      envelope.interface_version === "claude-hook/1" &&
      payload.hook_event_name === "SessionEnd" &&
      typeof requestSessionId === "string" &&
      requestSessionId === boundSessionId &&
      (!options.expectedCwd || payload.cwd === options.expectedCwd);
    if (isBoundClaudeSessionEnd && typeof payload.transcript_path === "string") {
      const transcript = await readOpaqueClaudeTranscript(
        payload.transcript_path,
        requestSessionId,
        options.claudeTranscriptRoot ?? join(homedir(), ".claude", "projects"),
        Math.min(options.maxClaudeTranscriptBytes ?? MAX_CLAUDE_TRANSCRIPT_BYTES, MAX_CLAUDE_TRANSCRIPT_BYTES),
      );
      if (transcript) {
        const opaqueAccepted = await options.session.ingest(opaqueClaudeEnvelope(transcript, envelope, requestSessionId, received, options.token));
        if (opaqueAccepted) received += 1;
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
  });

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

  app.post("/v1/browser/captures", async (request, reply) => {
    const origin = request.headers.origin;
    const nonce = request.headers["x-trajpack-pairing-nonce"] as string | undefined;
    if (!browserNonce || !extensionOrigin(origin) || !equalSecret(nonce, browserNonce)) {
      return reply.code(403).send({ error: "pairing_rejected" });
    }
    if (pairedOrigin && origin !== pairedOrigin) return reply.code(403).send({ error: "origin_mismatch" });
    pairedOrigin = origin;
    let envelope: RawEnvelope;
    try {
      envelope = unwrapEnvelope("browser", request.body, received);
    } catch {
      return reply.code(422).send({ error: "event_rejected" });
    }
    const suppliedRecipe = request.headers["x-trajpack-recipe-sha256"] as string | undefined;
    const recordedRecipe = browserRecipeSha256(envelope);
    if (!recordedRecipe || !equalSecret(suppliedRecipe, recordedRecipe)) {
      return reply.code(409).send({ error: "recipe_hash_mismatch" });
    }
    browserNonce = undefined;
    const accepted = await options.session.ingest(envelope);
    if (accepted) received += 1;
    return reply
      .header("Access-Control-Allow-Origin", origin)
      .header("Vary", "Origin")
      .code(accepted ? 201 : 200)
      .send({ accepted });
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Unable to determine collector port");
  return {
    server: app,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    close: () => app.close(),
  };
}
