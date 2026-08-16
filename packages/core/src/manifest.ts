import { createHmac, randomBytes } from "node:crypto";
import type {
  AccountType,
  PermissionEvidence,
  Provider,
  Rights,
  Source,
  TermsSnapshot,
  TraceManifest,
} from "@trajpack/schema";
import { SCHEMA_VERSION } from "@trajpack/schema";
import { evaluateDefaultEligibility } from "./policy.js";
import { stableId, traceId } from "./canonical.js";

export interface ManifestInput {
  source: Source;
  accountType: AccountType;
  rights: Rights;
  consentReceipt: string;
  consentPurposes: string[];
  terms?: TermsSnapshot[];
  writtenPermissionRef?: string | null;
  permissionEvidence?: PermissionEvidence;
  targetModelOwner?: string | null;
  targetProduct?: string | null;
  competitive?: "yes" | "no" | "unknown";
  contractingRegion?: string | null;
  storageRegion?: string;
  repoCommit?: string | null;
  cwdHmac?: string | null;
  createdAt?: Date;
}

export function createManifest(input: ManifestInput): TraceManifest {
  const createdAt = input.createdAt ?? new Date();
  if (input.permissionEvidence && input.writtenPermissionRef !== undefined
    && input.writtenPermissionRef !== null
    && input.writtenPermissionRef !== input.permissionEvidence.evidence_ref) {
    throw new Error("Written permission reference does not match scoped permission evidence");
  }
  const writtenPermissionRef = input.writtenPermissionRef
    ?? input.permissionEvidence?.evidence_ref
    ?? null;
  const id = traceId();
  const eligibility = evaluateDefaultEligibility({
    source: input.source,
    accountType: input.accountType,
    rights: input.rights,
    consentActive: true,
    writtenPermissionRef,
    ...(input.permissionEvidence === undefined ? {} : { permissionEvidence: input.permissionEvidence }),
    ...(input.targetModelOwner === undefined ? {} : { targetModelOwner: input.targetModelOwner }),
    ...(input.targetProduct === undefined ? {} : { targetProduct: input.targetProduct }),
    ...(input.competitive === undefined ? {} : { competitive: input.competitive }),
    now: createdAt,
  });
  return {
    record_type: "trace_manifest",
    schema_version: SCHEMA_VERSION,
    trace_id: id,
    created_at: createdAt.toISOString(),
    source: input.source,
    account_contract: {
      account_type: input.accountType,
      contracting_region: input.contractingRegion ?? null,
      workspace_owner_hmac: null,
      terms: input.terms ?? [],
      order_form_or_written_permission_ref: writtenPermissionRef,
      ...(input.permissionEvidence === undefined ? {} : { scoped_permission: input.permissionEvidence }),
    },
    rights: input.rights,
    consent: {
      receipt_id: input.consentReceipt,
      subjects_scope: "single_user",
      purposes: input.consentPurposes,
      active: true,
      captured_at: createdAt.toISOString(),
      withdrawal_ref: null,
    },
    eligibility,
    privacy: {
      legal_basis: "explicit-user-consent",
      jurisdictions: input.contractingRegion ? [input.contractingRegion] : [],
      storage_region: input.storageRegion ?? "local-device",
      retention_class: "user-managed",
      redaction_policy_version: "redaction/0.1",
    },
    environment: {
      cwd_hmac: input.cwdHmac ?? null,
      repo_commit: input.repoCommit ?? null,
      container_digest: null,
    },
    review: {
      revision: 0,
      automated_checks: "pending",
      human_approval: "pending",
      reviewer: null,
      reviewed_at: null,
      notes: null,
      approval_scope: null,
    },
    lineage: {
      parent_trace_ids: [],
      raw_sha256: null,
      normalizer_version: "0.1.0",
      tombstoned: false,
    },
  };
}

export function defaultSource(
  host: "codex" | "claude_code" | "deepseek_harness" | "manual_import" | "browser",
  provider: Provider = "unknown",
): Source {
  const defaults = {
    codex: { product: "codex", surface: "cli" as const, capture_method: "official_stream" as const, fidelity: "A" as const, authenticity: "locally_observed" as const },
    claude_code: { product: "claude-code", surface: "cli" as const, capture_method: "official_stream" as const, fidelity: "A" as const, authenticity: "locally_observed" as const },
    deepseek_harness: { product: "deepseek-harness", surface: "harness" as const, capture_method: "instrumented_harness" as const, fidelity: "A" as const, authenticity: "locally_observed" as const },
    manual_import: { product: "official-export", surface: "manual_import" as const, capture_method: "official_export" as const, fidelity: "B" as const, authenticity: "user_supplied" as const },
    browser: { product: "authorized-web", surface: "web" as const, capture_method: "authorized_dom" as const, fidelity: "C" as const, authenticity: "user_authorized_observation" as const },
  }[host];
  return {
    host,
    provider,
    ...defaults,
    adapter_version: "0.1.0",
    interface_version: "unknown",
    model_id: null,
    model_snapshot_or_weights_digest: null,
    origin: null,
    authenticity_evidence_ref: null,
  };
}

export function consentReceipt(host: string, cwd: string, createdAt = new Date()): string {
  // A receipt identifies this explicit capture action; it must not be a
  // dictionary-checkable hash of a private path. Path linkage, when requested,
  // is recorded separately through a per-trace keyed digest.
  void cwd;
  return stableId("consent", { host, at: createdAt.toISOString(), nonce: randomBytes(32).toString("hex") });
}

export function privatePathHmac(path: string, key: Uint8Array = randomBytes(32)): string {
  return createHmac("sha256", key).update(path, "utf8").digest("hex");
}
