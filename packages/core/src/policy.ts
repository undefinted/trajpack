import type {
  ApprovalMode,
  ApprovalScope,
  Eligibility,
  EligibilityDecision,
  PermissionEvidence,
  Source,
  TraceBundle,
  TraceManifest,
  TrajectoryEvent,
  RightsOverrideAttestation,
} from "@trajpack/schema";
import { rightsOverrideAttestationSchema } from "@trajpack/schema";
import { canonicalJson, sha256, stableId } from "./canonical.js";
import { rawIntegrityReasons } from "./integrity.js";
import { POLICY_REGISTRY, type PolicyRegistryEntry } from "./policy-registry.js";
import { scanStructured, scanText } from "./redaction.js";

export const POLICY_VERSION = "policy/2026-08-16.4";

export interface PolicyContext {
  source: Source;
  accountType: TraceManifest["account_contract"]["account_type"];
  rights: TraceManifest["rights"];
  consentActive: boolean;
  writtenPermissionRef?: string | null;
  permissionEvidence?: PermissionEvidence;
  targetModelOwner?: string | null;
  targetProduct?: string | null;
  competitive?: "yes" | "no" | "unknown";
  now?: Date;
}

export interface GateResult {
  allowed: boolean;
  reasonCodes: string[];
  excludedContentParts: Array<{ eventId: string; ordinal: number; reason: string }>;
}

type EligibilityKey = keyof Eligibility;
type PermissionPurpose = PermissionEvidence["permitted_purposes"][number];

interface PermissionEvaluation {
  evidence: PermissionEvidence | null;
  reasonCodes: string[];
}

function canonicalOrigin(value: string): string | null {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return null;
  }
}

function evaluatePermissionEvidence(
  context: Pick<PolicyContext, "source" | "accountType" | "writtenPermissionRef" | "permissionEvidence" | "targetModelOwner" | "targetProduct">,
  purpose: PermissionPurpose,
  now: Date,
): PermissionEvaluation {
  const evidence = context.permissionEvidence;
  if (!evidence) return { evidence: null, reasonCodes: ["SCOPED_PERMISSION_REQUIRED"] };
  const reasons: string[] = [];
  if (!isEvidenceArtifactReference(evidence.evidence_ref)) {
    reasons.push("SCOPED_PERMISSION_EVIDENCE_REFERENCE_INVALID");
  }
  if (!evidence.reviewer.trim()) reasons.push("SCOPED_PERMISSION_REVIEWER_MISSING");
  if (context.writtenPermissionRef !== undefined
    && context.writtenPermissionRef !== evidence.evidence_ref) reasons.push("SCOPED_PERMISSION_REFERENCE_MISMATCH");
  if (context.source.provider === "unknown" || evidence.provider === "unknown") {
    reasons.push("SCOPED_PERMISSION_PROVIDER_UNKNOWN");
  } else if (evidence.provider !== context.source.provider) {
    reasons.push("SCOPED_PERMISSION_PROVIDER_MISMATCH");
  }
  if (context.accountType === "unknown" || evidence.account_type === "unknown") {
    reasons.push("SCOPED_PERMISSION_ACCOUNT_UNKNOWN");
  } else if (evidence.account_type !== context.accountType) {
    reasons.push("SCOPED_PERMISSION_ACCOUNT_MISMATCH");
  }
  if (!evidence.capture_methods.includes(context.source.capture_method)) {
    reasons.push("SCOPED_PERMISSION_CAPTURE_METHOD_MISMATCH");
  }
  const sourceOrigin = context.source.origin === null ? null : canonicalOrigin(context.source.origin);
  const evidenceOrigins = evidence.origins.map(canonicalOrigin);
  if ((context.source.origin !== null && sourceOrigin === null)
    || (sourceOrigin === null && evidenceOrigins.length > 0)
    || (sourceOrigin !== null && !evidenceOrigins.includes(sourceOrigin))) {
    reasons.push("SCOPED_PERMISSION_ORIGIN_MISMATCH");
  }
  if (!evidence.permitted_purposes.includes(purpose)) reasons.push("SCOPED_PERMISSION_PURPOSE_MISMATCH");
  const effectiveAt = Date.parse(evidence.effective_at);
  const expiresAt = Date.parse(evidence.expires_at);
  if (!Number.isFinite(effectiveAt) || effectiveAt > now.getTime()) reasons.push("SCOPED_PERMISSION_NOT_YET_EFFECTIVE");
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime() || expiresAt <= effectiveAt) {
    reasons.push("SCOPED_PERMISSION_EXPIRED");
  }
  const isTraining = purpose === "training_noncompetitive" || purpose === "training_competitive_distillation";
  if (isTraining) {
    if (!context.targetModelOwner || !context.targetProduct
      || evidence.target_model_owner !== context.targetModelOwner
      || evidence.target_product !== context.targetProduct) {
      reasons.push("SCOPED_PERMISSION_TARGET_MISMATCH");
    }
  } else if (purpose === "automatic_capture"
    && (evidence.target_model_owner !== null || evidence.target_product !== null)) {
    reasons.push("SCOPED_PERMISSION_TARGET_MISMATCH");
  } else if ((evidence.target_model_owner !== null || evidence.target_product !== null)
    && (evidence.target_model_owner !== (context.targetModelOwner ?? null)
      || evidence.target_product !== (context.targetProduct ?? null))) {
    reasons.push("SCOPED_PERMISSION_TARGET_MISMATCH");
  }
  return { evidence: reasons.length === 0 ? evidence : null, reasonCodes: [...new Set(reasons)] };
}

function approvalDecision(manifest: TraceManifest, mode: ApprovalMode): EligibilityDecision {
  return mode === "archive" ? manifest.eligibility.local_archive : manifest.eligibility[mode];
}

export function approvalFingerprint(bundle: TraceBundle): string {
  const { review: _review, ...manifest } = bundle.manifest;
  return sha256(canonicalJson({ manifest, events: bundle.events }));
}

/**
 * Bind reviewer-created event evidence to provider-visible data while avoiding
 * a self-referential digest. Provider metadata under the reserved review
 * namespace and embedded rights assertions are deliberately excluded.
 */
export function reviewEvidenceFingerprint(event: TrajectoryEvent): string {
  const metadata = { ...event.metadata };
  delete metadata.trajpack_review;
  return sha256(canonicalJson({
    ...event,
    metadata,
    content: event.content.map((part) => ({ ...part, rights_override: null })),
  }));
}

export function createApprovalScope(bundle: TraceBundle, modes: ApprovalMode[]): ApprovalScope {
  const uniqueModes = [...new Set(modes)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (uniqueModes.length === 0) throw new Error("At least one approval mode is required");
  const { reviewer, reviewed_at: reviewedAt, notes } = bundle.manifest.review;
  if (!reviewer?.trim() || !reviewedAt || !notes?.trim()) {
    throw new Error("Approval scope requires reviewer identity, review time, and notes");
  }
  return {
    bundle_sha256: approvalFingerprint(bundle),
    reviewer,
    reviewed_at: reviewedAt,
    notes_sha256: sha256(notes),
    decisions: uniqueModes.map((mode) => {
      const decision = approvalDecision(bundle.manifest, mode);
      return {
        mode,
        decision_id: decision.decision_id,
        target_model_owner: decision.target_model_owner,
        target_product: decision.target_product,
      };
    }),
  };
}

export function validateApprovalScope(bundle: TraceBundle, mode: ApprovalMode): string[] {
  const reasons: string[] = [];
  const approval = bundle.manifest.review.approval_scope;
  if (bundle.manifest.review.human_approval !== "approved") reasons.push("HUMAN_APPROVAL_REQUIRED");
  if (approval === null) return [...reasons, "APPROVAL_SCOPE_REQUIRED"];
  if (approval.bundle_sha256 !== approvalFingerprint(bundle)) reasons.push("APPROVAL_CONTENT_CHANGED");
  if (!bundle.manifest.review.reviewer || !bundle.manifest.review.reviewed_at || !bundle.manifest.review.notes) {
    reasons.push("APPROVAL_PROVENANCE_REQUIRED");
  } else {
    if (approval.reviewer !== bundle.manifest.review.reviewer) reasons.push("APPROVAL_REVIEWER_CHANGED");
    if (approval.reviewed_at !== bundle.manifest.review.reviewed_at) reasons.push("APPROVAL_TIME_CHANGED");
    if (approval.notes_sha256 !== sha256(bundle.manifest.review.notes)) reasons.push("APPROVAL_NOTES_CHANGED");
  }
  const scoped = approval.decisions.find((decision) => decision.mode === mode);
  const current = approvalDecision(bundle.manifest, mode);
  if (!scoped) reasons.push("APPROVAL_MODE_NOT_APPROVED");
  else {
    if (scoped.decision_id !== current.decision_id) reasons.push("APPROVAL_DECISION_CHANGED");
    if (scoped.target_model_owner !== current.target_model_owner
      || scoped.target_product !== current.target_product) reasons.push("APPROVAL_TARGET_CHANGED");
  }
  return [...new Set(reasons)];
}

function makeDecision(
  key: EligibilityKey,
  status: EligibilityDecision["status"],
  reasonCodes: string[],
  context: PolicyContext,
  purposes: string[],
  evidence: PermissionEvidence | null = null,
): EligibilityDecision {
  const now = context.now ?? new Date();
  const expiresAt = new Date(now);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + 90);
  if (evidence && Date.parse(evidence.expires_at) < expiresAt.getTime()) {
    expiresAt.setTime(Date.parse(evidence.expires_at));
  }
  const competitive = context.competitive ?? "unknown";
  return {
    status,
    purposes,
    reason_codes: reasonCodes,
    basis: evidence ? `scoped-permission:${POLICY_VERSION}` : POLICY_VERSION,
    target_model_owner: context.targetModelOwner ?? null,
    target_product: context.targetProduct ?? null,
    competitive_with_source: competitive,
    decision_id: stableId("decision", {
      key,
      status,
      reasonCodes,
      source: context.source,
      competitive,
      evidenceRef: evidence?.evidence_ref ?? null,
      evidenceReviewer: evidence?.reviewer ?? null,
      evidenceExpiresAt: evidence?.expires_at ?? null,
    }),
    decided_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    reviewer: evidence?.reviewer ?? null,
    evidence_ref: evidence?.evidence_ref ?? null,
  };
}

function isOfficialManual(source: Source): boolean {
  return source.capture_method === "official_export" || source.capture_method === "manual_copy";
}

function normalizedLicense(value: string): string {
  return value.trim().toUpperCase();
}

const SPDX_LICENSE_IDS = new Set([
  "0BSD", "Apache-2.0", "Artistic-2.0", "BSD-2-Clause", "BSD-3-Clause",
  "BSL-1.0", "CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "EPL-2.0",
  "GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later",
  "ISC", "LGPL-2.1-only", "LGPL-2.1-or-later", "LGPL-3.0-only",
  "LGPL-3.0-or-later", "MIT", "MPL-2.0", "OFL-1.1", "Unlicense", "Zlib",
]);
const SPDX_LICENSE_IDS_UPPER = new Set([...SPDX_LICENSE_IDS].map((id) => id.toUpperCase()));

function validLicenseAtom(value: string): boolean {
  // Custom LicenseRef claims require a richer evidence object than v1 Rights
  // currently carries, so they remain archiveable but cannot auto-clear a
  // training hard gate. SPDX identifiers are compared case-insensitively so
  // lowercased tool output (e.g. `apache-2.0`, `mit`) is not treated as an
  // unknown license while the sentinel check above is case-insensitive.
  return SPDX_LICENSE_IDS_UPPER.has(normalizedLicense(value));
}

function validLicenseExpression(value: string): boolean {
  const normalized = value.trim().replace(/\s*([()])\s*/g, " $1 ").replace(/\s+/g, " ").trim();
  const tokens = normalized.match(/LicenseRef-[A-Za-z0-9][A-Za-z0-9.-]*|[A-Za-z0-9][A-Za-z0-9.-]*|[()]|AND|OR/g) ?? [];
  if (tokens.join(" ") !== normalized || tokens.length === 0) return false;
  let index = 0;
  const primary = (): boolean => {
    const token = tokens[index];
    if (token === "(") {
      index += 1;
      if (!orExpression() || tokens[index] !== ")") return false;
      index += 1;
      return true;
    }
    if (token === undefined || !validLicenseAtom(token)) return false;
    index += 1;
    return true;
  };
  const andExpression = (): boolean => {
    if (!primary()) return false;
    while (tokens[index] === "AND") {
      index += 1;
      if (!primary()) return false;
    }
    return true;
  };
  const orExpression = (): boolean => {
    if (!andExpression()) return false;
    while (tokens[index] === "OR") {
      index += 1;
      if (!andExpression()) return false;
    }
    return true;
  };
  return orExpression() && index === tokens.length;
}

function licenseKnown(value: string): boolean {
  const normalized = normalizedLicense(value);
  return normalized.length > 0 && !["NOASSERTION", "UNKNOWN", "NONE"].includes(normalized)
    && validLicenseExpression(value);
}

function rightsAreTrainingClear(rights: TraceManifest["rights"]): boolean {
  if (!licenseKnown(rights.source_license_expression) || rights.input_rights_basis === "unknown"
    || rights.third_party_content === "unknown") return false;
  if (rights.third_party_content === "present") {
    return ["licensed", "consented", "public_domain"].includes(rights.input_rights_basis)
      && Boolean(rights.rights_holder?.trim());
  }
  return true;
}

function isLocallyObservedNativeSource(source: Source): boolean {
  if (source.authenticity !== "locally_observed") return false;
  return (source.host === "codex"
      && (source.capture_method === "official_stream" || source.capture_method === "official_hook"))
    || (source.host === "claude_code"
      && (source.capture_method === "official_stream" || source.capture_method === "official_hook"))
    || (source.host === "deepseek_harness" && source.capture_method === "instrumented_harness");
}

function isTrustedDeepSeekTrainingPath(source: Source): boolean {
  // `locally_observed` is only an assertion about this capture process tree. It
  // is not a provider signature. Offline JSON and user-authored receipt strings
  // therefore never enter the provider-default training path.
  return source.provider === "deepseek"
    && source.model_id !== null
    && source.host === "deepseek_harness"
    && source.product === "deepseek-harness"
    && source.surface === "harness"
    && source.capture_method === "instrumented_harness"
    && /^native-request-header:sha256:[a-f0-9]{64}$/u.test(source.authenticity_evidence_ref ?? "")
    && isLocallyObservedNativeSource(source);
}

function isTrustedSelfHostedPath(source: Source): boolean {
  const digest = source.model_snapshot_or_weights_digest;
  return source.provider === "self_hosted"
    && source.host === "deepseek_harness"
    && source.product === "deepseek-harness"
    && source.surface === "harness"
    && source.capture_method === "instrumented_harness"
    && source.model_id !== null
    && digest !== null
    && /^sha256:[a-f0-9]{64}$/.test(digest)
    && isLocallyObservedNativeSource(source)
    && source.authenticity_evidence_ref === `local-model-artifact:${digest}`;
}

function sourceAuthenticitySupportsDefaultTraining(source: Source): boolean {
  // Legal permission and teacher authenticity are independent. v1 has one
  // provider-backed native path whose request/model can be correlated to a
  // durable event: the pinned DeepSeek Harness request/header surface. Other
  // hosts (and self-hosted weights) need a trace-scoped manual provenance
  // decision even when a contract permits the intended training use.
  return isTrustedDeepSeekTrainingPath(source);
}

function registryEntry(provider: Source["provider"], accountType: TraceManifest["account_contract"]["account_type"]): PolicyRegistryEntry | undefined {
  return POLICY_REGISTRY.find((entry) => entry.provider === provider && entry.account_types.includes(accountType));
}

function statusRank(status: EligibilityDecision["status"]): number {
  return status === "deny" ? 0 : status === "unknown" ? 1 : 2;
}

function applyRegistryCeiling(
  key: "automatic_capture" | "training_noncompetitive" | "training_competitive_distillation",
  decision: EligibilityDecision,
  context: PolicyContext,
): EligibilityDecision {
  if (decision.status === "allow" && decision.basis.startsWith("scoped-permission:")) return decision;
  const entry = registryEntry(context.source.provider, context.accountType);
  const registryStatus = entry?.defaults[key];
  if (!entry || !registryStatus || statusRank(registryStatus) >= statusRank(decision.status)) return decision;
  return makeDecision(
    key,
    registryStatus,
    [...decision.reason_codes, `REGISTRY_DEFAULT_${entry.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`],
    context,
    decision.purposes,
  );
}

function automaticCapture(context: PolicyContext): EligibilityDecision {
  const { source, accountType } = context;
  if (isOfficialManual(source)) {
    return makeDecision("automatic_capture", "deny", ["MANUAL_PATH_NOT_AUTOMATIC"], context, ["capture"]);
  }
  // The authorized-DOM path is authorized by the actual raw envelope. A CLI
  // evidence object cannot replace the click-time origin/nonce attestation.
  if (source.capture_method === "authorized_dom") {
    return makeDecision("automatic_capture", "unknown", ["SITE_AUTHORIZATION_REQUIRED"], context, ["capture"]);
  }
  const scopedPermission = evaluatePermissionEvidence(
    context,
    "automatic_capture",
    context.now ?? new Date(),
  ).evidence;
  if (scopedPermission) {
    return makeDecision(
      "automatic_capture",
      "allow",
      ["SCOPED_AUTOMATIC_CAPTURE_PERMISSION"],
      context,
      ["capture"],
      scopedPermission,
    );
  }
  if (isTrustedSelfHostedPath(source) && accountType === "self_hosted") {
    return makeDecision("automatic_capture", "allow", ["SELF_HOSTED_AUTHORITY"], context, ["capture"]);
  }
  if (source.surface === "web") {
    return makeDecision("automatic_capture", "deny", ["COMMERCIAL_WEB_AUTOMATION_BLOCKED"], context, ["capture"]);
  }
  if (source.provider === "openai" && accountType === "consumer") {
    return makeDecision("automatic_capture", "deny", ["OPENAI_CONSUMER_AUTOMATED_EXTRACTION"], context, ["capture"]);
  }
  if (source.provider === "anthropic" && accountType === "consumer") {
    return makeDecision("automatic_capture", "deny", ["ANTHROPIC_CONSUMER_AUTOMATED_ACCESS"], context, ["capture"]);
  }
  if (["api", "business", "enterprise", "managed_workspace"].includes(accountType)) {
    return makeDecision("automatic_capture", "allow", ["OFFICIAL_MACHINE_INTERFACE"], context, ["capture"]);
  }
  return makeDecision("automatic_capture", "unknown", ["ACCOUNT_OR_CONTRACT_UNKNOWN"], context, ["capture"]);
}

export function evaluateDefaultEligibility(context: PolicyContext): Eligibility {
  const archive = context.consentActive
    ? makeDecision("local_archive", "allow", ["EXPLICIT_LOCAL_ARCHIVE_CONSENT"], context, ["archive"])
    : makeDecision("local_archive", "deny", ["CONSENT_INACTIVE"], context, ["archive"]);
  let automatic = automaticCapture(context);
  const hasWrittenPermission = Boolean(context.writtenPermissionRef);
  const modelLicenseKnown = context.source.provider !== "self_hosted"
    || (context.rights.model_license_chain.length > 0
      && context.rights.model_license_chain.every(licenseKnown));
  const rightsKnown = rightsAreTrainingClear(context.rights) && modelLicenseKnown;

  let noncompetitive: EligibilityDecision;
  let competitive: EligibilityDecision;
  if (!context.consentActive || !rightsKnown) {
    noncompetitive = makeDecision("training_noncompetitive", "unknown", ["CONSENT_OR_RIGHTS_INCOMPLETE"], context, ["sft", "evaluation"]);
    competitive = makeDecision("training_competitive_distillation", "unknown", ["CONSENT_OR_RIGHTS_INCOMPLETE"], context, ["sft", "distillation"]);
  } else if (hasWrittenPermission) {
    noncompetitive = makeDecision("training_noncompetitive", "unknown", ["SCOPED_TRAINING_OVERRIDE_REQUIRED"], context, ["sft", "evaluation"]);
    competitive = makeDecision("training_competitive_distillation", "unknown", ["SCOPED_TRAINING_OVERRIDE_REQUIRED"], context, ["sft", "distillation"]);
  } else if (isTrustedDeepSeekTrainingPath(context.source)
    && (automatic.status === "allow" || isOfficialManual(context.source))) {
    noncompetitive = makeDecision("training_noncompetitive", "allow", ["DEEPSEEK_OUTPUT_TRAINING_ALLOWED"], context, ["sft", "evaluation"]);
    competitive = makeDecision("training_competitive_distillation", "allow", ["DEEPSEEK_DISTILLATION_ALLOWED"], context, ["sft", "distillation"]);
  } else if (isTrustedSelfHostedPath(context.source) && context.accountType === "self_hosted") {
    noncompetitive = makeDecision("training_noncompetitive", "unknown", ["SELF_HOSTED_RUNTIME_BINDING_REQUIRED"], context, ["sft", "evaluation"]);
    competitive = makeDecision("training_competitive_distillation", "unknown", ["SELF_HOSTED_RUNTIME_BINDING_REQUIRED"], context, ["sft", "distillation"]);
  } else if (context.source.provider === "openai") {
    noncompetitive = makeDecision("training_noncompetitive", "unknown", ["OPENAI_PERMITTED_EXCEPTION_NOT_ESTABLISHED"], context, ["sft", "evaluation"]);
    competitive = makeDecision("training_competitive_distillation", "deny", ["OPENAI_COMPETITIVE_MODEL_TRAINING"], context, ["sft", "distillation"]);
  } else if (context.source.provider === "anthropic") {
    noncompetitive = makeDecision("training_noncompetitive", "unknown", ["ANTHROPIC_NONCOMPETITIVE_SCOPE_NOT_ESTABLISHED"], context, ["sft", "evaluation"]);
    competitive = makeDecision("training_competitive_distillation", "deny", ["ANTHROPIC_COMPETITIVE_MODEL_TRAINING"], context, ["sft", "distillation"]);
  } else {
    noncompetitive = makeDecision("training_noncompetitive", "unknown", ["TRAINING_PERMISSION_UNKNOWN"], context, ["sft", "evaluation"]);
    competitive = makeDecision("training_competitive_distillation", "unknown", ["TRAINING_PERMISSION_UNKNOWN"], context, ["sft", "distillation"]);
  }

  automatic = applyRegistryCeiling("automatic_capture", automatic, context);
  noncompetitive = applyRegistryCeiling("training_noncompetitive", noncompetitive, context);
  competitive = applyRegistryCeiling("training_competitive_distillation", competitive, context);

  if (context.consentActive) {
    const now = context.now ?? new Date();
    const noncompetitivePermission = evaluatePermissionEvidence(context, "training_noncompetitive", now).evidence;
    if (noncompetitivePermission && sourceAuthenticitySupportsDefaultTraining(context.source)) {
      noncompetitive = makeDecision(
        "training_noncompetitive",
        "allow",
        ["SCOPED_NONCOMPETITIVE_TRAINING_PERMISSION"],
        context,
        ["sft", "evaluation"],
        noncompetitivePermission,
      );
    }
    const competitivePermission = evaluatePermissionEvidence(
      context,
      "training_competitive_distillation",
      now,
    ).evidence;
    if (competitivePermission && sourceAuthenticitySupportsDefaultTraining(context.source)) {
      competitive = makeDecision(
        "training_competitive_distillation",
        "allow",
        ["SCOPED_COMPETITIVE_TRAINING_PERMISSION"],
        context,
        ["sft", "distillation"],
        competitivePermission,
      );
    }
  }

  const normalizedSourceLicense = normalizedLicense(context.rights.source_license_expression);
  let redistribution = ["MIT", "APACHE-2.0", "CC0-1.0"].includes(normalizedSourceLicense)
    ? makeDecision("redistribution", "allow", ["REDISTRIBUTABLE_SOURCE_LICENSE"], context, ["release"])
    : makeDecision("redistribution", "unknown", ["REDISTRIBUTION_NOT_ESTABLISHED"], context, ["release"]);
  if (context.consentActive) {
    const redistributionPermission = evaluatePermissionEvidence(
      context,
      "redistribution",
      context.now ?? new Date(),
    ).evidence;
    if (redistributionPermission) {
      redistribution = makeDecision(
        "redistribution",
        "allow",
        ["SCOPED_REDISTRIBUTION_PERMISSION"],
        context,
        ["release"],
        redistributionPermission,
      );
    }
  }

  return {
    local_archive: archive,
    automatic_capture: automatic,
    training_noncompetitive: noncompetitive,
    training_competitive_distillation: competitive,
    redistribution,
  };
}

function currentDecision(decision: EligibilityDecision, now: Date, reasonCodes: string[]): void {
  if (decision.status !== "allow") reasonCodes.push(...decision.reason_codes, `DECISION_${decision.status.toUpperCase()}`);
  if (Date.parse(decision.expires_at) <= now.getTime()) reasonCodes.push("DECISION_EXPIRED");
}

function consentAllows(manifest: TraceManifest, mode: ApprovalMode | "automatic_capture"): boolean {
  const aliases: Record<ApprovalMode | "automatic_capture", readonly string[]> = {
    archive: ["archive"],
    automatic_capture: ["capture", "authorized-capture", "automatic_capture"],
    training_noncompetitive: ["training_noncompetitive", "sft"],
    training_competitive_distillation: ["training_competitive_distillation", "distillation"],
    redistribution: ["redistribution", "release"],
  };
  const purposes = new Set(manifest.consent.purposes.map((purpose) => purpose.trim().toLowerCase()));
  return aliases[mode].some((purpose) => purposes.has(purpose));
}

function termsAreCurrent(
  manifest: TraceManifest,
  now: Date,
  authorizedSite: boolean,
  scopedPermission: boolean,
): boolean {
  if (manifest.source.provider === "self_hosted") return true;
  if (authorizedSite || scopedPermission) return true;
  return manifest.account_contract.terms.length > 0
    && manifest.account_contract.terms.every((term) => Date.parse(term.effective_at) <= now.getTime()
      && Date.parse(term.retrieved_at) <= now.getTime()
      && Date.parse(term.review_after) > now.getTime());
}

function normalizeAuthorityUrl(value: string): string {
  return value.replace(/\/+$/, "").toLowerCase();
}

function termsMatchRegistry(manifest: TraceManifest, authorizedSite: boolean, scopedPermission: boolean): boolean {
  if (manifest.source.provider === "self_hosted") return true;
  if (authorizedSite || scopedPermission) return true;
  const entry = registryEntry(manifest.source.provider, manifest.account_contract.account_type);
  if (!entry) return false;
  const authority = normalizeAuthorityUrl(entry.authority_url);
  return manifest.account_contract.terms.some((term) => normalizeAuthorityUrl(term.url) === authority);
}

function termsPinnedToRegistry(manifest: TraceManifest): boolean {
  if (manifest.source.provider === "self_hosted") return true;
  const entry = registryEntry(manifest.source.provider, manifest.account_contract.account_type);
  if (!entry || entry.accepted_snapshot_sha256.length === 0) return false;
  const accepted = new Set(entry.accepted_snapshot_sha256.map((digest) => digest.toLowerCase()));
  const authority = normalizeAuthorityUrl(entry.authority_url);
  return manifest.account_contract.terms.some((term) => normalizeAuthorityUrl(term.url) === authority
    && accepted.has(term.snapshot_sha256.toLowerCase()));
}

const EVIDENCE_ARTIFACT_REFERENCE_PATTERN = /^([a-z][a-z0-9]*(?:[._-][a-z0-9]+)*):sha256:[a-f0-9]{64}$/;
const MAX_EVIDENCE_ARTIFACT_KIND_LENGTH = 64;

export function isEvidenceArtifactReference(value: string | null): boolean {
  if (value === null) return false;
  const match = EVIDENCE_ARTIFACT_REFERENCE_PATTERN.exec(value);
  return match !== null && match[1]!.length <= MAX_EVIDENCE_ARTIFACT_KIND_LENGTH;
}

function scopedManualDecision(decision: EligibilityDecision): boolean {
  return decision.basis.startsWith("manual-override:")
    && Boolean(decision.reviewer?.trim())
    && isEvidenceArtifactReference(decision.evidence_ref);
}

function manifestPrivacyAllowlisted(path: string): boolean {
  return /(?:^|\.)(?:trace_id|workspace_owner_hmac|cwd_hmac|raw_sha256|snapshot_sha256|decision_id|receipt_id|bundle_sha256)$/.test(path)
    || /\.lineage\.parent_trace_ids\[\d+\]$/.test(path);
}

function eventPrivacyAllowlisted(path: string): boolean {
  return /\.event\.(?:trace_id|span_id|parent_span_id)$/.test(path)
    || /\.event\.links\[\d+\]\.(?:trace_id|span_id)$/.test(path)
    || /\.event\.content\[\d+\]\.sha256$/.test(path);
}

function parsedRightsAttestation(event: TrajectoryEvent): RightsOverrideAttestation | null {
  const review = event.metadata.trajpack_review;
  if (!review || typeof review !== "object" || Array.isArray(review)) return null;
  const parsed = rightsOverrideAttestationSchema.safeParse((review as Record<string, unknown>).rights_attestation);
  return parsed.success ? parsed.data : null;
}

export function validateEventRightsAttestation(
  event: TrajectoryEvent,
  manifest: TraceManifest,
  mode: ApprovalMode,
  now = new Date(),
): { rights: TraceManifest["rights"] | null; reasonCodes: string[] } {
  const review = event.metadata.trajpack_review;
  const candidate = review && typeof review === "object" && !Array.isArray(review)
    ? (review as Record<string, unknown>).rights_attestation
    : undefined;
  if (candidate === undefined) return { rights: null, reasonCodes: ["RIGHTS_ATTESTATION_REQUIRED"] };
  const attestation = parsedRightsAttestation(event);
  if (!attestation) return { rights: null, reasonCodes: ["RIGHTS_ATTESTATION_INVALID"] };
  const reasons: string[] = [];
  if (attestation.event_sha256 !== reviewEvidenceFingerprint(event)) reasons.push("RIGHTS_ATTESTATION_EVENT_CHANGED");
  if (attestation.source_sha256 !== sha256(canonicalJson(manifest.source))) reasons.push("RIGHTS_ATTESTATION_SOURCE_CHANGED");
  const attestedAt = Date.parse(attestation.attested_at);
  const expiresAt = Date.parse(attestation.expires_at);
  if (attestedAt > now.getTime()) reasons.push("RIGHTS_ATTESTATION_NOT_YET_VALID");
  if (expiresAt <= now.getTime()) reasons.push("RIGHTS_ATTESTATION_EXPIRED");
  const decision = approvalDecision(manifest, mode);
  const exactScope = attestation.scopes.some((scope) => scope.mode === mode
    && scope.target_model_owner === decision.target_model_owner
    && scope.target_product === decision.target_product);
  if (!exactScope) reasons.push("RIGHTS_ATTESTATION_SCOPE_MISMATCH");
  const embeddedRightsMatch = event.content.every((part) => part.rights_override === null
    || canonicalJson(part.rights_override) === canonicalJson(attestation.rights));
  if (!embeddedRightsMatch) reasons.push("RIGHTS_ATTESTATION_CONTENT_MISMATCH");
  return { rights: reasons.length === 0 ? attestation.rights : null, reasonCodes: [...new Set(reasons)] };
}

function termsConflict(manifest: TraceManifest): boolean {
  const hashes = new Map<string, Set<string>>();
  for (const term of manifest.account_contract.terms) {
    const key = `${term.name}\u0000${term.url}\u0000${term.effective_at}`;
    const values = hashes.get(key) ?? new Set<string>();
    values.add(term.snapshot_sha256);
    hashes.set(key, values);
  }
  return [...hashes.values()].some((values) => values.size > 1);
}

function authorizedSiteEvidenceCurrent(bundle: TraceBundle, now: Date): boolean {
  const manifest = bundle.manifest;
  if (manifest.source.capture_method !== "authorized_dom" || !manifest.source.origin
    || !manifest.account_contract.order_form_or_written_permission_ref) return false;
  return bundle.raw.some((envelope) => {
    if (envelope.adapter !== "browser" || !envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) return false;
    const provenance = (envelope.payload as Record<string, unknown>).provenance;
    if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return false;
    const record = provenance as Record<string, unknown>;
    const authorization = record.authorization;
    if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)) return false;
    const evidence = authorization as Record<string, unknown>;
    return record.source_origin === manifest.source.origin
      && evidence.evidence_ref === manifest.account_contract.order_form_or_written_permission_ref
      && typeof evidence.attested_at === "string"
      && Number.isFinite(Date.parse(evidence.attested_at))
      && Date.parse(evidence.attested_at) <= now.getTime()
      && typeof evidence.expires_at === "string"
      && Number.isFinite(Date.parse(evidence.expires_at))
      && Date.parse(evidence.expires_at) > now.getTime();
  });
}

export function evaluateGate(
  bundle: TraceBundle,
  mode: "archive" | "automatic_capture" | "training_noncompetitive" | "training_competitive_distillation" | "redistribution",
  now = new Date(),
): GateResult {
  const reasons: string[] = [];
  const excludedContentParts: GateResult["excludedContentParts"] = [];
  const authorizedSite = authorizedSiteEvidenceCurrent(bundle, now);
  const permissionPurpose: PermissionPurpose | null = mode === "archive" ? null : mode;
  let permissionEvaluation: PermissionEvaluation = { evidence: null, reasonCodes: [] };
  if (mode !== "archive") {
    const permissionDecision = bundle.manifest.eligibility[mode];
    const permissionContext: Pick<
      PolicyContext,
      "source" | "accountType" | "writtenPermissionRef" | "permissionEvidence" | "targetModelOwner" | "targetProduct"
    > = {
      source: bundle.manifest.source,
      accountType: bundle.manifest.account_contract.account_type,
      writtenPermissionRef: bundle.manifest.account_contract.order_form_or_written_permission_ref,
      targetModelOwner: mode === "automatic_capture" ? null : permissionDecision.target_model_owner,
      targetProduct: mode === "automatic_capture" ? null : permissionDecision.target_product,
      ...(bundle.manifest.account_contract.scoped_permission === undefined
        ? {}
        : { permissionEvidence: bundle.manifest.account_contract.scoped_permission }),
    };
    permissionEvaluation = evaluatePermissionEvidence(permissionContext, mode, now);
  }
  const scopedPermission = permissionEvaluation.evidence !== null;
  const currentModeDecision = mode === "archive"
    ? bundle.manifest.eligibility.local_archive
    : bundle.manifest.eligibility[mode];
  const permissionClaimedForMode = permissionPurpose !== null && (
    bundle.manifest.account_contract.scoped_permission?.permitted_purposes.includes(permissionPurpose) === true
    || currentModeDecision.basis.startsWith("scoped-permission:")
  );
  if (permissionClaimedForMode && !scopedPermission) reasons.push(...permissionEvaluation.reasonCodes);
  if (currentModeDecision.basis.startsWith("scoped-permission:")) {
    const evidence = permissionEvaluation.evidence;
    if (!evidence
      || currentModeDecision.evidence_ref !== evidence.evidence_ref
      || currentModeDecision.reviewer !== evidence.reviewer) {
      reasons.push("SCOPED_PERMISSION_DECISION_MISMATCH");
    }
  }
  if (currentModeDecision.basis.startsWith("manual-override:")) {
    if (!currentModeDecision.reviewer?.trim() || !currentModeDecision.evidence_ref) {
      reasons.push("OVERRIDE_EVIDENCE_INCOMPLETE");
    } else if (!isEvidenceArtifactReference(currentModeDecision.evidence_ref)) {
      reasons.push("OVERRIDE_EVIDENCE_REFERENCE_INVALID");
    }
  }
  if (bundle.manifest.source.capture_method === "authorized_dom" && !authorizedSite) {
    reasons.push("SITE_AUTHORIZATION_REQUIRED");
  }
  currentDecision(bundle.manifest.eligibility.local_archive, now, reasons);
  if (mode !== "archive" && !(mode === "automatic_capture" && authorizedSite)) {
    const key = mode === "automatic_capture" ? "automatic_capture" : mode;
    currentDecision(bundle.manifest.eligibility[key], now, reasons);
  }
  if (!bundle.manifest.consent.active) reasons.push("CONSENT_INACTIVE");
  if (bundle.manifest.consent.withdrawal_ref !== null) reasons.push("CONSENT_WITHDRAWN");
  if (!consentAllows(bundle.manifest, mode)) reasons.push("CONSENT_PURPOSE_MISSING");
  if (bundle.manifest.account_contract.account_type === "unknown" && !authorizedSite) reasons.push("ACCOUNT_TYPE_UNKNOWN");
  if (bundle.manifest.source.provider === "unknown" && !authorizedSite) reasons.push("MODEL_PROVIDER_UNKNOWN");
  if (!termsAreCurrent(bundle.manifest, now, authorizedSite, scopedPermission)) reasons.push("TERMS_MISSING_OR_STALE");
  if (!termsMatchRegistry(bundle.manifest, authorizedSite, scopedPermission)) reasons.push("TERMS_SOURCE_MISMATCH");
  if (termsConflict(bundle.manifest)) reasons.push("TERMS_SNAPSHOT_CONFLICT");
  reasons.push(...rawIntegrityReasons(bundle));
  if (mode === "training_noncompetitive" || mode === "training_competitive_distillation") {
    const decision = bundle.manifest.eligibility[mode];
    if (!decision.target_model_owner || !decision.target_product) reasons.push("TRAINING_TARGET_UNKNOWN");
    if (decision.competitive_with_source === "unknown") reasons.push("COMPETITIVENESS_UNKNOWN");
    if (mode === "training_noncompetitive" && decision.competitive_with_source !== "no") {
      reasons.push("NONCOMPETITIVE_DECISION_REQUIRED");
    }
    if (mode === "training_competitive_distillation" && decision.competitive_with_source !== "yes") {
      reasons.push("COMPETITIVE_DECISION_REQUIRED");
    }
    if (!scopedManualDecision(decision) && !scopedPermission && !termsPinnedToRegistry(bundle.manifest)) {
      reasons.push("TERMS_SNAPSHOT_UNPINNED");
    }
    if (!bundle.manifest.source.model_id) reasons.push("TEACHER_MODEL_UNKNOWN");
    if (!scopedManualDecision(decision)) {
      if (bundle.manifest.source.authenticity === "request_receipt_verified"
        || bundle.manifest.source.authenticity === "cryptographically_verified") {
        // v1 has no trusted receipt/signature verifier. A schema-valid enum and
        // an arbitrary evidence reference are metadata, not verification.
        reasons.push("SOURCE_AUTHENTICITY_VERIFIER_UNAVAILABLE");
      } else if (bundle.manifest.source.provider !== "self_hosted"
        && !sourceAuthenticitySupportsDefaultTraining(bundle.manifest.source)
        && !(bundle.manifest.source.authenticity === "user_authorized_observation" && authorizedSite)) {
        reasons.push("TEACHER_SOURCE_AUTHENTICITY_UNVERIFIED");
      }
    }
    if (bundle.manifest.source.provider === "self_hosted" && !scopedManualDecision(decision)) {
      reasons.push(isTrustedSelfHostedPath(bundle.manifest.source)
        ? "SELF_HOSTED_RUNTIME_BINDING_REQUIRED"
        : "SELF_HOSTED_PROVENANCE_UNVERIFIED");
    }
  }
  if (mode === "automatic_capture" && !authorizedSite
    && bundle.manifest.source.provider !== "self_hosted"
    && !scopedManualDecision(bundle.manifest.eligibility.automatic_capture)
    && !scopedPermission
    && !termsPinnedToRegistry(bundle.manifest)) {
    reasons.push("TERMS_SNAPSHOT_UNPINNED");
  }
  if (mode === "training_noncompetitive"
    || mode === "training_competitive_distillation"
    || mode === "redistribution") {
    const includedEvents = bundle.events.filter((event) => event.review_disposition === "include");
    const includedParts = includedEvents.flatMap((event) => event.content
      .filter((part) => part.review_disposition === "include")
      .map((part) => ({ event, part })));
    const attestationByEvent = new Map(includedEvents.map((event) => [
      event.event_id,
      validateEventRightsAttestation(event, bundle.manifest, mode, now),
    ]));
    const manifestRightsClear = rightsAreTrainingClear(bundle.manifest.rights);
    const overrideRightsClear = includedParts.length > 0 && includedParts.every(({ event, part }) => {
      const attested = attestationByEvent.get(event.event_id)?.rights ?? null;
      return part.rights_override !== null && attested !== null
        && canonicalJson(part.rights_override) === canonicalJson(attested)
        && rightsAreTrainingClear(attested);
    });
    if (bundle.manifest.rights.input_rights_basis === "unknown" && !overrideRightsClear) reasons.push("INPUT_RIGHTS_UNKNOWN");
    if (bundle.manifest.rights.third_party_content === "unknown" && !overrideRightsClear) reasons.push("THIRD_PARTY_RIGHTS_UNKNOWN");
    if (!licenseKnown(bundle.manifest.rights.source_license_expression) && !overrideRightsClear) reasons.push("SOURCE_LICENSE_UNKNOWN");
    if (bundle.manifest.rights.third_party_content === "present" && !manifestRightsClear && !overrideRightsClear) {
      reasons.push("THIRD_PARTY_CONTENT_REQUIRES_ITEMIZED_RIGHTS");
    }
    if (bundle.manifest.source.provider === "self_hosted"
      && (bundle.manifest.rights.model_license_chain.length === 0
        || bundle.manifest.rights.model_license_chain.some((license) => !licenseKnown(license)))) {
      reasons.push("MODEL_LICENSE_CHAIN_UNKNOWN");
    }
    for (const { event, part } of includedParts) {
      if (part.rights_override === null) continue;
      const attestation = attestationByEvent.get(event.event_id)!;
      if (attestation.rights === null || canonicalJson(part.rights_override) !== canonicalJson(attestation.rights)) {
        reasons.push(...attestation.reasonCodes, "RIGHTS_ATTESTATION_CONTENT_MISMATCH");
        continue;
      }
      const effective = attestation.rights;
      if (effective.input_rights_basis === "unknown") reasons.push("CONTENT_INPUT_RIGHTS_UNKNOWN");
      if (effective.third_party_content === "unknown") reasons.push("CONTENT_THIRD_PARTY_RIGHTS_UNKNOWN");
      if (!licenseKnown(effective.source_license_expression)) reasons.push("CONTENT_SOURCE_LICENSE_UNKNOWN");
      if (effective.third_party_content === "present" && !rightsAreTrainingClear(effective)) {
        reasons.push("CONTENT_THIRD_PARTY_RIGHTS_INCOMPLETE");
      }
    }
    for (const event of includedEvents) {
      if (event.tool === null || (event.tool.arguments === null && event.tool.result === null)) continue;
      const attestation = attestationByEvent.get(event.event_id)!;
      if (attestation.rights === null) reasons.push(...attestation.reasonCodes);
      if (!attestation.rights || !rightsAreTrainingClear(attestation.rights)) reasons.push("STRUCTURED_TOOL_RIGHTS_UNKNOWN");
    }
    if (includedParts.length === 0) reasons.push("NO_INCLUDED_CONTENT");
  }
  if (bundle.manifest.lineage.tombstoned) reasons.push("TRACE_TOMBSTONED");

  const manifestPrivacyFindings = scanStructured(bundle.manifest, "$.manifest")
    .filter((finding) => !manifestPrivacyAllowlisted(finding.path));
  if (manifestPrivacyFindings.length > 0) reasons.push("MANIFEST_PRIVACY_FINDINGS");

  for (const event of bundle.events) {
    if (event.review_disposition !== "include") continue;
    const structuredFindings = scanStructured(event, "$.event")
      .filter((finding) => !eventPrivacyAllowlisted(finding.path));
    if (structuredFindings.length > 0) reasons.push("STRUCTURED_PRIVACY_FINDINGS");
    for (const part of event.content) {
      if (part.review_disposition !== "include") continue;
      if (part.redaction_status === "not_scanned" || part.redaction_status === "quarantined") {
        reasons.push("CONTENT_NOT_CLEARED");
      }
      if (part.value !== null) {
        if (scanText(part.value).length > 0) reasons.push("PRIVACY_FINDINGS_PRESENT");
        if (sha256(part.value) !== part.sha256) reasons.push("CONTENT_HASH_MISMATCH");
      } else if (part.blob_ref !== null) {
        reasons.push("UNRESOLVED_BLOB_REFERENCE");
      } else {
        reasons.push("MISSING_CONTENT_PAYLOAD");
      }
    }
  }

  if (mode.startsWith("training") || mode === "redistribution") {
    if (bundle.manifest.review.automated_checks !== "passed") reasons.push("AUTOMATED_CHECKS_NOT_PASSED");
    if (bundle.manifest.review.human_approval !== "approved") reasons.push("HUMAN_APPROVAL_REQUIRED");
    for (const event of bundle.events) {
      if (event.review_disposition !== "include") continue;
      for (const part of event.content) {
        if (part.review_disposition !== "include") continue;
        if (part.reasoning?.representation === "opaque_reasoning_state") {
          excludedContentParts.push({ eventId: event.event_id, ordinal: part.ordinal, reason: "OPAQUE_REASONING_STATE" });
        }
      }
    }
  }
  return {
    allowed: reasons.length === 0,
    reasonCodes: [...new Set(reasons)].sort(),
    excludedContentParts,
  };
}
