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
  authenticity: z.enum([
    "cryptographically_verified",
    "request_receipt_verified",
    "locally_observed",
    "user_supplied",
    "user_authorized_observation",
    "unknown",
  ]).default("unknown"),
  authenticity_evidence_ref: z.string().trim().min(1).nullable().default(null),
}).superRefine((source, context) => {
  if ((source.authenticity === "cryptographically_verified" || source.authenticity === "request_receipt_verified")
    && source.authenticity_evidence_ref === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["authenticity_evidence_ref"],
      message: "Verified source authenticity requires a concrete evidence reference",
    });
  }
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
  training_targets: z.array(z.object({
    message_index: z.number().int().nonnegative(),
    components: z.array(z.enum([
      "answer_text",
      "reasoning",
      "tool_name",
      "tool_arguments",
      "plan",
    ])).min(1),
    loss_weight: z.number().positive().finite().default(1),
    source_event_ids: z.array(z.string().min(1)).min(1),
  })).default([]),
  reward: z.number().nullable().default(null),
  verifier: z.object({ name: z.string(), version: z.string() }).nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).superRefine((example, context) => {
  if (example.messages.length !== example.assistant_loss_mask.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["assistant_loss_mask"],
      message: "Assistant loss mask must align one-to-one with messages",
    });
  }
  const allowedRoles = new Set(["system", "developer", "user", "assistant", "tool"]);
  const observedToolCalls = new Set<string>();
  for (const [index, message] of example.messages.entries()) {
    if (typeof message.role !== "string" || !allowedRoles.has(message.role)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["messages", index, "role"],
        message: "Dataset messages require a recognized conversational role",
      });
    }
    if (Array.isArray(message.tool_calls)) {
      for (const [callIndex, call] of message.tool_calls.entries()) {
        const id = call && typeof call === "object" && !Array.isArray(call)
          ? (call as Record<string, unknown>).id
          : undefined;
        if (message.role !== "assistant" || typeof id !== "string" || id.length === 0 || observedToolCalls.has(id)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["messages", index, "tool_calls", callIndex],
            message: "Tool calls require a unique id on an assistant message",
          });
        } else observedToolCalls.add(id);
      }
    }
    if (message.role === "tool") {
      if (typeof message.tool_call_id !== "string" || !observedToolCalls.has(message.tool_call_id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["messages", index, "tool_call_id"],
          message: "Tool results must reference a preceding assistant tool call",
        });
      }
    }
  }
  example.assistant_loss_mask.forEach((enabled, index) => {
    if (enabled && example.messages[index]?.role !== "assistant") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assistant_loss_mask", index],
        message: "Only assistant messages may be loss targets",
      });
    }
  });
  for (const [index, target] of example.training_targets.entries()) {
    if (target.message_index >= example.messages.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["training_targets", index, "message_index"],
        message: "Training target points beyond the message array",
      });
    }
    if (example.messages[target.message_index]?.role !== "assistant"
      || example.assistant_loss_mask[target.message_index] !== true) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["training_targets", index, "message_index"],
        message: "Training targets must point to an enabled assistant loss message",
      });
    }
  }
  if ((example.reward === null) !== (example.verifier === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reward"],
      message: "Reward and verifier provenance must be present together",
    });
  }
});
export type DatasetExample = z.infer<typeof datasetExampleSchema>;

export const DATASET_BUILD_VERSION = "dataset-build/0.1" as const;
export const DATASET_MANIFEST_VERSION = "dataset/0.1" as const;
export const DATASET_VIEW_COMPILER_VERSION = "trace-full-view/0.2" as const;
export const DATASET_QUALITY_COMPILER_VERSION = "trajectory-quality/0.1" as const;
/**
 * Freezes both exact canonical-view hashing and the privacy-preserving
 * token/code/tool shingle/Jaccard near-duplicate pass. A change to normalization,
 * shingling, thresholds, or resource limits requires a new compiler version.
 */
export const DATASET_DEDUPE_COMPILER_VERSION = "canonical-training-view+shingle-jaccard/0.3" as const;

export const datasetCompilerVersionsSchema = z.object({
  view: z.literal(DATASET_VIEW_COMPILER_VERSION),
  quality: z.literal(DATASET_QUALITY_COMPILER_VERSION),
  dedupe: z.literal(DATASET_DEDUPE_COMPILER_VERSION),
}).strict();
export type DatasetCompilerVersions = z.infer<typeof datasetCompilerVersionsSchema>;

export const datasetSplitSchema = z.enum(["train", "validation", "test"]);
export type DatasetSplit = z.infer<typeof datasetSplitSchema>;

export const datasetTargetSchema = z.object({
  model_owner: z.string().trim().min(1),
  product: z.string().trim().min(1),
}).strict();
export type DatasetTarget = z.infer<typeof datasetTargetSchema>;

export const datasetSplitPolicySchema = z.object({
  algorithm: z.literal("sha256-group-threshold-v1"),
  seed: z.string().min(1).max(128).regex(/^[^\u0000-\u001f\u007f]+$/u),
  ratios_bp: z.object({
    train: z.number().int().min(0).max(10_000),
    validation: z.number().int().min(0).max(10_000),
    test: z.number().int().min(0).max(10_000),
  }).strict(),
}).strict().superRefine((policy, context) => {
  if (policy.ratios_bp.train + policy.ratios_bp.validation + policy.ratios_bp.test !== 10_000) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["ratios_bp"],
      message: "Dataset split ratios must total 10000 basis points",
    });
  }
});
export type DatasetSplitPolicy = z.infer<typeof datasetSplitPolicySchema>;

export const datasetBuildSchema = z.object({
  record_type: z.literal("dataset_build"),
  schema_version: z.literal(DATASET_BUILD_VERSION),
  name: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
  policy_version: z.string().min(1),
  mode: approvalModeSchema,
  target: datasetTargetSchema.nullable(),
  // v0.1 intentionally exposes only the topology-preserving full trace view.
  // Additional recipes need their own versioned compiler and golden fixtures.
  view_recipe: z.literal("trace_full").default("trace_full"),
  quality_profile: z.enum(["sft_basic", "tool_agent_strict", "research_strict"]).default("research_strict"),
  compiler_versions: datasetCompilerVersionsSchema,
  split_policy: datasetSplitPolicySchema,
  traces: z.array(z.object({
    trace_id: z.string().regex(/^[a-f0-9]{32}$/u),
    split_group_id: z.string().regex(/^[a-f0-9]{64}$/u),
    group_basis: z.enum(["explicit_hmac", "trace_fallback"]),
    source_bundle_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    approval_scope_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    eligibility_decision_id: z.string().min(1),
  }).strict()).min(1).max(10_000),
}).strict().superRefine((build, context) => {
  const training = build.mode === "training_noncompetitive" || build.mode === "training_competitive_distillation";
  if (training !== (build.target !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["target"],
      message: training ? "Training dataset builds require an exact target" : "Archive and redistribution builds cannot declare a training target",
    });
  }
  const traceIds = new Set<string>();
  for (const [index, trace] of build.traces.entries()) {
    if (traceIds.has(trace.trace_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["traces", index, "trace_id"],
        message: "A dataset build cannot contain a trace more than once",
      });
    }
    traceIds.add(trace.trace_id);
  }
});
export type DatasetBuild = z.infer<typeof datasetBuildSchema>;

export const datasetManifestEntrySchema = z.object({
  trace_id: z.string().regex(/^[a-f0-9]{32}$/u),
  split: datasetSplitSchema,
  split_group_id: z.string().regex(/^[a-f0-9]{64}$/u),
  source_bundle_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  approval_scope_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  eligibility_decision_id: z.string().min(1),
  selected_bundle_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  example_ids: z.array(z.string().min(1)),
}).strict();
export type DatasetManifestEntry = z.infer<typeof datasetManifestEntrySchema>;

export const datasetArtifactPathSchema = z.string().min(1).superRefine((path, context) => {
  const components = path.split("/");
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/u.test(path)
    || path.includes("\\") || /[\u0000-\u001f\u007f]/u.test(path)
    || components.some((component) => component === "" || component === "." || component === "..")) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Dataset artifact paths must be normalized safe POSIX-relative paths",
    });
  }
});

export const datasetManifestSchema = z.object({
  record_type: z.literal("dataset_manifest"),
  schema_version: z.literal(DATASET_MANIFEST_VERSION),
  dataset_id: z.string().regex(/^[a-f0-9]{64}$/u),
  name: z.string().min(1),
  created_at: z.string().datetime(),
  format: z.enum(["canonical", "atif", "hf-trl", "otlp"]),
  mapping_version: z.string().min(1),
  mode: approvalModeSchema,
  target: datasetTargetSchema.nullable(),
  policy_version: z.string().min(1),
  view_recipe: z.literal("trace_full"),
  quality_profile: z.enum(["sft_basic", "tool_agent_strict", "research_strict"]),
  compiler_versions: datasetCompilerVersionsSchema,
  split_policy: datasetSplitPolicySchema,
  entries: z.array(datasetManifestEntrySchema).min(1),
  splits: z.record(datasetSplitSchema, z.object({
    traces: z.number().int().nonnegative(),
    examples: z.number().int().nonnegative(),
  }).strict()),
  artifacts: z.array(z.object({
    path: datasetArtifactPathSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    bytes: z.number().int().nonnegative(),
  }).strict()).default([]),
}).strict().superRefine((manifest, context) => {
  const traceIds = new Set<string>();
  const exampleIds = new Set<string>();
  for (const [entryIndex, entry] of manifest.entries.entries()) {
    if (traceIds.has(entry.trace_id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries", entryIndex, "trace_id"],
        message: "Dataset manifest trace ids must be unique",
      });
    }
    traceIds.add(entry.trace_id);
    for (const [exampleIndex, exampleId] of entry.example_ids.entries()) {
      if (exampleIds.has(exampleId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", entryIndex, "example_ids", exampleIndex],
          message: "Dataset manifest example ids must be globally unique",
        });
      }
      exampleIds.add(exampleId);
    }
  }
  const artifactPaths = new Set<string>();
  for (const [index, artifact] of manifest.artifacts.entries()) {
    if (artifactPaths.has(artifact.path)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifacts", index, "path"],
        message: "Dataset manifest artifact paths must be unique",
      });
    }
    artifactPaths.add(artifact.path);
  }
});
export type DatasetManifest = z.infer<typeof datasetManifestSchema>;

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
