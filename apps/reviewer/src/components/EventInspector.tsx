import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { ApprovalMode, Eligibility, Rights } from "@trajpack/schema";
import { verifierEvidenceSchema } from "@trajpack/schema";
import type { EventReviewPatch, EventRightsPatch, EventVerifierPatch, ReviewEvent } from "../api/types.js";
import { formatDateTime, humanize, shortId } from "../format.js";
import { SafeText } from "./SafeText.js";
import { StatusBadge } from "./StatusBadge.js";

interface EventInspectorProps {
  entry: ReviewEvent | null;
  inheritedRights: Rights;
  eligibility: Eligibility;
  busy: boolean;
  onSaveReview: (patch: Omit<EventReviewPatch, "expected_revision">) => void;
  onSaveRights: (patch: Omit<EventRightsPatch, "expected_revision">) => void;
  onSaveVerifier: (patch: Omit<EventVerifierPatch, "expected_revision">) => void;
}

export function EventInspector({
  entry,
  inheritedRights,
  eligibility,
  busy,
  onSaveReview,
  onSaveRights,
  onSaveVerifier,
}: EventInspectorProps): ReactNode {
  const [note, setNote] = useState("");
  const [replacement, setReplacement] = useState("");
  const [overrideEnabled, setOverrideEnabled] = useState(false);
  const [rightsDraft, setRightsDraft] = useState<Rights>(inheritedRights);
  const [rightsReviewer, setRightsReviewer] = useState("");
  const [rightsEvidenceRef, setRightsEvidenceRef] = useState("");
  const [rightsEvidenceSha256, setRightsEvidenceSha256] = useState("");
  const [rightsExpiresAt, setRightsExpiresAt] = useState(defaultExpiryInput());
  const [rightsModes, setRightsModes] = useState<ApprovalMode[]>([]);
  const [verifierReviewer, setVerifierReviewer] = useState("");
  const [verifierEvidenceRef, setVerifierEvidenceRef] = useState("");

  useEffect(() => {
    setNote(entry?.review.note ?? "");
    setReplacement(entry?.review.redaction_replacement ?? "[REDACTED BY REVIEWER]");
    setOverrideEnabled(entry?.review.rights_override !== null && entry?.review.rights_override !== undefined);
    setRightsDraft(entry?.review.rights_override ?? inheritedRights);
    setRightsReviewer(entry?.review.rights_attestation?.reviewer ?? "");
    setRightsEvidenceRef(entry?.review.rights_attestation?.evidence_ref ?? "");
    setRightsEvidenceSha256(entry?.review.rights_attestation?.evidence_sha256 ?? "");
    setRightsExpiresAt(toDateTimeInput(entry?.review.rights_attestation?.expires_at) ?? defaultExpiryInput());
    setRightsModes(entry?.review.rights_attestation?.scopes.map(({ mode }) => mode) ?? []);
    setVerifierReviewer(entry?.review.verifier_confirmation?.reviewer ?? "");
    setVerifierEvidenceRef(entry?.review.verifier_confirmation?.evidence_ref ?? "");
  }, [entry, inheritedRights]);

  if (!entry) {
    return (
      <aside className="inspector panel inspector--empty" aria-label="事件检查器">
        <span className="empty-glyph" aria-hidden="true">⌁</span>
        <h3>选择一个事件</h3>
        <p>在时间线中选择事件，查看全部原始字段、遮盖设置与逐事件权利覆盖。</p>
      </aside>
    );
  }

  const { event, review } = entry;

  function saveReview(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSaveReview({
      note: note.trim() || null,
      redaction_replacement: review.disposition === "redact" ? replacement.trim() || "[REDACTED BY REVIEWER]" : null,
    });
  }

  function saveRights(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!overrideEnabled) {
      onSaveRights({ rights_override: null });
      return;
    }
    onSaveRights({
      rights_override: rightsDraft,
      modes: rightsModes,
      reviewer: rightsReviewer.trim(),
      evidence_ref: rightsEvidenceRef.trim(),
      evidence_sha256: rightsEvidenceSha256.trim().toLowerCase(),
      expires_at: new Date(rightsExpiresAt).toISOString(),
    });
  }

  function saveVerifier(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSaveVerifier({
      confirmation: {
        reviewer: verifierReviewer.trim(),
        evidence_ref: verifierEvidenceRef.trim(),
      },
    });
  }

  const verifier = verifierEvidenceSchema.safeParse(event.metadata.verifier);
  const reward = typeof event.metadata.reward === "number" && Number.isFinite(event.metadata.reward)
    ? event.metadata.reward
    : null;
  const verifierCandidate = verifier.success && reward !== null && ["evaluation", "feedback"].includes(event.event_type)
    ? { verifier: verifier.data, reward }
    : null;
  const rightsScopeOptions = ([
    "training_noncompetitive",
    "training_competitive_distillation",
    "redistribution",
  ] as const).map((mode) => ({ mode, decision: eligibility[mode] }));

  return (
    <aside className="inspector panel" aria-label={`事件 ${event.sequence} 检查器`}>
      <header className="inspector__header">
        <div>
          <p className="eyebrow">EVENT INSPECTOR</p>
          <h3>#{String(event.sequence).padStart(2, "0")} {humanize(event.event_type)}</h3>
        </div>
        <StatusBadge status={review.disposition} label={review.disposition === "include" ? "保留" : review.disposition === "redact" ? "遮盖" : "排除"} />
      </header>

      <dl className="fact-grid">
        <div><dt>Actor</dt><dd>{event.actor}</dd></div>
        <div><dt>Status</dt><dd>{event.status}</dd></div>
        <div><dt>Span</dt><dd title={event.span_id}>{shortId(event.span_id, 10)}</dd></div>
        <div><dt>Started</dt><dd>{formatDateTime(event.started_at)}</dd></div>
      </dl>

      <section className="inspector-section" aria-labelledby="event-content-heading">
        <div className="section-heading">
          <h4 id="event-content-heading">内容</h4>
          <span>{event.content.length} parts</span>
        </div>
        <div className="content-parts">
          {event.content.map((part) => (
            <article className="content-part" key={`${part.ordinal}-${part.sha256}`}>
              <header>
                <span>{humanize(part.type)}</span>
                <span>{part.mime_type}</span>
                <StatusBadge status={part.redaction_status} label={humanize(part.redaction_status)} />
              </header>
              <SafeText value={part.value ?? `[encrypted blob: ${part.blob_ref ?? "unavailable"}]`} label={`内容片段 ${part.ordinal}`} />
              <footer>
                <span>{part.sensitivity}</span>
                <code title={part.sha256}>sha256:{shortId(part.sha256, 10)}</code>
              </footer>
            </article>
          ))}
        </div>
      </section>

      {event.tool && (
        <details className="raw-details">
          <summary>工具字段（纯文本）</summary>
          <SafeText value={event.tool} label="工具字段 JSON" />
        </details>
      )}

      <details className="raw-details">
        <summary>完整规范化事件（纯文本）</summary>
        <SafeText value={event} label="完整事件 JSON" />
      </details>

      <form className="inspector-form" onSubmit={saveReview}>
        <div className="section-heading">
          <h4>审阅备注</h4>
          <span>不会改写 raw</span>
        </div>
        <label>
          <span>处置理由或审阅说明</span>
          <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} placeholder="记录为什么保留、排除或遮盖此事件" />
        </label>
        {review.disposition === "redact" && (
          <label>
            <span>导出替代文本</span>
            <textarea value={replacement} onChange={(event) => setReplacement(event.target.value)} rows={2} />
            <small>原文继续留在加密 raw vault；导出视图只出现替代文本。</small>
          </label>
        )}
        <button className="button button--secondary button--full" disabled={busy} type="submit">
          {busy ? "保存中…" : "保存事件审阅"}
        </button>
      </form>

      <form className="inspector-form rights-form" onSubmit={saveRights}>
        <div className="section-heading">
          <h4>逐事件权利</h4>
          <StatusBadge status={overrideEnabled ? "warning" : "neutral"} label={overrideEnabled ? "覆盖" : "继承"} />
        </div>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={overrideEnabled}
            onChange={(event) => {
              setOverrideEnabled(event.target.checked);
              if (event.target.checked && rightsModes.length === 0) {
                setRightsModes(rightsScopeOptions.filter(({ decision }) => decision.status === "allow").map(({ mode }) => mode));
              }
            }}
          />
          <span>覆盖 manifest 的默认权利</span>
        </label>
        <fieldset disabled={!overrideEnabled || busy}>
          <label>
            <span>SPDX / 许可表达式</span>
            <input
              value={rightsDraft.source_license_expression}
              onChange={(event) => setRightsDraft((current) => ({ ...current, source_license_expression: event.target.value }))}
              required
            />
          </label>
          <label>
            <span>输入权利依据</span>
            <select
              value={rightsDraft.input_rights_basis}
              onChange={(event) => setRightsDraft((current) => ({ ...current, input_rights_basis: event.target.value as Rights["input_rights_basis"] }))}
            >
              <option value="owned">owned</option>
              <option value="licensed">licensed</option>
              <option value="consented">consented</option>
              <option value="public_domain">public domain</option>
              <option value="unknown">unknown</option>
            </select>
          </label>
          <label>
            <span>第三方内容</span>
            <select
              value={rightsDraft.third_party_content}
              onChange={(event) => setRightsDraft((current) => ({ ...current, third_party_content: event.target.value as Rights["third_party_content"] }))}
            >
              <option value="none">none</option>
              <option value="present">present</option>
              <option value="unknown">unknown</option>
            </select>
          </label>
          <label>
            <span>权利人</span>
            <input
              value={rightsDraft.rights_holder ?? ""}
              onChange={(event) => setRightsDraft((current) => ({ ...current, rights_holder: event.target.value || null }))}
            />
          </label>
          <label>
            <span>审阅者标识</span>
            <input value={rightsReviewer} onChange={(event) => setRightsReviewer(event.target.value)} required />
          </label>
          <label>
            <span>权利证据引用</span>
            <input value={rightsEvidenceRef} onChange={(event) => setRightsEvidenceRef(event.target.value)} required placeholder="contract://owned-repo/section-4" />
          </label>
          <label>
            <span>权利证据 SHA-256</span>
            <input
              value={rightsEvidenceSha256}
              onChange={(event) => setRightsEvidenceSha256(event.target.value)}
              required
              pattern="[a-fA-F0-9]{64}"
              spellCheck={false}
            />
          </label>
          <label>
            <span>权利断言失效时间</span>
            <input type="datetime-local" value={rightsExpiresAt} onChange={(event) => setRightsExpiresAt(event.target.value)} required />
          </label>
          <fieldset className="scope-fieldset">
            <legend>用途与目标范围</legend>
            {rightsScopeOptions.map(({ mode, decision }) => (
              <label className="toggle-row" key={mode}>
                <input
                  type="checkbox"
                  checked={rightsModes.includes(mode)}
                  onChange={(event) => setRightsModes((current) => event.target.checked
                    ? [...new Set([...current, mode])]
                    : current.filter((candidate) => candidate !== mode))}
                />
                <span>{humanize(mode)} → {decision.target_model_owner ?? "无目标"}/{decision.target_product ?? "无产品"}</span>
              </label>
            ))}
          </fieldset>
        </fieldset>
        {overrideEnabled && rightsModes.length === 0 && <small>至少选择一个用途/目标范围。</small>}
        <button className="button button--secondary button--full" disabled={busy || (overrideEnabled && rightsModes.length === 0)} type="submit">
          {busy ? "保存中…" : overrideEnabled ? "保存权利覆盖" : "恢复继承权利"}
        </button>
      </form>

      {verifierCandidate && (
        <form className="inspector-form verifier-form" onSubmit={saveVerifier}>
          <div className="section-heading">
            <h4>Verifier 标签确认</h4>
            <StatusBadge
              status={review.verifier_confirmation ? "passed" : "warning"}
              label={review.verifier_confirmation ? "已确认" : "未确认"}
            />
          </div>
          <SafeText value={verifierCandidate} label="Verifier 候选证据" />
          <label>
            <span>审阅者标识</span>
            <input value={verifierReviewer} onChange={(event) => setVerifierReviewer(event.target.value)} required />
          </label>
          <label>
            <span>Verifier 证据引用</span>
            <input value={verifierEvidenceRef} onChange={(event) => setVerifierEvidenceRef(event.target.value)} required placeholder="ci://run/12345" />
          </label>
          <button className="button button--secondary button--full" disabled={busy} type="submit">
            {busy ? "保存中…" : review.verifier_confirmation ? "重新确认 Verifier" : "确认 Verifier 结果"}
          </button>
          {review.verifier_confirmation && (
            <button
              className="button button--ghost button--full"
              disabled={busy}
              type="button"
              onClick={() => onSaveVerifier({ confirmation: null })}
            >
              撤销 Verifier 确认
            </button>
          )}
        </form>
      )}
    </aside>
  );
}

function defaultExpiryInput(): string {
  const expires = new Date(Date.now() + 90 * 24 * 60 * 60 * 1_000);
  return localDateTimeInput(expires);
}

function toDateTimeInput(value: string | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return localDateTimeInput(new Date(value));
}

function localDateTimeInput(value: Date): string {
  return new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
