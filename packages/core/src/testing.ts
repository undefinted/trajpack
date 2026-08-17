import type { TraceBundle } from "@trajpack/schema";
import { SCHEMA_VERSION } from "@trajpack/schema";
import { canonicalJson, sha256 } from "./canonical.js";

export function fixtureBundle(text = "hello"): TraceBundle {
  const created = "2026-08-16T00:00:00.000Z";
  const allow = (name: string, competitiveWithSource: "yes" | "no" = "no") => ({
    status: "allow" as const,
    purposes: [name],
    reason_codes: ["TEST_FIXTURE"],
    basis: name === "sft" || name === "distillation"
      ? `manual-override:policy/2026-08-16.4:fixture-${name}`
      : "test",
    target_model_owner: "owner",
    target_product: "open-model",
    competitive_with_source: competitiveWithSource,
    decision_id: `decision_${name}`,
    decided_at: created,
    expires_at: "2099-01-01T00:00:00.000Z",
    reviewer: "fixture",
    evidence_ref: name === "sft" || name === "distillation"
      ? `fixture:sha256:${sha256(`fixture-${name}`)}`
      : "fixture",
  });
  const bundle: TraceBundle = {
    manifest: {
      record_type: "trace_manifest",
      schema_version: SCHEMA_VERSION,
      trace_id: "0123456789abcdef0123456789abcdef",
      created_at: created,
      source: {
        host: "deepseek_harness",
        provider: "self_hosted",
        product: "deepseek-harness",
        surface: "harness",
        capture_method: "instrumented_harness",
        adapter_version: "0.1.0",
        interface_version: "deepseek-harness@0.1.0-rc.6/session-event/0",
        model_id: "fixture-model",
        model_snapshot_or_weights_digest: `sha256:${"f".repeat(64)}`,
        origin: null,
        fidelity: "A",
        authenticity: "locally_observed",
        authenticity_evidence_ref: `local-model-artifact:sha256:${"f".repeat(64)}`,
      },
      account_contract: {
        account_type: "self_hosted",
        contracting_region: null,
        workspace_owner_hmac: null,
        terms: [],
        order_form_or_written_permission_ref: "fixture",
      },
      rights: {
        source_license_expression: "Apache-2.0",
        model_license_chain: ["Apache-2.0"],
        input_rights_basis: "owned",
        third_party_content: "none",
        rights_holder: "fixture",
      },
      consent: {
        receipt_id: "fixture-consent",
        subjects_scope: "single_user",
        purposes: ["archive", "sft", "distillation", "release"],
        active: true,
        captured_at: created,
        withdrawal_ref: null,
      },
      eligibility: {
        local_archive: allow("archive"),
        automatic_capture: allow("capture"),
        training_noncompetitive: allow("sft"),
        training_competitive_distillation: allow("distillation", "yes"),
        redistribution: allow("release"),
      },
      privacy: {
        legal_basis: "test fixture",
        jurisdictions: [],
        storage_region: "local",
        retention_class: "test",
        redaction_policy_version: "redaction/0.1",
      },
      environment: { cwd_hmac: null, repo_commit: null, container_digest: null },
      review: {
        revision: 0,
        automated_checks: "passed",
        human_approval: "approved",
        reviewer: "fixture",
        reviewed_at: created,
        notes: "fixture approval",
        approval_scope: null,
      },
      lineage: {
        parent_trace_ids: [],
        raw_sha256: null,
        normalizer_version: "0.1.0",
        tombstoned: false,
      },
    },
    raw: [],
    events: [{
      record_type: "event",
      event_id: "evt_fixture",
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "0123456789abcdef",
      parent_span_id: null,
      links: [],
      sequence: 0,
      started_at: created,
      ended_at: created,
      event_type: "message",
      actor: "assistant",
      status: "ok",
      source_event_id: "fixture-0",
      source_session_id: "fixture-session",
      source_turn_id: "fixture-turn",
      source_step_id: null,
      content: [{
        ordinal: 0,
        type: "text",
        mime_type: "text/plain",
        value: text,
        blob_ref: null,
        sha256: sha256(text),
        sensitivity: "internal",
        redaction_status: "passed",
        review_disposition: "include",
        reasoning: null,
        rights_override: null,
      }],
      tool: null,
      usage: {
        input_tokens: null,
        output_tokens: null,
        reasoning_tokens: null,
        cache_read_tokens: null,
        latency_ms: null,
        cost_usd: null,
      },
      metadata: {},
      review_disposition: "include",
    }],
  };
  const { review: _review, ...manifest } = bundle.manifest;
  bundle.manifest.review.approval_scope = {
    bundle_sha256: sha256(canonicalJson({ manifest, events: bundle.events })),
    reviewer: "fixture",
    reviewed_at: created,
    notes_sha256: sha256("fixture approval"),
    decisions: ([
      ["archive", bundle.manifest.eligibility.local_archive],
      ["training_noncompetitive", bundle.manifest.eligibility.training_noncompetitive],
      ["training_competitive_distillation", bundle.manifest.eligibility.training_competitive_distillation],
      ["redistribution", bundle.manifest.eligibility.redistribution],
    ] as const).map(([mode, decision]) => ({
      mode,
      decision_id: decision.decision_id,
      target_model_owner: decision.target_model_owner,
      target_product: decision.target_product,
    })),
  };
  return bundle;
}
