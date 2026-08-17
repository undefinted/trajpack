import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type {
  ApprovalMode,
  RawEnvelope,
  Rights,
  RightsOverrideAttestation,
  TraceBundle,
  TrajectoryEvent,
  VerifierConfirmation,
} from "@trajpack/schema";
import {
  rawEnvelopeSchema,
  rightsOverrideAttestationSchema,
  rightsSchema,
  verifierConfirmationSchema,
  verifierEvidenceSchema,
} from "@trajpack/schema";
import {
  applyAutomatedReview,
  canonicalJson,
  consentReceipt,
  createApprovalScope,
  createManifest,
  defaultSource,
  defaultPaths,
  evaluateGate,
  exportApprovedBundle,
  inspectQuality,
  listTraceIds,
  loadTrace,
  POLICY_VERSION,
  replaceTrace,
  redactStructured,
  reviewEvidenceFingerprint,
  scanStructured,
  sha256,
  stableId,
  type ExportFormat,
  type TrajpackPaths,
  validateApprovalScope,
} from "@trajpack/core";
import { CaptureSession } from "./capture-session.js";
import { BoundedWorkGate, type WorkRelease } from "./work-gate.js";

const API = "/api/v1/review";
const TRACE_ID = /^[a-f0-9]{32}$/;
const CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; font-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'";
const COMMERCIAL_WEB_CAPTURE_HOSTS = [
  "chatgpt.com",
  "chat.openai.com",
  "platform.openai.com",
  "claude.ai",
  "console.anthropic.com",
  "deepseek.com",
  "gemini.google.com",
  "bard.google.com",
  "aistudio.google.com",
] as const;
const DEFAULT_REVIEW_REDACTION = "[REDACTED BY REVIEWER]";
export const DEFAULT_MAX_CONCURRENT_REVIEW_VAULT_REQUESTS = 2;
export const DEFAULT_MAX_QUEUED_REVIEW_VAULT_REQUESTS = 16;
export const MAX_CONFIGURABLE_REVIEW_VAULT_REQUESTS = 8;
export const MAX_CONFIGURABLE_QUEUED_REVIEW_VAULT_REQUESTS = 128;

interface StoredReview {
  disposition?: "include" | "exclude" | "redact";
  note?: string | null;
  redaction_replacement?: string | null;
  rights_override?: Rights | null;
  rights_attestation?: RightsOverrideAttestation | null;
  verifier_confirmation?: VerifierConfirmation | null;
  updated_at?: string;
}

interface ReviewServerOptions {
  passphrase: string;
  idleMinutes?: number;
  outputRoot?: string;
  paths?: TrajpackPaths;
  reviewerDist?: string;
  maxConcurrentVaultRequests?: number;
  maxQueuedVaultRequests?: number;
}

export interface RunningReviewServer {
  server: FastifyInstance;
  url: string;
  launchUrl: string;
  browserPairingNonce: string;
  close(): Promise<void>;
}

interface BrowserCaptureMetadata {
  envelope: RawEnvelope;
  origin: string;
  recipeSha256: string;
  evidenceRef: string;
}

/** Resolve the reviewer assets shipped inside the @trajpack/cli package. */
export function defaultReviewerDist(): string {
  return resolve(fileURLToPath(new URL("../reviewer", import.meta.url)));
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

function commercialWebCaptureHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.+$/, "");
  return COMMERCIAL_WEB_CAPTURE_HOSTS.some((blocked) => normalized === blocked || normalized.endsWith(`.${blocked}`));
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error(`${label} must be an object`), { statusCode: 400, code: "invalid_browser_capture" });
  }
  return value as Record<string, unknown>;
}

function browserCaptureMetadata(body: unknown): BrowserCaptureMetadata {
  const outer = record(body, "request body");
  const envelope = rawEnvelopeSchema.parse(outer.envelope ?? body);
  if (envelope.adapter !== "browser") {
    throw Object.assign(new Error("Browser pairing accepts only browser envelopes"), { statusCode: 400, code: "invalid_browser_capture" });
  }
  const payload = record(envelope.payload, "payload");
  if (payload.record_kind !== "authorized_dom_capture") {
    throw Object.assign(new Error("Unsupported browser record kind"), { statusCode: 400, code: "invalid_browser_capture" });
  }
  if (sha256(canonicalJson(payload)) !== envelope.payload_sha256) {
    throw Object.assign(new Error("Browser payload hash mismatch"), { statusCode: 409, code: "payload_hash_mismatch" });
  }
  const provenance = record(payload.provenance, "provenance");
  const capture = record(payload.capture, "capture");
  const page = record(capture.page, "capture.page");
  const recipe = record(capture.recipe, "capture.recipe");
  const authorization = record(provenance.authorization, "provenance.authorization");
  const recipeAuthorization = record(recipe.authorization, "capture.recipe.authorization");
  const origin = provenance.source_origin;
  const recipeSha256 = provenance.selector_recipe_sha256;
  const evidenceRef = authorization.evidence_ref;
  const expiresAt = authorization.expires_at;
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(typeof origin === "string" ? origin : "");
  } catch {
    throw Object.assign(new Error("Browser origin provenance mismatch"), { statusCode: 409, code: "origin_mismatch" });
  }
  if (typeof origin !== "string" || parsedOrigin.origin !== origin || page.origin !== origin || recipe.origin !== origin) {
    throw Object.assign(new Error("Browser origin provenance mismatch"), { statusCode: 409, code: "origin_mismatch" });
  }
  if (commercialWebCaptureHost(parsedOrigin.hostname)) {
    throw Object.assign(new Error("Commercial AI web origins require an official export or manual import"), {
      statusCode: 409,
      code: "commercial_origin_blocked",
    });
  }
  if (typeof recipeSha256 !== "string" || !/^[a-f0-9]{64}$/.test(recipeSha256)
    || recipe.recipe_sha256 !== recipeSha256) {
    throw Object.assign(new Error("Selector recipe digest is missing or inconsistent"), { statusCode: 409, code: "recipe_hash_mismatch" });
  }
  const recipeWithoutHash = Object.fromEntries(Object.entries(recipe).filter(([key]) => key !== "recipe_sha256"));
  if (sha256(canonicalJson(recipeWithoutHash)) !== recipeSha256) {
    throw Object.assign(new Error("Selector recipe contents do not match the digest"), { statusCode: 409, code: "recipe_hash_mismatch" });
  }
  if (typeof evidenceRef !== "string" || !evidenceRef.trim()
    || typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()
    || canonicalJson(authorization) !== canonicalJson(recipeAuthorization)) {
    throw Object.assign(new Error("Authorization evidence is missing, expired, or inconsistent"), { statusCode: 409, code: "authorization_invalid" });
  }
  return { envelope, origin, recipeSha256, evidenceRef };
}

function parseCookies(value: string | undefined): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(value.split(";").map((item) => item.trim().split("=", 2)).filter((pair) => pair.length === 2));
}

function requestError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.code(status).send({ error: { code, message } });
}

function getReview(event: TrajectoryEvent): StoredReview {
  const value = event.metadata.trajpack_review;
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as StoredReview;
}

function eventReview(event: TrajectoryEvent, manifest: TraceBundle["manifest"]) {
  const stored = getReview(event);
  const rightsAttestation = rightsOverrideAttestationSchema.safeParse(stored.rights_attestation);
  const verifierConfirmation = verifierConfirmationSchema.safeParse(stored.verifier_confirmation);
  const verifier = verifierEvidenceSchema.safeParse(event.metadata.verifier);
  const reward = event.metadata.reward;
  const rightsCurrent = rightsAttestation.success
    && rightsAttestation.data.event_sha256 === reviewEvidenceFingerprint(event)
    && rightsAttestation.data.source_sha256 === sha256(canonicalJson(manifest.source))
    && Date.parse(rightsAttestation.data.attested_at) <= Date.now()
    && Date.parse(rightsAttestation.data.expires_at) > Date.now();
  const verifierCurrent = verifierConfirmation.success && verifier.success
    && typeof reward === "number" && Number.isFinite(reward)
    && verifierConfirmation.data.event_sha256 === reviewEvidenceFingerprint(event)
    && verifierConfirmation.data.reward === reward
    && canonicalJson(verifierConfirmation.data.verifier) === canonicalJson(verifier.data);
  return {
    event_id: event.event_id,
    disposition: stored.disposition ?? (event.review_disposition === "exclude" ? "exclude" : "include"),
    note: stored.note ?? null,
    redaction_replacement: stored.redaction_replacement ?? null,
    rights_override: stored.rights_override ?? event.content.find((part) => part.rights_override)?.rights_override ?? null,
    rights_attestation: rightsCurrent ? rightsAttestation.data : null,
    verifier_confirmation: verifierCurrent ? verifierConfirmation.data : null,
    updated_at: stored.updated_at ?? event.started_at,
  };
}

const RIGHTS_OVERRIDE_MODES = [
  "training_noncompetitive",
  "training_competitive_distillation",
  "redistribution",
] as const satisfies readonly ApprovalMode[];

function eligibilityForMode(manifest: TraceBundle["manifest"], mode: ApprovalMode) {
  return mode === "archive" ? manifest.eligibility.local_archive : manifest.eligibility[mode];
}

function verifierCandidate(event: TrajectoryEvent) {
  if (!["evaluation", "feedback"].includes(event.event_type)) {
    throw Object.assign(new Error("Only evaluation or feedback events can confirm verifier labels"), {
      statusCode: 409,
      code: "verifier_event_required",
    });
  }
  const reward = event.metadata.reward;
  const verifier = verifierEvidenceSchema.safeParse(event.metadata.verifier);
  if (typeof reward !== "number" || !Number.isFinite(reward) || !verifier.success) {
    throw Object.assign(new Error("A finite reward and versioned verifier with an artifact/result digest are required"), {
      statusCode: 409,
      code: "verifier_evidence_incomplete",
    });
  }
  return { reward, verifier: verifier.data };
}

interface ReviewCheck {
  check_id: string;
  category: "structure" | "privacy" | "rights" | "quality";
  label: string;
  status: "passed" | "failed" | "warning";
  summary: string;
  affected_event_ids: string[];
  scanner_version: string;
}

function checks(bundle: TraceBundle) {
  const quality = inspectQuality(bundle);
  const output: ReviewCheck[] = quality.issues.map((issue, index) => ({
    check_id: `quality-${index}`,
    category: "structure" as const,
    label: issue.code,
    status: issue.severity === "error" ? "failed" as const : "warning" as const,
    summary: issue.detail,
    affected_event_ids: issue.eventId ? [issue.eventId] : [],
    scanner_version: "quality/0.1",
  }));
  for (const event of bundle.events.filter((candidate) => candidate.review_disposition === "include")) {
    const unscanned = event.content.filter((part) => part.review_disposition === "include"
      && (part.redaction_status === "not_scanned" || part.redaction_status === "quarantined"));
    if (unscanned.length) output.push({
      check_id: `privacy-${event.event_id}`,
      category: "privacy",
      label: "Content clearance",
      status: "failed",
      summary: `${unscanned.length} content parts are not cleared`,
      affected_event_ids: [event.event_id],
      scanner_version: "redaction/0.1",
    });
    const structuredFindings = [
      ...scanStructured(event.tool?.arguments, "$.tool.arguments"),
      ...scanStructured(event.tool?.result, "$.tool.result"),
      ...scanStructured(event.metadata, "$.metadata"),
      ...scanStructured(event.links, "$.links").filter((finding) => !(
        finding.kind === "phone" && /\.(?:trace_id|span_id)$/.test(finding.path)
      )),
    ];
    if (structuredFindings.length) {
      const affectedPaths = [...new Set(structuredFindings.map((finding) => finding.path))];
      output.push({
        check_id: `privacy-structured-${event.event_id}`,
        category: "privacy",
        label: "Structured secret clearance",
        status: "failed",
        summary: `${structuredFindings.length} potential secrets remain in ${affectedPaths.length} structured fields`,
        affected_event_ids: [event.event_id],
        scanner_version: "redaction/0.1",
      });
    }
  }
  const includedParts = bundle.events
    .filter((event) => event.review_disposition === "include")
    .flatMap((event) => event.content.filter((part) => part.review_disposition === "include"));
  const contentRightsClear = includedParts.every((part) => part.rights_override
    && part.rights_override.input_rights_basis !== "unknown"
    && part.rights_override.third_party_content !== "unknown"
    && part.rights_override.source_license_expression !== "NOASSERTION");
  if ((bundle.manifest.rights.input_rights_basis === "unknown"
    || bundle.manifest.rights.third_party_content === "unknown"
    || bundle.manifest.rights.source_license_expression === "NOASSERTION") && !contentRightsClear) {
    output.push({
      check_id: "rights-manifest",
      category: "rights",
      label: "Source rights",
      status: "warning",
      summary: "Manifest input or third-party rights are unknown; training and redistribution remain blocked, while local archive is evaluated independently",
      affected_event_ids: [],
      scanner_version: POLICY_VERSION,
    });
  }
  if (output.length === 0) output.push({
    check_id: "quality-passed",
    category: "quality",
    label: "Automated checks",
    status: "passed",
    summary: "Structure, privacy, and rights checks passed",
    affected_event_ids: [],
    scanner_version: "quality/0.1",
  });
  return output;
}

function metrics(bundle: TraceBundle) {
  const quality = inspectQuality(bundle);
  const usage = bundle.events.reduce((total, event) => ({
    input: total.input + (event.usage.input_tokens ?? 0),
    output: total.output + (event.usage.output_tokens ?? 0),
    reasoning: total.reasoning + (event.usage.reasoning_tokens ?? 0),
  }), { input: 0, output: 0, reasoning: 0 });
  const verificationEvents = bundle.events.filter((event) => event.event_type === "evaluation" || (event.event_type === "tool.result" && event.status === "ok")).length;
  const observations = bundle.events.filter((event) => event.actor === "environment" || event.event_type === "tool.result").length;
  return {
    input_tokens: usage.input,
    output_tokens: usage.output,
    reasoning_tokens: usage.reasoning,
    tool_calls: quality.metrics.tool_call_count,
    failed_events: quality.metrics.failed_event_count,
    observation_action_pairs: Math.min(quality.metrics.tool_call_count, quality.metrics.tool_result_count),
    verification_events: verificationEvents,
    targeted_observation_ratio: observations === 0 ? null : verificationEvents / observations,
  };
}

function detail(bundle: TraceBundle) {
  return {
    manifest: bundle.manifest,
    events: bundle.events.map((event) => ({ event, review: eventReview(event, bundle.manifest) })),
    checks: checks(bundle),
    metrics: metrics(bundle),
    revision: bundle.manifest.review.revision,
  };
}

function summary(bundle: TraceBundle) {
  const review = bundle.events.map((event) => eventReview(event, bundle.manifest));
  const traceChecks = checks(bundle);
  const timestamps = bundle.events.flatMap((event) => [Date.parse(event.started_at), Date.parse(event.ended_at ?? event.started_at)]).filter(Number.isFinite);
  return {
    trace_id: bundle.manifest.trace_id,
    created_at: bundle.manifest.created_at,
    source: bundle.manifest.source,
    automated_checks: bundle.manifest.review.automated_checks,
    human_approval: bundle.manifest.review.human_approval,
    event_count: bundle.events.length,
    included_count: review.filter((item) => item.disposition !== "exclude").length,
    redacted_count: review.filter((item) => item.disposition === "redact").length,
    blocker_count: traceChecks.filter((item) => item.status === "failed").length,
    warning_count: traceChecks.filter((item) => item.status === "warning").length,
    duration_ms: timestamps.length ? Math.max(...timestamps) - Math.min(...timestamps) : null,
    updated_at: bundle.manifest.review.reviewed_at ?? bundle.manifest.created_at,
  };
}

function assertRevision(bundle: TraceBundle, input: unknown): asserts input is { expected_revision: number } {
  if (!input || typeof input !== "object" || !("expected_revision" in input) || typeof (input as { expected_revision: unknown }).expected_revision !== "number") {
    throw Object.assign(new Error("expected_revision is required"), { statusCode: 400, code: "invalid_request" });
  }
  if ((input as { expected_revision: number }).expected_revision !== bundle.manifest.review.revision) {
    throw Object.assign(new Error("Trace changed; refresh before saving"), { statusCode: 409, code: "revision_conflict" });
  }
}

function editedBundle(bundle: TraceBundle, events: TrajectoryEvent[]): TraceBundle {
  const revised = {
    ...bundle,
    events,
    manifest: {
      ...bundle.manifest,
      review: {
        ...bundle.manifest.review,
        revision: bundle.manifest.review.revision + 1,
        human_approval: "pending" as const,
        reviewer: null,
        reviewed_at: null,
        approval_scope: null,
      },
    },
  };
  return applyAutomatedReview(revised).bundle;
}

function redactReviewContent(event: TrajectoryEvent, replacement: string): Pick<TrajectoryEvent, "content" | "tool" | "metadata" | "links"> {
  const metadata = redactStructured(event.metadata).value as TrajectoryEvent["metadata"];
  const links = redactStructured(event.links).value as TrajectoryEvent["links"];
  return {
    content: event.content.map((part) => ({
      ...part,
      value: replacement,
      blob_ref: null,
      sha256: sha256(replacement),
      redaction_status: "redacted" as const,
    })),
    tool: event.tool === null ? null : {
      ...event.tool,
      arguments: event.tool.arguments === null ? null : replacement,
      result: event.tool.result === null ? null : replacement,
    },
    metadata,
    links,
  };
}

export async function startReviewServer(options: ReviewServerOptions): Promise<RunningReviewServer> {
  let passphrase = options.passphrase;
  options.passphrase = "";
  const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });
  const paths = options.paths ?? defaultPaths();
  const outputRoot = resolve(options.outputRoot ?? join(process.cwd(), "exports"));
  const launchNonce = randomBytes(32).toString("base64url");
  const sessionSecret = randomBytes(32).toString("base64url");
  const reviewerApiToken = randomBytes(32).toString("base64url");
  let browserPairingNonce: string | null = randomBytes(32).toString("base64url");
  let csrf = randomBytes(32).toString("base64url");
  let launchConsumed = false;
  let origin = "";
  let hostHeader = "";
  let locked = false;
  const idleMinutes = options.idleMinutes ?? 15;
  if (!Number.isFinite(idleMinutes) || idleMinutes < 1 / 60 || idleMinutes > 24 * 60) {
    throw new Error("Reviewer idle timeout must be a finite value from one second to 24 hours");
  }
  const idleMs = idleMinutes * 60_000;
  let idleLockAt = Date.now() + idleMs;
  let idleTimer: NodeJS.Timeout;
  const locks = new Map<string, Promise<void>>();
  const maxConcurrentVaultRequests = options.maxConcurrentVaultRequests
    ?? DEFAULT_MAX_CONCURRENT_REVIEW_VAULT_REQUESTS;
  const maxQueuedVaultRequests = options.maxQueuedVaultRequests
    ?? DEFAULT_MAX_QUEUED_REVIEW_VAULT_REQUESTS;
  if (!Number.isSafeInteger(maxConcurrentVaultRequests) || maxConcurrentVaultRequests < 1
    || maxConcurrentVaultRequests > MAX_CONFIGURABLE_REVIEW_VAULT_REQUESTS) {
    throw new Error(
      `Reviewer maxConcurrentVaultRequests must be from 1 to ${MAX_CONFIGURABLE_REVIEW_VAULT_REQUESTS}`,
    );
  }
  if (!Number.isSafeInteger(maxQueuedVaultRequests) || maxQueuedVaultRequests < 0
    || maxQueuedVaultRequests > MAX_CONFIGURABLE_QUEUED_REVIEW_VAULT_REQUESTS) {
    throw new Error(
      `Reviewer maxQueuedVaultRequests must be from 0 to ${MAX_CONFIGURABLE_QUEUED_REVIEW_VAULT_REQUESTS}`,
    );
  }
  const vaultWork = new BoundedWorkGate(maxConcurrentVaultRequests, maxQueuedVaultRequests);
  const requestWorkReleases = new WeakMap<object, WorkRelease>();

  const resetIdle = () => {
    if (locked) return;
    idleLockAt = Date.now() + idleMs;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      locked = true;
      passphrase = "";
      csrf = randomBytes(32).toString("base64url");
    }, idleMs);
    idleTimer.unref();
  };
  resetIdle();

  const withTraceLock = async <T>(traceId: string, action: () => Promise<T>): Promise<T> => {
    const previous = locks.get(traceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => { release = resolveLock; });
    const chain = previous.then(() => current);
    locks.set(traceId, chain);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (locks.get(traceId) === chain) locks.delete(traceId);
    }
  };

  app.addHook("onSend", async (_request, reply, payload) => {
    reply
      .header("Cache-Control", "no-store")
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff")
      .header("Cross-Origin-Resource-Policy", "same-origin")
      .header("Cross-Origin-Opener-Policy", "same-origin")
      .header("Content-Security-Policy", CSP);
    return payload;
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith(API)) return;
    if (!equalSecret(request.headers["x-trajpack-reviewer-token"] as string | undefined, reviewerApiToken)) {
      return requestError(reply, 401, "reviewer_token_required", "Reviewer launch capability required");
    }
    if (request.headers.host !== hostHeader) return requestError(reply, 403, "host_rejected", "Loopback Host header mismatch");
    if (request.headers.origin && request.headers.origin !== origin) return requestError(reply, 403, "origin_rejected", "Cross-origin request rejected");
    if (request.headers["sec-fetch-site"] && !["same-origin", "none"].includes(String(request.headers["sec-fetch-site"]))) {
      return requestError(reply, 403, "site_rejected", "Cross-site request rejected");
    }
    if (request.method === "OPTIONS") return requestError(reply, 403, "cors_rejected", "CORS preflight rejected");
    const cookie = parseCookies(request.headers.cookie).trajpack_session;
    const bootstrap = request.url.startsWith(`${API}/bootstrap`);
    if (!bootstrap && cookie !== sessionSecret) return requestError(reply, 401, "session_required", "Reviewer launch session required");
    if (!bootstrap && locked) return requestError(reply, 423, "vault_locked", "Vault is locked");
    if (!["GET", "HEAD"].includes(request.method)) {
      if (request.headers["x-requested-with"] !== "trajpack-reviewer" || request.headers["x-trajpack-csrf"] !== csrf) {
        return requestError(reply, 403, "csrf_rejected", "CSRF token rejected");
      }
    }
    resetIdle();
  });

  const releaseVaultWork = (request: object): void => {
    const release = requestWorkReleases.get(request);
    if (!release) return;
    requestWorkReleases.delete(request);
    release();
  };

  // Argon2id and decrypted trace graphs are deliberately admitted before body
  // parsing. Distinct trace ids may proceed concurrently, while a bounded FIFO
  // queue applies backpressure instead of multiplying workstation memory.
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0];
    const guarded = path?.startsWith(`${API}/traces`)
      || (path === "/v1/browser/captures" && request.method === "POST");
    if (!guarded) return;
    if (path === "/v1/browser/captures") {
      const requestOrigin = request.headers.origin;
      const suppliedNonce = request.headers["x-trajpack-pairing-nonce"] as string | undefined;
      if (request.headers.host !== hostHeader || !extensionOrigin(requestOrigin)
        || !browserPairingNonce || !equalSecret(suppliedNonce, browserPairingNonce)) {
        await reply.code(403).send({ error: "pairing_rejected" });
        return;
      }
    }
    const abortController = new AbortController();
    const abortQueuedWork = () => { abortController.abort(); };
    request.raw.once("aborted", abortQueuedWork);
    const release = await vaultWork.acquire(abortController.signal);
    request.raw.removeListener("aborted", abortQueuedWork);
    if (release === null) {
      if (request.raw.aborted) return;
      await reply.code(429).header("Retry-After", "1").send({
        error: { code: "reviewer_busy", message: "Reviewer vault work queue is full" },
      });
      return;
    }
    requestWorkReleases.set(request, release);
    if (request.raw.aborted) releaseVaultWork(request);
  });
  app.addHook("onResponse", async (request) => { releaseVaultWork(request); });
  app.addHook("onError", async (request) => { releaseVaultWork(request); });
  app.addHook("onRequestAbort", async (request) => { releaseVaultWork(request); });

  app.get("/", async (request, reply) => {
    const supplied = (request.query as { launch?: string }).launch;
    if (!launchConsumed && supplied === launchNonce) {
      launchConsumed = true;
      reply.header("Set-Cookie", `trajpack_session=${sessionSecret}; HttpOnly; SameSite=Strict; Path=/`);
    } else if (parseCookies(request.headers.cookie).trajpack_session !== sessionSecret) {
      return requestError(reply, 401, "launch_nonce_required", "Use the one-time reviewer launch URL");
    }
    const dist = options.reviewerDist ?? defaultReviewerDist();
    try {
      return reply.type("text/html; charset=utf-8").send(await readFile(join(dist, "index.html"), "utf8"));
    } catch {
      return reply.type("text/html; charset=utf-8").send("<!doctype html><meta charset=utf-8><title>trajpack</title><p>Build @trajpack/reviewer before running review.</p>");
    }
  });

  app.options("/v1/browser/captures", async (request, reply) => {
    const requestOrigin = request.headers.origin;
    if (request.headers.host !== hostHeader || !extensionOrigin(requestOrigin)) return reply.code(403).send();
    return reply
      .header("Access-Control-Allow-Origin", requestOrigin)
      .header("Access-Control-Allow-Headers", "Content-Type,X-Trajpack-Pairing-Nonce,X-Trajpack-Recipe-Sha256")
      .header("Access-Control-Allow-Methods", "POST,OPTIONS")
      .header("Vary", "Origin")
      .code(204)
      .send();
  });

  app.post("/v1/browser/captures", async (request, reply) => {
    const requestOrigin = request.headers.origin;
    const suppliedNonce = request.headers["x-trajpack-pairing-nonce"] as string | undefined;
    if (request.headers.host !== hostHeader || !extensionOrigin(requestOrigin)
      || !browserPairingNonce || !equalSecret(suppliedNonce, browserPairingNonce)) {
      return reply.code(403).send({ error: "pairing_rejected" });
    }
    const metadata = browserCaptureMetadata(request.body);
    const suppliedRecipe = request.headers["x-trajpack-recipe-sha256"] as string | undefined;
    if (!equalSecret(suppliedRecipe, metadata.recipeSha256)) {
      return reply.code(409).send({ error: "recipe_hash_mismatch" });
    }
    browserPairingNonce = null;
    const source = defaultSource("browser", "unknown");
    source.origin = metadata.origin;
    source.interface_version = metadata.envelope.interface_version;
    const manifest = createManifest({
      source,
      accountType: "unknown",
      rights: {
        source_license_expression: "NOASSERTION",
        model_license_chain: [],
        input_rights_basis: "unknown",
        third_party_content: "unknown",
        rights_holder: null,
      },
      consentReceipt: consentReceipt("browser", `${metadata.origin}:${metadata.recipeSha256}`),
      consentPurposes: ["archive", "authorized-capture", "review"],
      terms: [],
      writtenPermissionRef: metadata.evidenceRef,
    });
    manifest.lineage.raw_sha256 = sha256(canonicalJson([metadata.envelope]));
    const preflight = evaluateGate({ manifest, raw: [metadata.envelope], events: [] }, "automatic_capture");
    if (!preflight.allowed) {
      return reply.code(409).send({ error: "policy_blocked", reasons: preflight.reasonCodes });
    }
    const captureSession = await CaptureSession.create("browser", manifest, passphrase, paths);
    try {
      await captureSession.ingest(metadata.envelope);
      const bundle = await captureSession.finalize();
      return reply
        .header("Access-Control-Allow-Origin", requestOrigin)
        .header("Vary", "Origin")
        .code(201)
        .send({ accepted: true, trace_id: bundle.manifest.trace_id });
    } catch (error) {
      await captureSession.abort();
      throw error;
    }
  });

  app.get(`${API}/bootstrap`, async (request, reply) => {
    if (parseCookies(request.headers.cookie).trajpack_session !== sessionSecret) return requestError(reply, 401, "session_required", "Reviewer launch session required");
    return {
      api_version: "review/0.1",
      csrf_token: csrf,
      server_version: "0.1.0",
      vault: { state: locked ? "locked" : "unlocked", idle_lock_at: locked ? null : new Date(idleLockAt).toISOString() },
    };
  });

  app.get(`${API}/traces`, async () => {
    const traces: ReturnType<typeof summary>[] = [];
    // Vault decryption is deliberately sequential: each encrypted trace has a
    // bounded read. Convert each trace to its compact summary immediately so
    // full decrypted bundles are not retained for the entire vault listing.
    for (const traceId of await listTraceIds(paths)) {
      traces.push(summary(await loadTrace(traceId, passphrase, paths)));
    }
    return { traces };
  });

  app.get(`${API}/traces/:traceId`, async (request) => {
    const { traceId } = request.params as { traceId: string };
    if (!TRACE_ID.test(traceId)) throw Object.assign(new Error("Invalid trace id"), { statusCode: 400, code: "invalid_trace_id" });
    return detail(await loadTrace(traceId, passphrase, paths));
  });

  app.patch(`${API}/traces/:traceId/events/:eventId`, async (request) => {
    const { traceId, eventId } = request.params as { traceId: string; eventId: string };
    return withTraceLock(traceId, async () => {
      const bundle = await loadTrace(traceId, passphrase, paths);
      assertRevision(bundle, request.body);
      const patch = request.body as { disposition?: "include" | "exclude" | "redact"; note?: string | null; redaction_replacement?: string | null };
      if (patch.disposition && !["include", "exclude", "redact"].includes(patch.disposition)) throw Object.assign(new Error("Invalid disposition"), { statusCode: 400, code: "invalid_request" });
      let found = false;
      const events = bundle.events.map((event) => {
        if (event.event_id !== eventId) return event;
        found = true;
        const previous = getReview(event);
        const disposition = patch.disposition ?? previous.disposition ?? (event.review_disposition === "exclude" ? "exclude" : "include");
        const replacement = patch.redaction_replacement === undefined ? previous.redaction_replacement ?? null : patch.redaction_replacement;
        const redacted = disposition === "redact"
          ? redactReviewContent(event, replacement ?? DEFAULT_REVIEW_REDACTION)
          : null;
        return {
          ...event,
          review_disposition: disposition === "exclude" ? "exclude" as const : "include" as const,
          content: redacted?.content ?? event.content,
          tool: redacted?.tool ?? event.tool,
          links: redacted?.links ?? event.links,
          metadata: {
            ...(redacted?.metadata ?? event.metadata),
            trajpack_review: {
              ...previous,
              disposition,
              ...(patch.note === undefined ? {} : { note: patch.note }),
              ...(patch.redaction_replacement === undefined ? {} : { redaction_replacement: patch.redaction_replacement }),
              updated_at: new Date().toISOString(),
            },
          },
        };
      });
      if (!found) throw Object.assign(new Error("Event not found"), { statusCode: 404, code: "event_not_found" });
      const updated = editedBundle(bundle, events);
      await replaceTrace(updated, passphrase, paths);
      return detail(updated);
    });
  });

  app.patch(`${API}/traces/:traceId/events/:eventId/rights`, async (request) => {
    const { traceId, eventId } = request.params as { traceId: string; eventId: string };
    return withTraceLock(traceId, async () => {
      const bundle = await loadTrace(traceId, passphrase, paths);
      assertRevision(bundle, request.body);
      const body = request.body as {
        rights_override?: unknown;
        modes?: unknown;
        reviewer?: unknown;
        evidence_ref?: unknown;
        evidence_sha256?: unknown;
        expires_at?: unknown;
      };
      const rawOverride = body.rights_override;
      if (rawOverride === undefined) {
        throw Object.assign(new Error("rights_override is required"), { statusCode: 400, code: "invalid_request" });
      }
      const rightsOverride = rawOverride === null ? null : rightsSchema.parse(rawOverride);
      const now = new Date();
      let modes: ApprovalMode[] = [];
      if (rightsOverride !== null) {
        modes = Array.isArray(body.modes) ? [...new Set(body.modes)] as ApprovalMode[] : [];
        if (modes.length === 0 || modes.some((mode) => !RIGHTS_OVERRIDE_MODES.includes(mode as typeof RIGHTS_OVERRIDE_MODES[number]))) {
          throw Object.assign(new Error("Rights override requires at least one training or redistribution mode"), { statusCode: 400, code: "invalid_request" });
        }
        if (typeof body.reviewer !== "string" || !body.reviewer.trim()
          || typeof body.evidence_ref !== "string" || !body.evidence_ref.trim()
          || typeof body.evidence_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.evidence_sha256)
          || typeof body.expires_at !== "string" || !Number.isFinite(Date.parse(body.expires_at))
          || Date.parse(body.expires_at) <= now.getTime()) {
          throw Object.assign(new Error("Reviewer, evidence reference/SHA-256, and a future expiry are required"), { statusCode: 400, code: "invalid_request" });
        }
      }
      let found = false;
      const events = bundle.events.map((event) => {
        if (event.event_id !== eventId) return event;
        found = true;
        const previous = getReview(event);
        const {
          rights_override: _previousRights,
          rights_attestation: _previousAttestation,
          ...reviewWithoutRights
        } = previous;
        const attestation = rightsOverride === null ? null : rightsOverrideAttestationSchema.parse({
          schema_version: "rights-attestation/0.1",
          rights: rightsOverride,
          scopes: modes.map((mode) => {
            const decision = eligibilityForMode(bundle.manifest, mode);
            return {
              mode,
              target_model_owner: decision.target_model_owner,
              target_product: decision.target_product,
            };
          }),
          reviewer: (body.reviewer as string).trim(),
          evidence_ref: (body.evidence_ref as string).trim(),
          evidence_sha256: body.evidence_sha256,
          attested_at: now.toISOString(),
          expires_at: body.expires_at,
          event_sha256: reviewEvidenceFingerprint(event),
          source_sha256: sha256(canonicalJson(bundle.manifest.source)),
        });
        return {
          ...event,
          content: event.content.map((part) => ({ ...part, rights_override: rightsOverride })),
          metadata: {
            ...event.metadata,
            trajpack_review: {
              ...reviewWithoutRights,
              ...(rightsOverride === null ? {} : { rights_override: rightsOverride, rights_attestation: attestation }),
              updated_at: now.toISOString(),
            },
          },
        };
      });
      if (!found) throw Object.assign(new Error("Event not found"), { statusCode: 404, code: "event_not_found" });
      const updated = editedBundle(bundle, events);
      await replaceTrace(updated, passphrase, paths);
      return detail(updated);
    });
  });

  app.patch(`${API}/traces/:traceId/events/:eventId/verifier`, async (request) => {
    const { traceId, eventId } = request.params as { traceId: string; eventId: string };
    return withTraceLock(traceId, async () => {
      const bundle = await loadTrace(traceId, passphrase, paths);
      assertRevision(bundle, request.body);
      const body = request.body as {
        confirmation?: null | { reviewer?: unknown; evidence_ref?: unknown };
      };
      if (body.confirmation === undefined) {
        throw Object.assign(new Error("confirmation is required"), { statusCode: 400, code: "invalid_request" });
      }
      const confirmationRequest = body.confirmation;
      let found = false;
      const events = bundle.events.map((event) => {
        if (event.event_id !== eventId) return event;
        found = true;
        const previous = getReview(event);
        const {
          verifier_confirmation: _previousConfirmation,
          verifier_confirmed: _legacyConfirmation,
          ...reviewWithoutVerifier
        } = previous as StoredReview & { verifier_confirmed?: unknown };
        let confirmation: VerifierConfirmation | null = null;
        if (confirmationRequest !== null) {
          if (typeof confirmationRequest.reviewer !== "string" || !confirmationRequest.reviewer.trim()
            || typeof confirmationRequest.evidence_ref !== "string" || !confirmationRequest.evidence_ref.trim()) {
            throw Object.assign(new Error("Reviewer and verifier evidence reference are required"), { statusCode: 400, code: "invalid_request" });
          }
          const candidate = verifierCandidate(event);
          confirmation = verifierConfirmationSchema.parse({
            schema_version: "verifier-confirmation/0.1",
            reviewer: confirmationRequest.reviewer.trim(),
            evidence_ref: confirmationRequest.evidence_ref.trim(),
            confirmed_at: new Date().toISOString(),
            event_sha256: reviewEvidenceFingerprint(event),
            reward: candidate.reward,
            verifier: candidate.verifier,
          });
        }
        return {
          ...event,
          metadata: {
            ...event.metadata,
            trajpack_review: {
              ...reviewWithoutVerifier,
              ...(confirmation === null ? {} : { verifier_confirmation: confirmation }),
              updated_at: new Date().toISOString(),
            },
          },
        };
      });
      if (!found) throw Object.assign(new Error("Event not found"), { statusCode: 404, code: "event_not_found" });
      const updated = editedBundle(bundle, events);
      await replaceTrace(updated, passphrase, paths);
      return detail(updated);
    });
  });

  app.post(`${API}/traces/:traceId/decision`, async (request) => {
    const { traceId } = request.params as { traceId: string };
    return withTraceLock(traceId, async () => {
      const bundle = await loadTrace(traceId, passphrase, paths);
      assertRevision(bundle, request.body);
      const body = request.body as {
        decision?: "approved" | "rejected";
        reviewer?: string;
        notes?: string;
        approved_modes?: ApprovalMode[];
      };
      if (!body.reviewer?.trim() || !body.notes?.trim() || !["approved", "rejected"].includes(body.decision ?? "")) {
        throw Object.assign(new Error("decision, reviewer, and notes are required"), { statusCode: 400, code: "invalid_request" });
      }
      const approvalModes = [...new Set(body.approved_modes ?? [])];
      if (body.decision === "approved" && (approvalModes.length === 0
        || approvalModes.some((mode) => !["archive", "training_noncompetitive", "training_competitive_distillation", "redistribution"].includes(mode)))) {
        throw Object.assign(new Error("approved_modes must contain at least one supported purpose"), { statusCode: 400, code: "invalid_request" });
      }
      let updated: TraceBundle = {
        ...bundle,
        manifest: {
          ...bundle.manifest,
          review: {
            ...bundle.manifest.review,
            revision: bundle.manifest.review.revision + 1,
            human_approval: body.decision!,
            reviewer: body.reviewer!,
            reviewed_at: new Date().toISOString(),
            notes: body.notes!,
            approval_scope: null,
          },
        },
      };
      if (body.decision === "approved") {
        updated.manifest.review.approval_scope = createApprovalScope(updated, approvalModes);
        const failedChecks = checks(updated).filter((item) => item.status === "failed");
        const blocked = approvalModes.flatMap((mode) => [
          ...evaluateGate(updated, mode).reasonCodes,
          ...validateApprovalScope(updated, mode),
        ]);
        if (blocked.length || failedChecks.length) {
          throw Object.assign(new Error(`Approval blocked: ${[...new Set([...blocked, ...failedChecks.map((item) => item.label)])].join(", ")}`), { statusCode: 409, code: "approval_blocked" });
        }
      }
      await replaceTrace(updated, passphrase, paths);
      return detail(updated);
    });
  });

  const preview = async (traceId: string, body: unknown) => {
    const bundle = await loadTrace(traceId, passphrase, paths);
    assertRevision(bundle, body);
    const format = (body as { format?: ExportFormat }).format;
    const exportMode = (body as { mode?: ApprovalMode }).mode;
    if (!format || !["canonical", "atif", "hf-trl", "otlp"].includes(format)) throw Object.assign(new Error("Invalid export format"), { statusCode: 400, code: "invalid_request" });
    if (!exportMode || !["archive", "training_noncompetitive", "training_competitive_distillation", "redistribution"].includes(exportMode)) {
      throw Object.assign(new Error("Invalid export eligibility mode"), { statusCode: 400, code: "invalid_request" });
    }
    if (format === "hf-trl" && !exportMode.startsWith("training_")) {
      throw Object.assign(new Error("HF/TRL requires a training eligibility mode"), { statusCode: 400, code: "invalid_request" });
    }
    const gate = evaluateGate(bundle, exportMode);
    const excluded = bundle.events.filter((event) => event.review_disposition === "exclude").length;
    const redacted = bundle.events.flatMap((event) => event.content).filter((part) => part.redaction_status === "redacted").length;
    const reviewReasons = validateApprovalScope(bundle, exportMode);
    const blockReasons = [...new Set([...gate.reasonCodes, ...reviewReasons])];
    return {
      bundle,
      result: {
        trace_id: traceId,
        format,
        mode: exportMode,
        destination_hint: join(outputRoot, `${traceId}-${format}-<timestamp>`),
        example_count: format === "hf-trl" ? 1 : bundle.events.length,
        plaintext_bytes_estimate: Buffer.byteLength(canonicalJson(bundle), "utf8"),
        excluded_event_count: excluded,
        redacted_part_count: redacted,
        license_summary: bundle.manifest.rights.source_license_expression,
        warnings: ["Plaintext exports leave the managed vault and cannot be recalled automatically."],
        export_allowed: blockReasons.length === 0,
        block_reasons: blockReasons,
        confirmation_phrase: "EXPORT PLAINTEXT" as const,
      },
    };
  };

  app.post(`${API}/traces/:traceId/export-preview`, async (request) => {
    const { traceId } = request.params as { traceId: string };
    return (await preview(traceId, request.body)).result;
  });

  app.post(`${API}/traces/:traceId/exports`, async (request) => {
    const { traceId } = request.params as { traceId: string };
    return withTraceLock(traceId, async () => {
      const { bundle, result } = await preview(traceId, request.body);
      if ((request.body as { confirmation_phrase?: string }).confirmation_phrase !== "EXPORT PLAINTEXT") {
        throw Object.assign(new Error("Exact plaintext confirmation phrase required"), { statusCode: 400, code: "confirmation_required" });
      }
      if (!result.export_allowed) throw Object.assign(new Error(`Export blocked: ${result.block_reasons.join(", ")}`), { statusCode: 409, code: "export_blocked" });
      await mkdir(outputRoot, { recursive: true });
      const createdAt = new Date();
      const destination = join(outputRoot, `${traceId}-${result.format}-${createdAt.toISOString().replace(/[:.]/g, "-")}`);
      await exportApprovedBundle(bundle, {
        format: result.format,
        outputDirectory: destination,
        mode: result.mode,
      });
      const checksum = sha256(await readFile(join(destination, "checksums.txt")));
      return {
        export_id: stableId("export", { traceId, format: result.format, mode: result.mode, createdAt: createdAt.toISOString() }),
        trace_id: traceId,
        format: result.format,
        created_at: createdAt.toISOString(),
        destination,
        sha256: checksum,
      };
    });
  });

  app.setErrorHandler((error, _request, reply) => {
    const shaped = error as Error & { statusCode?: number; code?: string };
    const status = shaped.statusCode ?? (shaped.message.includes("authentication failed") ? 423 : 500);
    const code = shaped.code ?? (status === 423 ? "vault_locked" : "request_failed");
    return requestError(reply, status, code, status >= 500 ? "Reviewer request failed" : shaped.message);
  });

  const dist = options.reviewerDist ?? defaultReviewerDist();
  try {
    const assets = join(dist, "assets");
    if ((await stat(assets)).isDirectory()) await app.register(fastifyStatic, { root: assets, prefix: "/assets/", decorateReply: false });
  } catch {
    // The root route provides a non-secret build instruction when assets are absent.
  }

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("Unable to determine reviewer port");
  hostHeader = `127.0.0.1:${address.port}`;
  origin = `http://${hostHeader}`;

  return {
    server: app,
    url: origin,
    launchUrl: `${origin}/?launch=${launchNonce}#reviewer_token=${encodeURIComponent(reviewerApiToken)}`,
    browserPairingNonce: browserPairingNonce!,
    close: async () => { clearTimeout(idleTimer); passphrase = ""; await app.close(); },
  };
}
