import type {
  ApprovalMode,
  ContentPart,
  DatasetViewRecipe,
  Eligibility,
  Rights,
  RightsOverrideAttestation,
  TraceManifest,
  TrajectoryEvent,
  VerifierConfirmation,
} from "@trajpack/schema";

/**
 * UI-facing API contract. Canonical trace data remains typed by @trajpack/schema;
 * review metadata is deliberately separate so review actions never mutate raw data.
 */
export type ReviewDecision = "pending" | "approved" | "rejected";
export type EventDisposition = "include" | "exclude" | "redact";
export type CheckStatus = "passed" | "warning" | "failed";
export type CheckCategory = "structure" | "privacy" | "rights" | "quality";
export type ExportFormat = "canonical" | "atif" | "hf-trl" | "otlp";
export type ExportTrainingRecipe = Exclude<DatasetViewRecipe, "trace_full">;

export interface ReviewerBootstrap {
  api_version: "review/0.1";
  csrf_token: string;
  server_version: string;
  vault: {
    state: "locked" | "unlocked";
    idle_lock_at: string | null;
  };
}

export interface TraceSummary {
  trace_id: string;
  created_at: string;
  source: TraceManifest["source"];
  automated_checks: TraceManifest["review"]["automated_checks"];
  human_approval: TraceManifest["review"]["human_approval"];
  event_count: number;
  included_count: number;
  redacted_count: number;
  blocker_count: number;
  warning_count: number;
  duration_ms: number | null;
  updated_at: string;
}

export interface AutomatedCheck {
  check_id: string;
  category: CheckCategory;
  label: string;
  status: CheckStatus;
  summary: string;
  affected_event_ids: string[];
  scanner_version: string;
}

export interface EventReviewState {
  event_id: string;
  disposition: EventDisposition;
  note: string | null;
  redaction_replacement: string | null;
  rights_override: Rights | null;
  rights_attestation: RightsOverrideAttestation | null;
  verifier_confirmation: VerifierConfirmation | null;
  updated_at: string;
}

export interface ReviewEvent {
  event: TrajectoryEvent;
  review: EventReviewState;
}

export interface TraceMetrics {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  tool_calls: number;
  failed_events: number;
  observation_action_pairs: number;
  verification_events: number;
  targeted_observation_ratio: number | null;
}

export interface TraceDetail {
  manifest: TraceManifest;
  events: ReviewEvent[];
  checks: AutomatedCheck[];
  metrics: TraceMetrics;
  revision: number;
}

export interface TraceListResponse {
  traces: TraceSummary[];
}

export interface EventReviewPatch {
  expected_revision: number;
  disposition?: EventDisposition;
  note?: string | null;
  redaction_replacement?: string | null;
}

export interface EventRightsPatch {
  expected_revision: number;
  rights_override: Rights | null;
  modes?: ApprovalMode[];
  reviewer?: string;
  evidence_ref?: string;
  evidence_sha256?: string;
  expires_at?: string;
}

export interface EventVerifierPatch {
  expected_revision: number;
  confirmation: null | {
    reviewer: string;
    evidence_ref: string;
  };
}

export interface TraceDecisionRequest {
  expected_revision: number;
  decision: Exclude<ReviewDecision, "pending">;
  reviewer: string;
  notes: string;
  approved_modes: ApprovalMode[];
}

export interface ExportPreviewRequest {
  expected_revision: number;
  format: ExportFormat;
  mode: ApprovalMode;
  /** No recipe is inferred. DeepSeek Harness HF/TRL requests fail closed. */
  training_recipe: ExportTrainingRecipe | null;
}

export interface ExportPreviewExclusion {
  exclusion_id: string;
  candidate_event_count: number;
  reason_codes: string[];
}

export interface ExportPreview {
  trace_id: string;
  format: ExportFormat;
  mode: ApprovalMode;
  destination_hint: string;
  example_count: number;
  training_recipe: ExportTrainingRecipe | null;
  recipe_version: string | null;
  compiler_version: string | null;
  compilation_sha256: string | null;
  exclusions: ExportPreviewExclusion[];
  plaintext_bytes_estimate: number;
  excluded_event_count: number;
  redacted_part_count: number;
  license_summary: string;
  warnings: string[];
  export_allowed: boolean;
  block_reasons: string[];
  confirmation_phrase: "EXPORT PLAINTEXT";
}

export interface ExportRequest extends ExportPreviewRequest {
  confirmation_phrase: ExportPreview["confirmation_phrase"];
}

export interface ExportReceipt {
  export_id: string;
  trace_id: string;
  format: ExportFormat;
  created_at: string;
  destination: string;
  sha256: string;
}

export interface ReviewApi {
  bootstrap(): Promise<ReviewerBootstrap>;
  listTraces(): Promise<TraceSummary[]>;
  getTrace(traceId: string): Promise<TraceDetail>;
  updateEvent(traceId: string, eventId: string, patch: EventReviewPatch): Promise<TraceDetail>;
  updateEventRights(traceId: string, eventId: string, patch: EventRightsPatch): Promise<TraceDetail>;
  updateEventVerifier(traceId: string, eventId: string, patch: EventVerifierPatch): Promise<TraceDetail>;
  decideTrace(traceId: string, request: TraceDecisionRequest): Promise<TraceDetail>;
  previewExport(traceId: string, request: ExportPreviewRequest): Promise<ExportPreview>;
  exportTrace(traceId: string, request: ExportRequest): Promise<ExportReceipt>;
}

export type ManifestEligibility = Eligibility;
export type ReviewableContentPart = ContentPart;
