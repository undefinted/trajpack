import type {
  EligibilityDecision,
  Rights,
  TraceManifest,
  TrajectoryEvent,
} from "@trajpack/schema";
import type {
  EventReviewPatch,
  EventRightsPatch,
  EventVerifierPatch,
  ExportPreview,
  ExportPreviewRequest,
  ExportReceipt,
  ExportRequest,
  ReviewApi,
  ReviewerBootstrap,
  TraceDecisionRequest,
  TraceDetail,
  TraceSummary,
} from "../api/types.js";

const NOW = "2026-08-16T04:10:00.000Z";
const EXPIRES = "2027-08-16T00:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const DEEPSEEK_TRACE_ID = "1".repeat(32);
const CLAUDE_TRACE_ID = "2".repeat(32);

const ownedRights: Rights = {
  source_license_expression: "Apache-2.0 AND MIT",
  model_license_chain: ["MIT"],
  input_rights_basis: "owned",
  third_party_content: "none",
  rights_holder: "Local workspace owner",
};

function decision(
  status: EligibilityDecision["status"],
  code: string,
  competitive: EligibilityDecision["competitive_with_source"] = "no",
): EligibilityDecision {
  return {
    status,
    purposes: status === "allow" ? ["research", "model_training"] : [],
    reason_codes: [code],
    basis: status === "allow" ? "Recorded permission and policy match" : "Source policy blocks this use",
    target_model_owner: "workspace-owner",
    target_product: "open-weights-terminal-agent",
    competitive_with_source: competitive,
    decision_id: `decision-${code}`,
    decided_at: NOW,
    expires_at: EXPIRES,
    reviewer: "policy-engine/0.1",
    evidence_ref: `terms://${code}`,
  };
}

function baseManifest(traceId: string): Omit<TraceManifest, "source" | "rights" | "eligibility" | "review"> {
  return {
    record_type: "trace_manifest",
    schema_version: "trajectory/0.1",
    trace_id: traceId,
    created_at: "2026-08-16T03:42:11.000Z",
    account_contract: {
      account_type: "self_hosted",
      contracting_region: "CN",
      workspace_owner_hmac: HASH_A,
      terms: [
        {
          name: "Captured terms snapshot",
          url: "https://example.invalid/terms",
          effective_at: "2026-01-01T00:00:00.000Z",
          retrieved_at: NOW,
          snapshot_sha256: HASH_B,
          review_after: EXPIRES,
        },
      ],
      order_form_or_written_permission_ref: "consent://workspace-owner",
    },
    consent: {
      receipt_id: "consent-local-001",
      subjects_scope: "single_user",
      purposes: ["research", "model_training"],
      active: true,
      captured_at: "2026-08-16T03:41:58.000Z",
      withdrawal_ref: null,
    },
    privacy: {
      legal_basis: "owner-consent",
      jurisdictions: ["CN"],
      storage_region: "local-device",
      retention_class: "review-pending-30d",
      redaction_policy_version: "secrets-pii/0.1",
    },
    environment: {
      cwd_hmac: HASH_B,
      repo_commit: "8e43c53d3b5c4d6ef4a526cd829f70c20f4bf70a",
      container_digest: null,
    },
    lineage: {
      parent_trace_ids: [],
      raw_sha256: HASH_A,
      normalizer_version: "normalizer/0.1.0",
      tombstoned: false,
    },
  };
}

const deepseekManifest: TraceManifest = {
  ...baseManifest(DEEPSEEK_TRACE_ID),
  source: {
    host: "deepseek_harness",
    provider: "deepseek",
    product: "DeepSeek Harness",
    surface: "harness",
    capture_method: "instrumented_harness",
    adapter_version: "0.1.0",
    interface_version: "session-format/0",
    model_id: "deepseek-reasoner",
    model_snapshot_or_weights_digest: null,
    origin: "local://deepseek-harness",
    fidelity: "A",
    authenticity: "locally_observed",
    authenticity_evidence_ref: null,
  },
  rights: ownedRights,
  eligibility: {
    local_archive: decision("allow", "local-owner"),
    automatic_capture: decision("allow", "explicit-arm"),
    training_noncompetitive: decision("allow", "deepseek-training"),
    training_competitive_distillation: decision("allow", "deepseek-distillation", "yes"),
    redistribution: decision("allow", "owned-inputs"),
  },
  review: {
    revision: 0,
    automated_checks: "passed",
    human_approval: "pending",
    reviewer: null,
    reviewed_at: null,
    notes: null,
    approval_scope: null,
  },
};

const claudeManifest: TraceManifest = {
  ...baseManifest(CLAUDE_TRACE_ID),
  account_contract: {
    ...baseManifest(CLAUDE_TRACE_ID).account_contract,
    account_type: "consumer",
    order_form_or_written_permission_ref: null,
  },
  source: {
    host: "claude_code",
    provider: "anthropic",
    product: "Claude Code",
    surface: "cli",
    capture_method: "official_stream",
    adapter_version: "0.1.0",
    interface_version: "stream-json/2026-08",
    model_id: "claude-sonnet",
    model_snapshot_or_weights_digest: null,
    origin: "local://claude-code",
    fidelity: "A",
    authenticity: "locally_observed",
    authenticity_evidence_ref: null,
  },
  rights: {
    ...ownedRights,
    source_license_expression: "Proprietary output terms",
    model_license_chain: ["Anthropic consumer terms"],
  },
  eligibility: {
    local_archive: decision("allow", "manual-local-archive"),
    automatic_capture: decision("deny", "consumer-automation-blocked"),
    training_noncompetitive: decision("unknown", "contract-review-required", "unknown"),
    training_competitive_distillation: decision("deny", "competitive-training-blocked", "yes"),
    redistribution: decision("unknown", "third-party-rights-unknown", "unknown"),
  },
  review: {
    revision: 0,
    automated_checks: "failed",
    human_approval: "pending",
    reviewer: null,
    reviewed_at: null,
    notes: null,
    approval_scope: null,
  },
};

function part(
  ordinal: number,
  type: TrajectoryEvent["content"][number]["type"],
  value: string,
  options: Partial<TrajectoryEvent["content"][number]> = {},
): TrajectoryEvent["content"][number] {
  return {
    ordinal,
    type,
    mime_type: type === "patch" ? "text/x-diff" : "text/plain",
    value,
    blob_ref: null,
    sha256: ordinal % 2 === 0 ? HASH_A : HASH_B,
    sensitivity: "internal",
    redaction_status: "passed",
    reasoning: null,
    rights_override: null,
    ...options,
    review_disposition: options.review_disposition ?? "include",
  };
}

function event(
  traceId: string,
  sequence: number,
  eventType: TrajectoryEvent["event_type"],
  actor: TrajectoryEvent["actor"],
  content: TrajectoryEvent["content"],
  options: Partial<TrajectoryEvent> = {},
): TrajectoryEvent {
  const sequenceHex = (sequence + 1).toString(16).padStart(16, "0");
  return {
    record_type: "event",
    event_id: `event-${traceId.slice(0, 4)}-${sequence}`,
    trace_id: traceId,
    span_id: sequenceHex,
    parent_span_id: sequence === 0 ? null : "0000000000000001",
    links: [],
    sequence,
    started_at: new Date(Date.parse("2026-08-16T03:42:12.000Z") + sequence * 1_000).toISOString(),
    ended_at: new Date(Date.parse("2026-08-16T03:42:12.400Z") + sequence * 1_000).toISOString(),
    event_type: eventType,
    actor,
    status: "ok",
    source_event_id: `source-${sequence}`,
    source_session_id: `session-${traceId.slice(0, 4)}`,
    source_turn_id: "turn-1",
    source_step_id: `step-${sequence}`,
    content,
    tool: null,
    usage: {
      input_tokens: null,
      output_tokens: null,
      reasoning_tokens: null,
      cache_read_tokens: null,
      latency_ms: 400,
      cost_usd: null,
    },
    metadata: {},
    ...options,
    review_disposition: options.review_disposition ?? "include",
  };
}

const deepseekEvents: TrajectoryEvent[] = [
  event(DEEPSEEK_TRACE_ID, 0, "message", "user", [
    part(0, "text", "修复解析器，并运行相关测试。输入中包含不可信标记：<script>window.pwned = true</script>"),
  ]),
  event(DEEPSEEK_TRACE_ID, 1, "reasoning", "assistant", [
    part(0, "reasoning", "先读取解析器和已有测试，再做最小修改。", {
      reasoning: {
        representation: "provider_exposed_reasoning",
        provider_claim: "chain_of_thought",
        source_field: "reasoning_content",
        visibility: "api_only",
        include_in_loss: false,
      },
    }),
  ], { usage: { input_tokens: 620, output_tokens: 84, reasoning_tokens: 64, cache_read_tokens: 400, latency_ms: 910, cost_usd: 0.0012 } }),
  event(DEEPSEEK_TRACE_ID, 2, "tool.call", "assistant", [part(0, "tool_call", "{\"cmd\":\"pnpm test parser\"}")], {
    tool: { call_id: "call-test-1", name: "exec_command", arguments: { cmd: "pnpm test parser" }, result: null, exit_code: null },
  }),
  event(DEEPSEEK_TRACE_ID, 3, "tool.result", "tool", [
    part(0, "stdout", "FAIL parser.test.ts\nExpected 3 fields, received 2\n<img src=x onerror=alert('not rendered')>"),
  ], { status: "error", tool: { call_id: "call-test-1", name: "exec_command", arguments: null, result: "failed", exit_code: 1 } }),
  event(DEEPSEEK_TRACE_ID, 4, "artifact.patch", "assistant", [
    part(0, "patch", "@@ -41,1 +41,1 @@\n- return fields.slice(0, 2)\n+ return fields.slice(0, 3)"),
  ]),
  event(DEEPSEEK_TRACE_ID, 5, "tool.call", "assistant", [part(0, "tool_call", "{\"cmd\":\"pnpm test parser\"}")], {
    tool: { call_id: "call-test-2", name: "exec_command", arguments: { cmd: "pnpm test parser" }, result: null, exit_code: null },
  }),
  event(DEEPSEEK_TRACE_ID, 6, "tool.result", "tool", [part(0, "stdout", "PASS parser.test.ts (12 tests)")], {
    tool: { call_id: "call-test-2", name: "exec_command", arguments: null, result: "passed", exit_code: 0 },
  }),
  event(DEEPSEEK_TRACE_ID, 7, "evaluation", "environment", [part(0, "text", "Verifier: related tests passed; no unrelated files changed.")]),
];

const claudeEvents: TrajectoryEvent[] = [
  event(CLAUDE_TRACE_ID, 0, "message", "user", [part(0, "text", "Summarize this private customer transcript.")]),
  event(CLAUDE_TRACE_ID, 1, "message", "assistant", [
    part(0, "text", "The transcript contains a customer email and support case identifier.", {
      sensitivity: "confidential",
      redaction_status: "quarantined",
    }),
  ]),
];

function makeDetail(manifest: TraceManifest, events: TrajectoryEvent[], failed = false): TraceDetail {
  return {
    manifest,
    events: events.map((entry) => ({
      event: entry,
      review: {
        event_id: entry.event_id,
        disposition: "include",
        note: null,
        redaction_replacement: null,
        rights_override: null,
        rights_attestation: null,
        verifier_confirmation: null,
        updated_at: NOW,
      },
    })),
    checks: failed
      ? [
          {
            check_id: "policy-training",
            category: "rights",
            label: "训练用途许可",
            status: "failed",
            summary: "竞争性模型训练被来源条款明确阻断。",
            affected_event_ids: claudeEvents.map((entry) => entry.event_id),
            scanner_version: "policy/0.1.0",
          },
          {
            check_id: "pii-scan",
            category: "privacy",
            label: "PII 扫描",
            status: "failed",
            summary: "检测到未处理的个人邮箱与客户工单标识。",
            affected_event_ids: [claudeEvents[1]?.event_id ?? ""],
            scanner_version: "secrets-pii/0.1.0",
          },
        ]
      : [
          {
            check_id: "topology",
            category: "structure",
            label: "轨迹拓扑",
            status: "passed",
            summary: "事件顺序连续，工具调用与结果全部配对。",
            affected_event_ids: [],
            scanner_version: "topology/0.1.0",
          },
          {
            check_id: "secrets",
            category: "privacy",
            label: "凭证与 PII",
            status: "passed",
            summary: "未发现凭证；不可信标记已作为纯文本保留。",
            affected_event_ids: [],
            scanner_version: "secrets-pii/0.1.0",
          },
          {
            check_id: "rights",
            category: "rights",
            label: "权利交集",
            status: "passed",
            summary: "host、model、input 与 consent 均允许目标训练用途。",
            affected_event_ids: [],
            scanner_version: "policy/0.1.0",
          },
          {
            check_id: "egs",
            category: "quality",
            label: "环境落地监督",
            status: "warning",
            summary: "包含失败、修复和验证闭环；建议人工确认 patch 与任务相关。",
            affected_event_ids: [deepseekEvents[4]?.event_id ?? ""],
            scanner_version: "quality/0.1.0",
          },
        ],
    metrics: failed
      ? { input_tokens: 210, output_tokens: 38, reasoning_tokens: 0, tool_calls: 0, failed_events: 0, observation_action_pairs: 0, verification_events: 0, targeted_observation_ratio: null }
      : { input_tokens: 620, output_tokens: 318, reasoning_tokens: 64, tool_calls: 2, failed_events: 1, observation_action_pairs: 2, verification_events: 1, targeted_observation_ratio: 0.72 },
    revision: 1,
  };
}

const seedDetails = [
  makeDetail(deepseekManifest, deepseekEvents),
  makeDetail(claudeManifest, claudeEvents, true),
];

function clone<T>(value: T): T {
  return structuredClone(value);
}

function toSummary(detail: TraceDetail): TraceSummary {
  const dispositions = detail.events.map(({ review }) => review.disposition);
  const started = detail.events.at(0)?.event.started_at;
  const ended = detail.events.at(-1)?.event.ended_at;
  return {
    trace_id: detail.manifest.trace_id,
    created_at: detail.manifest.created_at,
    source: detail.manifest.source,
    automated_checks: detail.manifest.review.automated_checks,
    human_approval: detail.manifest.review.human_approval,
    event_count: detail.events.length,
    included_count: dispositions.filter((value) => value === "include").length,
    redacted_count: dispositions.filter((value) => value === "redact").length,
    blocker_count: detail.checks.filter(({ status }) => status === "failed").length,
    warning_count: detail.checks.filter(({ status }) => status === "warning").length,
    duration_ms: started && ended ? Date.parse(ended) - Date.parse(started) : null,
    updated_at: NOW,
  };
}

export class MockReviewApi implements ReviewApi {
  private readonly details = new Map(seedDetails.map((detail) => [detail.manifest.trace_id, clone(detail)]));

  async bootstrap(): Promise<ReviewerBootstrap> {
    return clone({
      api_version: "review/0.1",
      csrf_token: "development-only-mock-token",
      server_version: "reviewer-mock/0.1.0",
      vault: { state: "unlocked", idle_lock_at: "2026-08-16T05:00:00.000Z" },
    });
  }

  async listTraces(): Promise<TraceSummary[]> {
    return [...this.details.values()].map(toSummary).map(clone);
  }

  async getTrace(traceId: string): Promise<TraceDetail> {
    return clone(this.requireTrace(traceId));
  }

  async updateEvent(traceId: string, eventId: string, patch: EventReviewPatch): Promise<TraceDetail> {
    const detail = this.requireTrace(traceId);
    this.assertRevision(detail, patch.expected_revision);
    const entry = detail.events.find(({ event }) => event.event_id === eventId);
    if (!entry) throw new Error("Event not found");
    if (patch.disposition !== undefined) entry.review.disposition = patch.disposition;
    if (patch.note !== undefined) entry.review.note = patch.note;
    if (patch.redaction_replacement !== undefined) entry.review.redaction_replacement = patch.redaction_replacement;
    entry.review.updated_at = new Date().toISOString();
    detail.revision += 1;
    return clone(detail);
  }

  async updateEventRights(traceId: string, eventId: string, patch: EventRightsPatch): Promise<TraceDetail> {
    const detail = this.requireTrace(traceId);
    this.assertRevision(detail, patch.expected_revision);
    const entry = detail.events.find(({ event }) => event.event_id === eventId);
    if (!entry) throw new Error("Event not found");
    entry.review.rights_override = clone(patch.rights_override);
    entry.review.rights_attestation = patch.rights_override === null ? null : {
      schema_version: "rights-attestation/0.1",
      rights: clone(patch.rights_override),
      scopes: (patch.modes ?? []).map((mode) => {
        const decision = mode === "archive" ? detail.manifest.eligibility.local_archive : detail.manifest.eligibility[mode];
        return { mode, target_model_owner: decision.target_model_owner, target_product: decision.target_product };
      }),
      reviewer: patch.reviewer ?? "mock-reviewer",
      evidence_ref: patch.evidence_ref ?? "mock://rights-evidence",
      evidence_sha256: patch.evidence_sha256 ?? HASH_A,
      attested_at: NOW,
      expires_at: patch.expires_at ?? EXPIRES,
      event_sha256: HASH_A,
      source_sha256: HASH_B,
    };
    entry.review.updated_at = new Date().toISOString();
    this.resetApproval(detail);
    detail.revision += 1;
    return clone(detail);
  }

  async updateEventVerifier(traceId: string, eventId: string, patch: EventVerifierPatch): Promise<TraceDetail> {
    const detail = this.requireTrace(traceId);
    this.assertRevision(detail, patch.expected_revision);
    const entry = detail.events.find(({ event }) => event.event_id === eventId);
    if (!entry) throw new Error("Event not found");
    const verifier = entry.event.metadata.verifier as { name?: unknown; version?: unknown; artifact_sha256?: unknown; result_sha256?: unknown } | undefined;
    const reward = entry.event.metadata.reward;
    entry.review.verifier_confirmation = patch.confirmation === null ? null : {
      schema_version: "verifier-confirmation/0.1",
      reviewer: patch.confirmation.reviewer,
      evidence_ref: patch.confirmation.evidence_ref,
      confirmed_at: NOW,
      event_sha256: HASH_A,
      reward: typeof reward === "number" ? reward : 0,
      verifier: {
        name: typeof verifier?.name === "string" ? verifier.name : "mock-verifier",
        version: typeof verifier?.version === "string" ? verifier.version : "1",
        artifact_sha256: typeof verifier?.artifact_sha256 === "string" ? verifier.artifact_sha256 : HASH_A,
        result_sha256: typeof verifier?.result_sha256 === "string" ? verifier.result_sha256 : null,
      },
    };
    entry.review.updated_at = new Date().toISOString();
    this.resetApproval(detail);
    detail.revision += 1;
    return clone(detail);
  }

  async decideTrace(traceId: string, request: TraceDecisionRequest): Promise<TraceDetail> {
    const detail = this.requireTrace(traceId);
    this.assertRevision(detail, request.expected_revision);
    if (request.decision === "approved" && detail.checks.some(({ status }) => status === "failed")) {
      throw new Error("Automated blockers must be resolved before approval");
    }
    detail.manifest.review.human_approval = request.decision;
    detail.manifest.review.reviewer = request.reviewer;
    detail.manifest.review.reviewed_at = new Date().toISOString();
    detail.manifest.review.notes = request.notes;
    detail.manifest.review.approval_scope = request.decision === "approved" ? {
      bundle_sha256: "0".repeat(64),
      reviewer: request.reviewer,
      reviewed_at: detail.manifest.review.reviewed_at!,
      notes_sha256: "0".repeat(64),
      decisions: request.approved_modes.map((mode) => {
        const eligibility = mode === "archive"
          ? detail.manifest.eligibility.local_archive
          : detail.manifest.eligibility[mode];
        return {
          mode,
          decision_id: eligibility.decision_id,
          target_model_owner: eligibility.target_model_owner,
          target_product: eligibility.target_product,
        };
      }),
    } : null;
    detail.revision += 1;
    return clone(detail);
  }

  async previewExport(traceId: string, request: ExportPreviewRequest): Promise<ExportPreview> {
    const detail = this.requireTrace(traceId);
    this.assertRevision(detail, request.expected_revision);
    const approved = detail.manifest.review.human_approval === "approved";
    const trainingAllowed = detail.manifest.eligibility.training_competitive_distillation.status === "allow";
    const allowed = approved && trainingAllowed && !detail.checks.some(({ status }) => status === "failed");
    return {
      trace_id: traceId,
      format: request.format,
      mode: request.mode,
      destination_hint: `./exports/${traceId.slice(0, 8)}.${request.format === "hf-trl" ? "jsonl" : "zip"}`,
      example_count: 1,
      plaintext_bytes_estimate: 18_420,
      excluded_event_count: detail.events.filter(({ review }) => review.disposition === "exclude").length,
      redacted_part_count: detail.events.filter(({ review }) => review.disposition === "redact").length,
      license_summary: detail.manifest.rights.source_license_expression,
      warnings: ["导出文件为明文，离开加密 vault 后无法由 trajpack 自动撤回。"],
      export_allowed: allowed,
      block_reasons: allowed ? [] : ["轨迹必须通过所有 hard gate 并获得人工批准。"],
      confirmation_phrase: "EXPORT PLAINTEXT",
    };
  }

  async exportTrace(traceId: string, request: ExportRequest): Promise<ExportReceipt> {
    const preview = await this.previewExport(traceId, request);
    if (!preview.export_allowed || request.confirmation_phrase !== preview.confirmation_phrase) {
      throw new Error("Plaintext export was not confirmed or is policy-blocked");
    }
    return {
      export_id: `export-${Date.now()}`,
      trace_id: traceId,
      format: request.format,
      created_at: new Date().toISOString(),
      destination: preview.destination_hint,
      sha256: HASH_A,
    };
  }

  private requireTrace(traceId: string): TraceDetail {
    const detail = this.details.get(traceId);
    if (!detail) throw new Error("Trace not found");
    return detail;
  }

  private assertRevision(detail: TraceDetail, expected: number): void {
    if (detail.revision !== expected) throw new Error("Trace changed; refresh before saving");
  }

  private resetApproval(detail: TraceDetail): void {
    detail.manifest.review.human_approval = "pending";
    detail.manifest.review.reviewer = null;
    detail.manifest.review.reviewed_at = null;
    detail.manifest.review.approval_scope = null;
  }
}

export const mockTraceIds = {
  deepseek: DEEPSEEK_TRACE_ID,
  claude: CLAUDE_TRACE_ID,
} as const;
