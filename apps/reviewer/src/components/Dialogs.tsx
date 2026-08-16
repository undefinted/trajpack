import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { ApprovalMode } from "@trajpack/schema";
import type { ExportFormat, ExportPreview, ExportReceipt, ReviewDecision } from "../api/types.js";
import { formatBytes } from "../format.js";
import { StatusBadge } from "./StatusBadge.js";

interface DecisionDialogProps {
  open: boolean;
  mode: Exclude<ReviewDecision, "pending">;
  blockerCount: number;
  busy: boolean;
  eligibleModes: ApprovalMode[];
  onClose: () => void;
  onConfirm: (reviewer: string, notes: string, approvedModes: ApprovalMode[]) => void;
}

export function DecisionDialog({
  open,
  mode,
  blockerCount,
  busy,
  eligibleModes,
  onClose,
  onConfirm,
}: DecisionDialogProps): ReactNode {
  const [reviewer, setReviewer] = useState("");
  const [notes, setNotes] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [approvedModes, setApprovedModes] = useState<ApprovalMode[]>([]);
  const eligibleModeKey = eligibleModes.join("|");

  useEffect(() => {
    if (open) {
      setNotes("");
      setAcknowledged(false);
      // Purpose approval is never preselected. Archive, training, and
      // redistribution are materially different decisions and each requires
      // an explicit click in this dialog.
      setApprovedModes([]);
    }
  }, [open, mode, eligibleModeKey]);

  if (!open) return null;
  const approving = mode === "approved";
  const blocked = approving && blockerCount > 0;
  const ready = reviewer.trim().length > 0 && notes.trim().length > 0
    && (!approving || (acknowledged && approvedModes.length > 0)) && !blocked;

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (ready) onConfirm(reviewer.trim(), notes.trim(), approving ? approvedModes : []);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="decision-title">
        <header className="modal__header">
          <div className={approving ? "modal-symbol modal-symbol--approve" : "modal-symbol modal-symbol--reject"} aria-hidden="true">
            {approving ? "✓" : "×"}
          </div>
          <div>
            <p className="eyebrow">HUMAN GATE</p>
            <h2 id="decision-title">{approving ? "批准所选用途" : "拒绝这条轨迹"}</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} disabled={busy} aria-label="关闭">×</button>
        </header>

        {blocked && (
          <div className="callout callout--danger" role="alert">
            <strong>无法批准</strong>
            <p>仍有 {blockerCount} 个自动检查阻断。请先移除受影响事件或修正权利信息，并重新运行检查。</p>
          </div>
        )}

        <form className="modal-form" onSubmit={submit}>
          <label>
            <span>审阅者标识</span>
            <input value={reviewer} onChange={(event) => setReviewer(event.target.value)} placeholder="本地 reviewer ID（避免个人邮箱）" autoFocus />
          </label>
          <label>
            <span>{approving ? "批准依据" : "拒绝原因"}</span>
            <textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder={approving ? "记录本次审阅与用途选择的依据" : "拒绝原因将写入 lineage"}
              rows={4}
              required
            />
          </label>
          {approving && (
            <>
              <fieldset>
                <legend>批准用途（绑定当前内容、目标与 policy decision）</legend>
                {eligibleModes.map((approvalMode) => (
                  <label key={approvalMode}>
                    <input
                      type="checkbox"
                      checked={approvedModes.includes(approvalMode)}
                      onChange={(event) => setApprovedModes((current) => event.target.checked
                        ? [...new Set([...current, approvalMode])]
                        : current.filter((candidate) => candidate !== approvalMode))}
                    />
                    <span>{approvalMode}</span>
                  </label>
                ))}
              </fieldset>
              <label className="confirmation-box">
                <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
                <span>我已核对自动检查、逐事件处置、权利信息和上述用途；内容、目标或 decision 变化会使批准失效。</span>
              </label>
            </>
          )}
          <div className="modal__actions">
            <button className="button button--ghost" type="button" onClick={onClose} disabled={busy}>取消</button>
            <button
              className={approving ? "button button--primary" : "button button--danger"}
              type="submit"
              disabled={!ready || busy}
            >
              {busy ? "写入审阅记录…" : approving ? "确认批准" : "确认拒绝"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  onPreview: (format: ExportFormat, mode: ApprovalMode) => Promise<ExportPreview>;
  onExport: (format: ExportFormat, mode: ApprovalMode, confirmation: ExportPreview["confirmation_phrase"]) => Promise<ExportReceipt>;
  onComplete: (receipt: ExportReceipt) => void;
}

const formats: Array<{ value: ExportFormat; label: string; detail: string }> = [
  { value: "canonical", label: "Canonical", detail: "manifest + events + sidecars" },
  { value: "atif", label: "ATIF", detail: "agent trajectory interchange" },
  { value: "hf-trl", label: "HF / TRL", detail: "messages JSONL / Parquet view" },
  { value: "otlp", label: "OTLP", detail: "OpenTelemetry trace mapping" },
];

export function ExportDialog({ open, onClose, onPreview, onExport, onComplete }: ExportDialogProps): ReactNode {
  const [format, setFormat] = useState<ExportFormat>("canonical");
  const [mode, setMode] = useState<ApprovalMode>("archive");
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setPreview(null);
    setAcknowledged(false);
    setPhrase("");
    setError(null);
    void onPreview(format, mode)
      .then((result) => active && setPreview(result))
      .catch((reason: unknown) => active && setError(errorMessage(reason)))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [format, mode, onPreview, open]);

  if (!open) return null;

  const confirmed = preview !== null &&
    preview.export_allowed &&
    acknowledged &&
    phrase === preview.confirmation_phrase;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!preview || !confirmed) return;
    setLoading(true);
    setError(null);
    try {
      const receipt = await onExport(format, mode, preview.confirmation_phrase);
      onComplete(receipt);
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !loading && onClose()}>
      <section className="modal modal--wide" role="dialog" aria-modal="true" aria-labelledby="export-title">
        <header className="modal__header">
          <div className="modal-symbol modal-symbol--export" aria-hidden="true">⇧</div>
          <div>
            <p className="eyebrow">PLAINTEXT BOUNDARY</p>
            <h2 id="export-title">导出明文视图</h2>
          </div>
          <button className="icon-button" type="button" onClick={onClose} disabled={loading} aria-label="关闭">×</button>
        </header>

        <div className="callout callout--warning" role="alert">
          <strong>这是加密边界之外的明文副本</strong>
          <p>导出后 trajpack 无法自动撤回、删除或重新遮盖外部副本。请确认目标目录权限与数据集许可证。</p>
        </div>

        <form className="modal-form" onSubmit={(event) => void submit(event)}>
          <fieldset className="format-grid" disabled={loading}>
            <legend>导出格式</legend>
            {formats.map((entry) => (
              <label className={format === entry.value ? "format-card format-card--selected" : "format-card"} key={entry.value}>
                <input type="radio" name="format" value={entry.value} checked={format === entry.value} onChange={() => setFormat(entry.value)} />
                <strong>{entry.label}</strong>
                <span>{entry.detail}</span>
              </label>
            ))}
          </fieldset>

          <label>
            <span>Eligibility gate / 用途</span>
            <select value={mode} onChange={(event) => setMode(event.target.value as ApprovalMode)} disabled={loading}>
              <option value="archive">archive</option>
              <option value="training_noncompetitive">training_noncompetitive</option>
              <option value="training_competitive_distillation">training_competitive_distillation</option>
              <option value="redistribution">redistribution</option>
            </select>
          </label>

          {loading && !preview && <div className="loading-inline"><span className="spinner" />生成导出预检…</div>}
          {error && <div className="callout callout--danger" role="alert">{error}</div>}

          {preview && (
            <div className="export-preview">
              <header>
                <h3>预检结果</h3>
                <StatusBadge status={preview.export_allowed ? "allow" : "deny"} label={preview.export_allowed ? "允许导出" : "已阻断"} />
              </header>
              <dl>
                <div><dt>目标</dt><dd>{preview.destination_hint}</dd></div>
                <div><dt>用途</dt><dd>{preview.mode}</dd></div>
                <div><dt>样本</dt><dd>{preview.example_count}</dd></div>
                <div><dt>预计大小</dt><dd>{formatBytes(preview.plaintext_bytes_estimate)}</dd></div>
                <div><dt>排除事件</dt><dd>{preview.excluded_event_count}</dd></div>
                <div><dt>遮盖片段</dt><dd>{preview.redacted_part_count}</dd></div>
                <div><dt>许可</dt><dd>{preview.license_summary}</dd></div>
              </dl>
              {preview.block_reasons.map((reason) => <p className="text-danger" key={reason}>阻断：{reason}</p>)}
            </div>
          )}

          <label className="confirmation-box">
            <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} disabled={!preview?.export_allowed} />
            <span>我了解这是不可自动召回的明文文件，并已确认目标目录与许可证。</span>
          </label>
          <label>
            <span>输入 <code>EXPORT PLAINTEXT</code> 确认</span>
            <input value={phrase} onChange={(event) => setPhrase(event.target.value)} autoComplete="off" disabled={!preview?.export_allowed} />
          </label>

          <div className="modal__actions">
            <button className="button button--ghost" type="button" onClick={onClose} disabled={loading}>取消</button>
            <button className="button button--primary" type="submit" disabled={!confirmed || loading}>
              {loading ? "正在导出…" : "导出明文"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "操作失败";
}
