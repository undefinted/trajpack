import { describe, expect, it } from "vitest";
import type { PermissionEvidence, Source } from "@trajpack/schema";
import { canonicalJson, sha256 } from "./canonical.js";
import { createManifest } from "./manifest.js";
import { evaluateDefaultEligibility, evaluateGate, reviewEvidenceFingerprint } from "./policy.js";
import { fixtureBundle } from "./testing.js";

const EVIDENCE_NOW = new Date("2026-08-16T00:00:00.000Z");

function scopedPermission(overrides: Partial<PermissionEvidence> = {}): PermissionEvidence {
  return {
    evidence_ref: "contract:scope-17",
    provider: "openai",
    account_type: "consumer",
    capture_methods: ["official_hook"],
    origins: [],
    permitted_purposes: ["automatic_capture"],
    target_model_owner: null,
    target_product: null,
    reviewer: "contracts-team",
    effective_at: "2026-08-01T00:00:00.000Z",
    expires_at: "2027-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function codexConsumerSource(overrides: Partial<Source> = {}): Source {
  return {
    ...fixtureBundle().manifest.source,
    host: "codex",
    provider: "openai",
    product: "codex",
    surface: "cli",
    capture_method: "official_hook",
    origin: null,
    ...overrides,
  };
}

function attestEventRights(
  bundle: ReturnType<typeof fixtureBundle>,
  rights: ReturnType<typeof fixtureBundle>["manifest"]["rights"],
): void {
  const event = bundle.events[0]!;
  event.content = event.content.map((part) => ({ ...part, rights_override: rights }));
  const decision = bundle.manifest.eligibility.training_competitive_distillation;
  event.metadata.trajpack_review = {
    rights_override: rights,
    rights_attestation: {
      schema_version: "rights-attestation/0.1",
      rights,
      scopes: [{
        mode: "training_competitive_distillation",
        target_model_owner: decision.target_model_owner,
        target_product: decision.target_product,
      }],
      reviewer: "fixture-rights-reviewer",
      evidence_ref: "rights-evidence:fixture",
      evidence_sha256: "b".repeat(64),
      attested_at: "2026-08-16T00:00:00.000Z",
      expires_at: "2099-01-01T00:00:00.000Z",
      event_sha256: reviewEvidenceFingerprint(event),
      source_sha256: sha256(canonicalJson(bundle.manifest.source)),
    },
  };
}

describe("policy gates", () => {
  it("fails closed for OpenAI consumer competitive training", () => {
    const bundle = fixtureBundle();
    const eligibility = evaluateDefaultEligibility({
      source: { ...bundle.manifest.source, host: "codex", provider: "openai", product: "codex", surface: "cli", capture_method: "official_hook" },
      accountType: "consumer",
      rights: bundle.manifest.rights,
      consentActive: true,
      targetModelOwner: "user",
      targetProduct: "general-open-model",
      competitive: "yes",
      now: new Date("2026-08-16T00:00:00.000Z"),
    });
    expect(eligibility.automatic_capture.status).toBe("deny");
    expect(eligibility.training_competitive_distillation.status).toBe("deny");
  });

  it("allows a reviewed self-hosted fixture", () => {
    expect(evaluateGate(fixtureBundle(), "training_competitive_distillation").allowed).toBe(true);
  });

  it("requires a model/weights license chain for self-hosted training", () => {
    const bundle = fixtureBundle();
    bundle.manifest.rights.model_license_chain = [];
    expect(evaluateGate(bundle, "training_competitive_distillation").reasonCodes)
      .toContain("MODEL_LICENSE_CHAIN_UNKNOWN");
  });

  it("blocks unreviewed data", () => {
    const bundle = fixtureBundle();
    bundle.manifest.review.human_approval = "pending";
    expect(evaluateGate(bundle, "training_competitive_distillation").reasonCodes).toContain("HUMAN_APPROVAL_REQUIRED");
  });

  it("requires participant consent for the exact requested purpose", () => {
    const bundle = fixtureBundle();
    bundle.manifest.consent.purposes = ["archive"];
    expect(evaluateGate(bundle, "archive").reasonCodes).not.toContain("CONSENT_PURPOSE_MISSING");
    expect(evaluateGate(bundle, "training_competitive_distillation").reasonCodes)
      .toContain("CONSENT_PURPOSE_MISSING");
    bundle.manifest.consent.purposes = ["archive", "evaluation"];
    expect(evaluateGate(bundle, "training_noncompetitive").reasonCodes)
      .toContain("CONSENT_PURPOSE_MISSING");
    bundle.manifest.consent.purposes.push("sft");
    bundle.manifest.consent.withdrawal_ref = "withdrawal-receipt";
    expect(evaluateGate(bundle, "training_noncompetitive").reasonCodes)
      .toContain("CONSENT_WITHDRAWN");
  });

  it("blocks unknown account/provider and unspecified training targets", () => {
    const bundle = fixtureBundle();
    bundle.manifest.source.provider = "unknown";
    bundle.manifest.account_contract.account_type = "unknown";
    bundle.manifest.eligibility.training_competitive_distillation.target_model_owner = null;
    bundle.manifest.eligibility.training_competitive_distillation.competitive_with_source = "unknown";
    const result = evaluateGate(bundle, "training_competitive_distillation");
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      "ACCOUNT_TYPE_UNKNOWN",
      "MODEL_PROVIDER_UNKNOWN",
      "TRAINING_TARGET_UNKNOWN",
      "COMPETITIVENESS_UNKNOWN",
    ]));
  });

  it("does not let excluded content block or leak into a training gate", () => {
    const bundle = fixtureBundle();
    const excluded = structuredClone(bundle.events[0]!);
    excluded.event_id = "evt_excluded_secret";
    excluded.span_id = "fedcba9876543210";
    excluded.sequence = 1;
    excluded.review_disposition = "exclude";
    excluded.content[0]!.redaction_status = "quarantined";
    bundle.events.push(excluded);
    expect(evaluateGate(bundle, "training_competitive_distillation").allowed).toBe(true);
  });

  it("requires terms from the provider and account registry authority", () => {
    const bundle = fixtureBundle();
    bundle.manifest.source.provider = "deepseek";
    bundle.manifest.source.surface = "api";
    bundle.manifest.account_contract.account_type = "api";
    bundle.manifest.account_contract.order_form_or_written_permission_ref = null;
    bundle.manifest.account_contract.terms = [{
      name: "Unrelated terms",
      url: "https://example.test/terms",
      effective_at: "2026-01-01T00:00:00.000Z",
      retrieved_at: "2026-08-16T00:00:00.000Z",
      snapshot_sha256: "a".repeat(64),
      review_after: "2099-01-01T00:00:00.000Z",
    }];
    expect(evaluateGate(bundle, "training_competitive_distillation").reasonCodes).toContain("TERMS_SOURCE_MISMATCH");
    bundle.manifest.account_contract.terms[0]!.url = "https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html";
    const authorityOnly = evaluateGate(bundle, "training_competitive_distillation").reasonCodes;
    expect(authorityOnly).not.toContain("TERMS_SOURCE_MISMATCH");
    expect(authorityOnly).toContain("TERMS_SNAPSHOT_UNPINNED");
  });

  it("blocks incomplete per-content rights even when manifest rights are known", () => {
    const bundle = fixtureBundle();
    bundle.events[0]!.content[0]!.rights_override = {
      source_license_expression: "NOASSERTION",
      model_license_chain: [],
      input_rights_basis: "owned",
      third_party_content: "unknown",
      rights_holder: null,
    };
    const reasons = evaluateGate(bundle, "training_competitive_distillation").reasonCodes;
    expect(reasons).toEqual(expect.arrayContaining([
      "RIGHTS_ATTESTATION_REQUIRED",
      "RIGHTS_ATTESTATION_CONTENT_MISMATCH",
    ]));
  });

  it("rescans included structured fields and content at the export gate", () => {
    const bundle = fixtureBundle();
    bundle.events[0]!.tool = {
      call_id: "call-1",
      name: "request",
      arguments: { authorization: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" },
      result: null,
      exit_code: null,
    };
    expect(evaluateGate(bundle, "archive").reasonCodes).toContain("STRUCTURED_PRIVACY_FINDINGS");
  });

  it("blocks sensitive manifest evidence from plaintext export", () => {
    const bundle = fixtureBundle();
    bundle.manifest.review.notes = "Contact reviewer@example.com for the raw prompt";
    expect(evaluateGate(bundle, "archive").reasonCodes).toContain("MANIFEST_PRIVACY_FINDINGS");
  });

  it("scans policy override evidence and all other exported manifest strings", () => {
    const bundle = fixtureBundle();
    bundle.manifest.eligibility.training_competitive_distillation.evidence_ref = "Authorization: Bearer top-secret-credential";
    expect(evaluateGate(bundle, "archive").reasonCodes).toContain("MANIFEST_PRIVACY_FINDINGS");
  });

  it("normalizes unknown license sentinels and requires itemized third-party rights", () => {
    const bundle = fixtureBundle();
    bundle.manifest.rights.source_license_expression = " noassertion ";
    bundle.manifest.rights.model_license_chain = [" NoAssertion "];
    let reasons = evaluateGate(bundle, "training_competitive_distillation").reasonCodes;
    expect(reasons).toEqual(expect.arrayContaining(["SOURCE_LICENSE_UNKNOWN", "MODEL_LICENSE_CHAIN_UNKNOWN"]));

    bundle.manifest.rights = {
      source_license_expression: "Apache-2.0",
      model_license_chain: ["Apache-2.0"],
      input_rights_basis: "owned",
      third_party_content: "present",
      rights_holder: null,
    };
    reasons = evaluateGate(bundle, "training_competitive_distillation").reasonCodes;
    expect(reasons).toContain("THIRD_PARTY_CONTENT_REQUIRES_ITEMIZED_RIGHTS");
  });

  it("requires a reviewed event-level rights decision for structured tool payloads", () => {
    const bundle = fixtureBundle();
    bundle.manifest.rights.input_rights_basis = "unknown";
    bundle.manifest.rights.third_party_content = "unknown";
    bundle.manifest.rights.source_license_expression = "NOASSERTION";
    bundle.events[0]!.content[0]!.rights_override = {
      source_license_expression: "Apache-2.0",
      model_license_chain: [],
      input_rights_basis: "licensed",
      third_party_content: "none",
      rights_holder: "licensor",
    };
    bundle.events[0]!.tool = { call_id: "call", name: "read", arguments: null, result: { code: "third party" }, exit_code: 0 };
    expect(evaluateGate(bundle, "training_competitive_distillation").reasonCodes)
      .toContain("STRUCTURED_TOOL_RIGHTS_UNKNOWN");
    attestEventRights(bundle, bundle.events[0]!.content[0]!.rights_override!);
    expect(evaluateGate(bundle, "training_competitive_distillation").reasonCodes)
      .not.toContain("STRUCTURED_TOOL_RIGHTS_UNKNOWN");
  });

  it("does not treat an unscoped written-permission reference as training approval", () => {
    const bundle = fixtureBundle();
    const eligibility = evaluateDefaultEligibility({
      source: { ...bundle.manifest.source, provider: "openai", host: "codex", product: "codex", surface: "cli", capture_method: "official_hook" },
      accountType: "business",
      rights: bundle.manifest.rights,
      consentActive: true,
      writtenPermissionRef: "contract-ref-needs-scoped-override",
      targetModelOwner: "user",
      targetProduct: "general-model",
      competitive: "yes",
      now: new Date("2026-08-16T00:00:00.000Z"),
    });
    expect(eligibility.training_competitive_distillation.status).not.toBe("allow");
    expect(eligibility.training_competitive_distillation.reason_codes).toContain("SCOPED_TRAINING_OVERRIDE_REQUIRED");
  });

  it("does not let a bare written-permission reference override automatic-capture defaults", () => {
    const eligibility = evaluateDefaultEligibility({
      source: codexConsumerSource(),
      accountType: "consumer",
      rights: fixtureBundle().manifest.rights,
      consentActive: true,
      writtenPermissionRef: "contract:scope-17",
      now: EVIDENCE_NOW,
    });
    expect(eligibility.automatic_capture.status).toBe("deny");
    expect(eligibility.automatic_capture.evidence_ref).toBeNull();
  });

  it("allows automatic capture only when every scoped permission field matches", () => {
    const baseContext = {
      source: codexConsumerSource(),
      accountType: "consumer" as const,
      rights: fixtureBundle().manifest.rights,
      consentActive: true,
      writtenPermissionRef: "contract:scope-17",
      now: EVIDENCE_NOW,
    };
    expect(evaluateDefaultEligibility({
      ...baseContext,
      permissionEvidence: scopedPermission(),
    }).automatic_capture.status).toBe("allow");

    const mismatches: PermissionEvidence[] = [
      scopedPermission({ provider: "anthropic" }),
      scopedPermission({ account_type: "api" }),
      scopedPermission({ capture_methods: ["official_stream"] }),
      scopedPermission({ origins: ["https://authorized.example"] }),
      scopedPermission({ permitted_purposes: ["training_noncompetitive"] }),
      scopedPermission({ reviewer: " " }),
      scopedPermission({ effective_at: "2026-09-01T00:00:00.000Z" }),
      scopedPermission({ expires_at: "2026-08-15T00:00:00.000Z" }),
      scopedPermission({ evidence_ref: "contract:some-other-scope" }),
    ];
    for (const evidence of mismatches) {
      expect(evaluateDefaultEligibility({
        ...baseContext,
        permissionEvidence: evidence,
      }).automatic_capture.status).not.toBe("allow");
    }
  });

  it("binds training permission to its exact purpose and target", () => {
    const evidence = scopedPermission({
      permitted_purposes: ["training_competitive_distillation"],
      target_model_owner: "example-lab",
      target_product: "example-general-model",
    });
    const baseContext = {
      source: codexConsumerSource(),
      accountType: "consumer" as const,
      rights: fixtureBundle().manifest.rights,
      consentActive: true,
      writtenPermissionRef: evidence.evidence_ref,
      permissionEvidence: evidence,
      targetModelOwner: "example-lab",
      targetProduct: "example-general-model",
      competitive: "yes" as const,
      now: EVIDENCE_NOW,
    };
    const exact = evaluateDefaultEligibility(baseContext);
    expect(exact.training_competitive_distillation.status).toBe("allow");
    expect(exact.training_noncompetitive.status).not.toBe("allow");
    expect(evaluateDefaultEligibility({
      ...baseContext,
      targetProduct: "different-model",
    }).training_competitive_distillation.status).not.toBe("allow");
  });

  it("uses scoped evidence, never a bare reference, as the unpinned-terms exception", () => {
    const source = codexConsumerSource();
    const rights = fixtureBundle().manifest.rights;
    const bare = createManifest({
      source,
      accountType: "consumer",
      rights,
      consentReceipt: "consent:bare",
      consentPurposes: ["archive", "capture"],
      writtenPermissionRef: "contract:scope-17",
      createdAt: EVIDENCE_NOW,
    });
    expect(evaluateGate({ manifest: bare, raw: [], events: [] }, "automatic_capture", EVIDENCE_NOW).reasonCodes)
      .toEqual(expect.arrayContaining(["TERMS_MISSING_OR_STALE", "TERMS_SOURCE_MISMATCH", "TERMS_SNAPSHOT_UNPINNED"]));

    const scoped = createManifest({
      source,
      accountType: "consumer",
      rights,
      consentReceipt: "consent:scoped",
      consentPurposes: ["archive", "capture"],
      permissionEvidence: scopedPermission(),
      createdAt: EVIDENCE_NOW,
    });
    const scopedResult = evaluateGate(
      { manifest: scoped, raw: [], events: [] },
      "automatic_capture",
      EVIDENCE_NOW,
    );
    expect(scopedResult.reasonCodes).not.toEqual(expect.arrayContaining([
      "TERMS_MISSING_OR_STALE",
      "TERMS_SOURCE_MISMATCH",
      "TERMS_SNAPSHOT_UNPINNED",
    ]));
    expect(scopedResult.allowed).toBe(true);
  });

  it("keeps DeepSeek API artifact acquisition separate from its training permission", () => {
    const bundle = fixtureBundle();
    const eligibility = evaluateDefaultEligibility({
      source: {
        ...bundle.manifest.source,
        host: "manual_import",
        provider: "deepseek",
        product: "deepseek-api-response",
        surface: "api",
        capture_method: "manual_copy",
        interface_version: "deepseek_api_response",
      },
      accountType: "api",
      rights: bundle.manifest.rights,
      consentActive: true,
      targetModelOwner: "user",
      targetProduct: "general-model",
      competitive: "yes",
      now: new Date("2026-08-16T00:00:00.000Z"),
    });
    expect(eligibility.automatic_capture.status).toBe("deny");
    expect(eligibility.training_competitive_distillation.status).toBe("allow");
  });

  it("does not grant DeepSeek training from a mutable provider label alone", () => {
    const bundle = fixtureBundle();
    const eligibility = evaluateDefaultEligibility({
      source: {
        ...bundle.manifest.source,
        host: "manual_import",
        provider: "deepseek",
        product: "official-export:chatgpt_official_json",
        surface: "official_export",
        capture_method: "official_export",
        interface_version: "chatgpt_official_json",
      },
      accountType: "api",
      rights: bundle.manifest.rights,
      consentActive: true,
      targetModelOwner: "user",
      targetProduct: "general-model",
      competitive: "yes",
    });
    expect(eligibility.training_competitive_distillation.status).not.toBe("allow");
  });
});
