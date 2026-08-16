import { z } from "zod";

export const SCHEMA_VERSION = "trajectory/0.1" as const;

export const decisionStatusSchema = z.enum(["allow", "deny", "unknown"]);
export type DecisionStatus = z.infer<typeof decisionStatusSchema>;

export const hostSchema = z.enum([
  "codex",
  "claude_code",
  "deepseek_harness",
  "browser",
  "manual_import",
]);
export type Host = z.infer<typeof hostSchema>;

export const providerSchema = z.enum([
  "openai",
  "anthropic",
  "deepseek",
  "self_hosted",
  "other",
  "unknown",
]);
export type Provider = z.infer<typeof providerSchema>;

export const accountTypeSchema = z.enum([
  "consumer",
  "api",
  "business",
  "enterprise",
  "managed_workspace",
  "self_hosted",
  "unknown",
]);
export type AccountType = z.infer<typeof accountTypeSchema>;

export const sourceSchema = z.object({
  host: hostSchema,
  provider: providerSchema,
  product: z.string().min(1),
  surface: z.enum(["api", "cli", "harness", "web", "official_export", "manual_import"]),
  capture_method: z.enum([
    "official_stream",
    "official_hook",
    "official_export",
    "instrumented_harness",
    "authorized_dom",
    "manual_copy",
  ]),
  adapter_version: z.string().min(1),
  interface_version: z.string().min(1),
  model_id: z.string().min(1).nullable().default(null),
  model_snapshot_or_weights_digest: z.string().min(1).nullable().default(null),
  origin: z.string().min(1).nullable().default(null),
  fidelity: z.enum(["A", "B", "C"]),
});
export type Source = z.infer<typeof sourceSchema>;

export const termsSnapshotSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  effective_at: z.string().datetime(),
  retrieved_at: z.string().datetime(),
  snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  review_after: z.string().datetime(),
});
export type TermsSnapshot = z.infer<typeof termsSnapshotSchema>;

export const permissionEvidenceSchema = z.object({
  evidence_ref: z.string().min(1),
  provider: providerSchema,
  account_type: accountTypeSchema,
  capture_methods: z.array(z.enum([
    "official_stream", "official_hook", "official_export", "instrumented_harness", "authorized_dom", "manual_copy",
  ])).min(1),
  origins: z.array(z.string().url()).default([]),
  permitted_purposes: z.array(z.enum([
    "automatic_capture", "training_noncompetitive", "training_competitive_distillation", "redistribution",
  ])).min(1),
  target_model_owner: z.string().min(1).nullable().default(null),
  target_product: z.string().min(1).nullable().default(null),
  reviewer: z.string().min(1),
  effective_at: z.string().datetime(),
  expires_at: z.string().datetime(),
}).superRefine((evidence, context) => {
  if (Date.parse(evidence.effective_at) >= Date.parse(evidence.expires_at)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Permission evidence must expire after it becomes effective",
      path: ["expires_at"],
    });
  }
  if ((evidence.target_model_owner === null) !== (evidence.target_product === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Permission evidence target owner and product must be set together",
      path: ["target_model_owner"],
    });
  }
});
export type PermissionEvidence = z.infer<typeof permissionEvidenceSchema>;

export const eligibilityDecisionSchema = z.object({
  status: decisionStatusSchema,
  purposes: z.array(z.string().min(1)).default([]),
  reason_codes: z.array(z.string().min(1)).default([]),
  basis: z.string().min(1),
  target_model_owner: z.string().min(1).nullable().default(null),
  target_product: z.string().min(1).nullable().default(null),
  competitive_with_source: z.enum(["yes", "no", "unknown"]),
  decision_id: z.string().min(1),
  decided_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  reviewer: z.string().min(1).nullable().default(null),
  evidence_ref: z.string().min(1).nullable().default(null),
});
export type EligibilityDecision = z.infer<typeof eligibilityDecisionSchema>;

export const eligibilitySchema = z.object({
  local_archive: eligibilityDecisionSchema,
  automatic_capture: eligibilityDecisionSchema,
  training_noncompetitive: eligibilityDecisionSchema,
  training_competitive_distillation: eligibilityDecisionSchema,
  redistribution: eligibilityDecisionSchema,
});
export type Eligibility = z.infer<typeof eligibilitySchema>;

export const reasoningMetadataSchema = z.object({
  representation: z.enum([
    "provider_exposed_reasoning",
    "provider_summary",
    "generated_rationale",
    "opaque_reasoning_state",
    "unavailable",
  ]),
  provider_claim: z.enum(["chain_of_thought", "reasoning_summary", "rationale", "none"]),
  source_field: z.string().nullable().default(null),
  visibility: z.enum(["user_visible", "api_only", "not_returned"]),
  include_in_loss: z.boolean().default(false),
});
export type ReasoningMetadata = z.infer<typeof reasoningMetadataSchema>;

export const rightsSchema = z.object({
  // Preserve NOASSERTION as an archive-time sentinel, but canonicalize user
  // supplied whitespace so policy checks cannot be bypassed with lookalikes.
  source_license_expression: z.string().trim().min(1),
  model_license_chain: z.array(z.string().trim().min(1)).default([]),
  input_rights_basis: z.enum(["owned", "licensed", "consented", "public_domain", "unknown"]),
  third_party_content: z.enum(["none", "present", "unknown"]),
  rights_holder: z.string().nullable().default(null),
});
export type Rights = z.infer<typeof rightsSchema>;

export const consentSchema = z.object({
  receipt_id: z.string().min(1),
  subjects_scope: z.enum(["single_user", "workspace", "all_participants"]),
  purposes: z.array(z.string().min(1)),
  active: z.boolean(),
  captured_at: z.string().datetime(),
  withdrawal_ref: z.string().nullable().default(null),
});

export const contentPartSchema = z.object({
  ordinal: z.number().int().nonnegative(),
  type: z.enum([
    "text",
    "reasoning",
    "image_ref",
    "audio_ref",
    "file_ref",
    "patch",
    "stdout",
    "stderr",
    "tool_call",
    "tool_result",
  ]),
  mime_type: z.string().min(1),
  value: z.string().nullable().default(null),
  blob_ref: z.string().nullable().default(null),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sensitivity: z.enum(["public", "internal", "confidential", "restricted"]),
  redaction_status: z.enum(["not_scanned", "passed", "redacted", "quarantined"]),
  review_disposition: z.enum(["include", "exclude"]).default("include"),
  reasoning: reasoningMetadataSchema.nullable().default(null),
  rights_override: rightsSchema.nullable().default(null),
});
export type ContentPart = z.infer<typeof contentPartSchema>;

export const eventTypeSchema = z.enum([
  "message",
  "model.inference",
  "reasoning",
  "plan",
  "agent.invoke",
  "handoff",
  "tool.call",
  "tool.result",
  "retrieval",
  "artifact.read",
  "artifact.write",
  "artifact.patch",
  "approval.request",
  "approval.decision",
  "compaction",
  "feedback",
  "evaluation",
  "error",
]);
export type EventType = z.infer<typeof eventTypeSchema>;

export const approvalModeSchema = z.enum([
  "archive",
  "training_noncompetitive",
  "training_competitive_distillation",
  "redistribution",
]);
export type ApprovalMode = z.infer<typeof approvalModeSchema>;

export const rightsOverrideScopeSchema = z.object({
  mode: approvalModeSchema,
  target_model_owner: z.string().min(1).nullable(),
  target_product: z.string().min(1).nullable(),
});
export type RightsOverrideScope = z.infer<typeof rightsOverrideScopeSchema>;

/**
 * A reviewer-created, purpose-scoped assertion for per-event content/tool
 * rights. The event digest is calculated with review metadata and embedded
 * content rights removed, so the assertion binds the provider payload without
 * hashing itself.
 */
export const rightsOverrideAttestationSchema = z.object({
  schema_version: z.literal("rights-attestation/0.1"),
  rights: rightsSchema,
  scopes: z.array(rightsOverrideScopeSchema).min(1),
  reviewer: z.string().trim().min(1),
  evidence_ref: z.string().trim().min(1),
  evidence_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  attested_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  event_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).superRefine((attestation, context) => {
  if (Date.parse(attestation.expires_at) <= Date.parse(attestation.attested_at)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Rights attestation must expire after it is created" });
  }
});
export type RightsOverrideAttestation = z.infer<typeof rightsOverrideAttestationSchema>;

export const verifierEvidenceSchema = z.object({
  name: z.string().trim().min(1),
  version: z.string().trim().min(1),
  artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  result_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
}).superRefine((verifier, context) => {
  if (verifier.artifact_sha256 === null && verifier.result_sha256 === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Verifier evidence requires an artifact or result digest" });
  }
});
export type VerifierEvidence = z.infer<typeof verifierEvidenceSchema>;

/** A local reviewer confirmation of a concrete, versioned verifier result. */
export const verifierConfirmationSchema = z.object({
  schema_version: z.literal("verifier-confirmation/0.1"),
  reviewer: z.string().trim().min(1),
  evidence_ref: z.string().trim().min(1),
  confirmed_at: z.string().datetime(),
  event_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  reward: z.number().finite(),
  verifier: verifierEvidenceSchema,
});
export type VerifierConfirmation = z.infer<typeof verifierConfirmationSchema>;

export const approvalScopeSchema = z.object({
  bundle_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  approved_source_bundle_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  export_pass_version: z.string().min(1).optional(),
  reviewer: z.string().min(1),
  reviewed_at: z.string().datetime(),
  notes_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  decisions: z.array(z.object({
    mode: approvalModeSchema,
    decision_id: z.string().min(1),
    target_model_owner: z.string().nullable(),
    target_product: z.string().nullable(),
  })).min(1),
});
export type ApprovalScope = z.infer<typeof approvalScopeSchema>;

export const trajectoryEventSchema = z.object({
  record_type: z.literal("event"),
  event_id: z.string().min(1),
  trace_id: z.string().regex(/^[a-f0-9]{32}$/),
  span_id: z.string().regex(/^[a-f0-9]{16}$/),
  parent_span_id: z.string().regex(/^[a-f0-9]{16}$/).nullable().default(null),
  links: z.array(z.object({ trace_id: z.string(), span_id: z.string(), relation: z.string() })).default([]),
  sequence: z.number().int().nonnegative(),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime().nullable().default(null),
  event_type: eventTypeSchema,
  actor: z.enum(["user", "assistant", "system", "developer", "agent", "tool", "environment"]),
  status: z.enum(["ok", "error", "cancelled", "partial"]),
  source_event_id: z.string().nullable().default(null),
  source_session_id: z.string().nullable().default(null),
  source_turn_id: z.string().nullable().default(null),
  source_step_id: z.string().nullable().default(null),
  content: z.array(contentPartSchema).default([]),
  tool: z.object({
    call_id: z.string().nullable().default(null),
    name: z.string().nullable().default(null),
    arguments: z.unknown().nullable().default(null),
    result: z.unknown().nullable().default(null),
    exit_code: z.number().int().nullable().default(null),
  }).nullable().default(null),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().nullable().default(null),
    output_tokens: z.number().int().nonnegative().nullable().default(null),
    reasoning_tokens: z.number().int().nonnegative().nullable().default(null),
    cache_read_tokens: z.number().int().nonnegative().nullable().default(null),
    latency_ms: z.number().nonnegative().nullable().default(null),
    cost_usd: z.number().nonnegative().nullable().default(null),
  }).default({
    input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    cache_read_tokens: null,
    latency_ms: null,
    cost_usd: null,
  }),
  metadata: z.record(z.string(), z.unknown()).default({}),
  review_disposition: z.enum(["include", "exclude"]).default("include"),
});
export type TrajectoryEvent = z.infer<typeof trajectoryEventSchema>;

export const traceManifestSchema = z.object({
  record_type: z.literal("trace_manifest"),
  schema_version: z.literal(SCHEMA_VERSION),
  trace_id: z.string().regex(/^[a-f0-9]{32}$/),
  created_at: z.string().datetime(),
  source: sourceSchema,
  account_contract: z.object({
    account_type: accountTypeSchema,
    contracting_region: z.string().nullable().default(null),
    workspace_owner_hmac: z.string().nullable().default(null),
    terms: z.array(termsSnapshotSchema),
    order_form_or_written_permission_ref: z.string().nullable().default(null),
    scoped_permission: permissionEvidenceSchema.optional(),
  }),
  rights: rightsSchema,
  consent: consentSchema,
  eligibility: eligibilitySchema,
  privacy: z.object({
    legal_basis: z.string().min(1),
    jurisdictions: z.array(z.string()).default([]),
    storage_region: z.string().min(1),
    retention_class: z.string().min(1),
    redaction_policy_version: z.string().min(1),
  }),
  environment: z.object({
    cwd_hmac: z.string().nullable().default(null),
    repo_commit: z.string().nullable().default(null),
    container_digest: z.string().nullable().default(null),
  }).default({ cwd_hmac: null, repo_commit: null, container_digest: null }),
  review: z.object({
    revision: z.number().int().nonnegative().default(0),
    automated_checks: z.enum(["pending", "passed", "failed"]),
    human_approval: z.enum(["pending", "approved", "rejected"]),
    reviewer: z.string().nullable().default(null),
    reviewed_at: z.string().datetime().nullable().default(null),
    notes: z.string().nullable().default(null),
    approval_scope: approvalScopeSchema.nullable().default(null),
  }).superRefine((review, context) => {
    if (review.human_approval !== "approved") return;
    if (!review.reviewer || !review.reviewed_at || !review.notes || !review.approval_scope) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Approved review requires reviewer, time, notes, and scoped attestation" });
    }
  }),
  lineage: z.object({
    parent_trace_ids: z.array(z.string()).default([]),
    raw_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
    normalizer_version: z.string().min(1),
    tombstoned: z.boolean().default(false),
  }),
});
export type TraceManifest = z.infer<typeof traceManifestSchema>;

export const rawEnvelopeSchema = z.object({
  envelope_version: z.literal("raw/0.1"),
  adapter: hostSchema,
  adapter_version: z.string().min(1),
  interface_version: z.string().min(1),
  captured_at: z.string().datetime(),
  sequence: z.number().int().nonnegative(),
  source_event_id: z.string().nullable().default(null),
  session_id: z.string().nullable().default(null),
  turn_id: z.string().nullable().default(null),
  payload_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z.unknown(),
});
export type RawEnvelope = z.infer<typeof rawEnvelopeSchema>;

export const traceBundleSchema = z.object({
  manifest: traceManifestSchema,
  events: z.array(trajectoryEventSchema),
  raw: z.array(rawEnvelopeSchema).default([]),
});
export type TraceBundle = z.infer<typeof traceBundleSchema>;

export const datasetExampleSchema = z.object({
  id: z.string().min(1),
  trace_id: z.string(),
  source_event_ids: z.array(z.string()),
  messages: z.array(z.record(z.string(), z.unknown())),
  tools: z.array(z.record(z.string(), z.unknown())).default([]),
  assistant_loss_mask: z.array(z.boolean()),
  reward: z.number().nullable().default(null),
  verifier: z.object({ name: z.string(), version: z.string() }).nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type DatasetExample = z.infer<typeof datasetExampleSchema>;

export function assertTraceBundle(input: unknown): TraceBundle {
  return traceBundleSchema.parse(input);
}

/**
 * Historical schemas are never coerced by the validator. Every supported
 * upgrade must be registered as an explicit, testable migration step here.
 */
export const TRACE_MIGRATION_PATHS: Readonly<Record<string, string>> = Object.freeze({});

export function migrateTraceBundle(input: unknown, targetVersion = SCHEMA_VERSION): TraceBundle {
  if (targetVersion !== SCHEMA_VERSION) throw new Error(`Unsupported trajectory migration target: ${targetVersion}`);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Trace bundle must be an object");
  const manifest = (input as { manifest?: unknown }).manifest;
  const sourceVersion = manifest && typeof manifest === "object" && !Array.isArray(manifest)
    ? (manifest as { schema_version?: unknown }).schema_version
    : undefined;
  if (sourceVersion !== SCHEMA_VERSION) {
    throw new Error(`No explicit trajectory migration is registered from ${String(sourceVersion)} to ${targetVersion}`);
  }
  return traceBundleSchema.parse(input);
}
