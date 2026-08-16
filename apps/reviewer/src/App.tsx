import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { ApprovalMode } from "@trajpack/schema";
import type {
  EventDisposition,
  EventRightsPatch,
  EventVerifierPatch,
  ExportFormat,
  ExportPreview,
  ExportReceipt,
  ReviewApi,
  ReviewerBootstrap,
  TraceDetail,
  TraceSummary,
} from "./api/types.js";
import { DecisionDialog, ExportDialog } from "./components/Dialogs.js";
import { EventInspector } from "./components/EventInspector.js";
import { EventTimeline } from "./components/EventTimeline.js";
import { SafeText } from "./components/SafeText.js";
import { StatusBadge } from "./components/StatusBadge.js";
import { SummaryPanels } from "./components/SummaryPanels.js";
import { TraceList } from "./components/TraceList.js";
import { formatDateTime, formatDuration, humanize, shortId } from "./format.js";

interface AppProps {
  api: ReviewApi;
}

type DetailView = "timeline" | "manifest";
type DecisionMode = "approved" | "rejected";

export function App({ api }: AppProps): ReactNode {
  const [bootstrap, setBootstrap] = useState<ReviewerBootstrap | null>(null);
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [view, setView] = useState<DetailView>("timeline");
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busyEventId, setBusyEventId] = useState<string | null>(null);
  const [decisionMode, setDecisionMode] = useState<DecisionMode | null>(null);
  const [decisionBusy, setDecisionBusy] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([api.bootstrap(), api.listTraces()])
      .then(([nextBootstrap, nextTraces]) => {
        if (!active) return;
        setBootstrap(nextBootstrap);
        setTraces(nextTraces);
        setSelectedTraceId((current) => current ?? nextTraces.at(0)?.trace_id ?? null);
      })
      .catch((reason: unknown) => active && setError(errorMessage(reason)))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [api]);

  useEffect(() => {
    if (!selectedTraceId) {
      setDetail(null);
      return;
    }
    let active = true;
    setDetailLoading(true);
    setError(null);
    void api.getTrace(selectedTraceId)
      .then((next) => {
        if (!active) return;
        setDetail(next);
        setSelectedEventId((current) => next.events.some(({ event }) => event.event_id === current)
          ? current
          : next.events.at(0)?.event.event_id ?? null);
      })
      .catch((reason: unknown) => active && setError(errorMessage(reason)))
      .finally(() => active && setDetailLoading(false));
    return () => { active = false; };
  }, [api, selectedTraceId]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 5_000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const selectedEvent = useMemo(
    () => detail?.events.find(({ event }) => event.event_id === selectedEventId) ?? null,
    [detail, selectedEventId],
  );

  const commitDetail = useCallback(async (next: TraceDetail, message?: string) => {
    setDetail(next);
    const nextTraces = await api.listTraces();
    setTraces(nextTraces);
    if (message) setToast(message);
  }, [api]);

  const handleDisposition = useCallback(async (eventId: string, disposition: EventDisposition) => {
    if (!detail || busyEventId) return;
    setBusyEventId(eventId);
    setError(null);
    try {
      const next = await api.updateEvent(detail.manifest.trace_id, eventId, {
        expected_revision: detail.revision,
        disposition,
        ...(disposition === "redact" ? { redaction_replacement: "[REDACTED BY REVIEWER]" } : {}),
      });
      await commitDetail(next, disposition === "include" ? "事件已保留" : disposition === "exclude" ? "事件已从训练视图排除" : "事件将在导出时遮盖");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyEventId(null);
    }
  }, [api, busyEventId, commitDetail, detail]);

  const handleSaveReview = useCallback(async (patch: { note?: string | null; redaction_replacement?: string | null }) => {
    if (!detail || !selectedEvent || busyEventId) return;
    const eventId = selectedEvent.event.event_id;
    setBusyEventId(eventId);
    setError(null);
    try {
      const next = await api.updateEvent(detail.manifest.trace_id, eventId, {
        expected_revision: detail.revision,
        ...patch,
      });
      await commitDetail(next, "事件审阅已保存");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyEventId(null);
    }
  }, [api, busyEventId, commitDetail, detail, selectedEvent]);

  const handleSaveRights = useCallback(async (patch: Omit<EventRightsPatch, "expected_revision">) => {
    if (!detail || !selectedEvent || busyEventId) return;
    const eventId = selectedEvent.event.event_id;
    setBusyEventId(eventId);
    setError(null);
    try {
      const next = await api.updateEventRights(detail.manifest.trace_id, eventId, {
        expected_revision: detail.revision,
        ...patch,
      });
      await commitDetail(next, patch.rights_override ? "带证据的逐事件权利覆盖已保存" : "事件已恢复继承 manifest 权利");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyEventId(null);
    }
  }, [api, busyEventId, commitDetail, detail, selectedEvent]);

  const handleSaveVerifier = useCallback(async (patch: Omit<EventVerifierPatch, "expected_revision">) => {
    if (!detail || !selectedEvent || busyEventId) return;
    const eventId = selectedEvent.event.event_id;
    setBusyEventId(eventId);
    setError(null);
    try {
      const next = await api.updateEventVerifier(detail.manifest.trace_id, eventId, {
        expected_revision: detail.revision,
        ...patch,
      });
      await commitDetail(next, patch.confirmation ? "Verifier 结果已由本地审阅者确认" : "Verifier 确认已撤销");
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyEventId(null);
    }
  }, [api, busyEventId, commitDetail, detail, selectedEvent]);

  const handleDecision = useCallback(async (reviewer: string, notes: string, approvedModes: ApprovalMode[]) => {
    if (!detail || !decisionMode) return;
    setDecisionBusy(true);
    setError(null);
    try {
      const next = await api.decideTrace(detail.manifest.trace_id, {
        expected_revision: detail.revision,
        decision: decisionMode,
        reviewer,
        notes,
        approved_modes: approvedModes,
      });
      await commitDetail(next, decisionMode === "approved" ? "轨迹已批准，可执行训练导出预检" : "轨迹已拒绝");
      setDecisionMode(null);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setDecisionBusy(false);
    }
  }, [api, commitDetail, decisionMode, detail]);

  const handlePreviewExport = useCallback((format: ExportFormat, mode: ApprovalMode): Promise<ExportPreview> => {
    if (!detail) return Promise.reject(new Error("没有选中的轨迹"));
    return api.previewExport(detail.manifest.trace_id, { expected_revision: detail.revision, format, mode });
  }, [api, detail]);

  const handleExport = useCallback((format: ExportFormat, mode: ApprovalMode, confirmation: ExportPreview["confirmation_phrase"]): Promise<ExportReceipt> => {
    if (!detail) return Promise.reject(new Error("没有选中的轨迹"));
    return api.exportTrace(detail.manifest.trace_id, {
      expected_revision: detail.revision,
      format,
      mode,
      confirmation_phrase: confirmation,
    });
  }, [api, detail]);

  function focusEvent(eventId: string): void {
    setView("timeline");
    setSelectedEventId(eventId);
    window.requestAnimationFrame(() => {
      document.querySelector(`[data-event-id="${CSS.escape(eventId)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  const blockerCount = detail?.checks.filter(({ status }) => status === "failed").length ?? 0;
  const currentApproval = detail?.manifest.review.human_approval ?? "pending";
  const eligibleApprovalModes: ApprovalMode[] = detail ? [
    ...(detail.manifest.eligibility.local_archive.status === "allow" ? ["archive" as const] : []),
    ...(detail.manifest.eligibility.training_noncompetitive.status === "allow" ? ["training_noncompetitive" as const] : []),
    ...(detail.manifest.eligibility.training_competitive_distillation.status === "allow" ? ["training_competitive_distillation" as const] : []),
    ...(detail.manifest.eligibility.redistribution.status === "allow" ? ["redistribution" as const] : []),
  ] : [];

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <div>
            <strong>trajpack</strong>
            <span>本地轨迹审阅器</span>
          </div>
        </div>
        <div className="header-notice">
          <span className="pulse-dot" aria-hidden="true" />
          <span>所有内容留在此设备</span>
        </div>
        <div className="vault-state">
          <span aria-hidden="true">▣</span>
          <div>
            <small>ENCRYPTED VAULT</small>
            <strong>{bootstrap?.vault.state === "unlocked" ? "已解锁" : bootstrap ? "已锁定" : "连接中"}</strong>
          </div>
          <StatusBadge status={bootstrap?.vault.state ?? "pending"} label={bootstrap?.vault.state === "unlocked" ? "LOCAL" : "LOCKED"} />
        </div>
      </header>

      <div className="app-body">
        <TraceList traces={traces} selectedId={selectedTraceId} onSelect={setSelectedTraceId} busy={loading} />

        <main className="review-main">
          {error && (
            <div className="global-error" role="alert">
              <span aria-hidden="true">!</span>
              <p><strong>操作未完成</strong>{error}</p>
              <button type="button" onClick={() => setError(null)} aria-label="关闭错误">×</button>
            </div>
          )}

          {(loading || detailLoading) && !detail && <LoadingState />}
          {!loading && !detailLoading && !detail && <EmptyState />}

          {detail && (
            <>
              <section className="trace-hero" aria-labelledby="trace-title">
                <div className="trace-hero__main">
                  <span className="source-logo" aria-hidden="true">{detail.manifest.source.host.slice(0, 1).toUpperCase()}</span>
                  <div>
                    <p className="breadcrumbs">
                      {humanize(detail.manifest.source.host)} <span>/</span> <code>{shortId(detail.manifest.trace_id, 12)}</code>
                    </p>
                    <h1 id="trace-title">{detail.manifest.source.model_id ?? "未知模型"}</h1>
                    <p className="trace-subtitle">
                      {detail.manifest.source.product} · {detail.manifest.source.capture_method} · fidelity {detail.manifest.source.fidelity}
                    </p>
                  </div>
                </div>
                <div className="trace-hero__facts">
                  <div><span>创建</span><strong>{formatDateTime(detail.manifest.created_at)}</strong></div>
                  <div><span>事件</span><strong>{detail.events.length}</strong></div>
                  <div><span>时长</span><strong>{formatDuration(durationOf(detail))}</strong></div>
                  <div><span>Revision</span><strong>{detail.revision}</strong></div>
                </div>
                <div className="trace-actions">
                  <StatusBadge
                    status={currentApproval}
                    label={currentApproval === "approved" ? "已批准" : currentApproval === "rejected" ? "已拒绝" : "待人工审阅"}
                  />
                  <button className="button button--ghost" type="button" onClick={() => setDecisionMode("rejected")} disabled={decisionBusy}>拒绝</button>
                  <button
                    className="button button--secondary"
                    type="button"
                    onClick={() => setExportOpen(true)}
                    title="先执行 policy 与明文边界预检"
                  >
                    导出预检
                  </button>
                  <button
                    className="button button--primary"
                    type="button"
                    onClick={() => setDecisionMode("approved")}
                    disabled={blockerCount > 0 || decisionBusy || currentApproval === "approved"}
                    title={blockerCount > 0 ? `${blockerCount} 个自动检查阻断批准` : undefined}
                  >
                    {currentApproval === "approved" ? "已批准" : "批准轨迹"}
                  </button>
                </div>
              </section>

              <SummaryPanels detail={detail} onFocusEvent={focusEvent} />

              <div className="view-tabs" role="tablist" aria-label="轨迹视图">
                <button type="button" role="tab" aria-selected={view === "timeline"} className={view === "timeline" ? "view-tab view-tab--active" : "view-tab"} onClick={() => setView("timeline")}>事件审阅</button>
                <button type="button" role="tab" aria-selected={view === "manifest"} className={view === "manifest" ? "view-tab view-tab--active" : "view-tab"} onClick={() => setView("manifest")}>Manifest 原文</button>
              </div>

              {view === "timeline" ? (
                <div className="review-workspace">
                  <EventTimeline
                    events={detail.events}
                    selectedEventId={selectedEventId}
                    busyEventId={busyEventId}
                    onSelect={setSelectedEventId}
                    onDisposition={(eventId, disposition) => void handleDisposition(eventId, disposition)}
                  />
                  <EventInspector
                    entry={selectedEvent}
                    inheritedRights={detail.manifest.rights}
                    eligibility={detail.manifest.eligibility}
                    busy={busyEventId !== null}
                    onSaveReview={(patch) => void handleSaveReview(patch)}
                    onSaveRights={(patch) => void handleSaveRights(patch)}
                    onSaveVerifier={(patch) => void handleSaveVerifier(patch)}
                  />
                </div>
              ) : (
                <section className="panel manifest-view" role="tabpanel" aria-labelledby="manifest-heading">
                  <header className="panel__header">
                    <div>
                      <p className="eyebrow">UNTRUSTED PLAIN TEXT</p>
                      <h3 id="manifest-heading">完整 TraceManifest</h3>
                    </div>
                    <span className="manifest-version">{detail.manifest.schema_version}</span>
                  </header>
                  <div className="callout callout--neutral">
                    此处不会解析 HTML、Markdown 或可执行链接；provider 内容只作为文本节点显示。
                  </div>
                  <SafeText value={detail.manifest} label="完整 manifest JSON" />
                </section>
              )}
            </>
          )}
        </main>
      </div>

      {detail && decisionMode && (
        <DecisionDialog
          open
          mode={decisionMode}
          blockerCount={blockerCount}
          busy={decisionBusy}
          eligibleModes={eligibleApprovalModes}
          onClose={() => setDecisionMode(null)}
          onConfirm={(reviewer, notes, approvedModes) => void handleDecision(reviewer, notes, approvedModes)}
        />
      )}

      {detail && (
        <ExportDialog
          open={exportOpen}
          onClose={() => setExportOpen(false)}
          onPreview={handlePreviewExport}
          onExport={handleExport}
          onComplete={(receipt) => setToast(`明文已导出至 ${receipt.destination}`)}
        />
      )}

      {toast && <div className="toast" role="status"><span aria-hidden="true">✓</span>{toast}</div>}
    </div>
  );
}

function durationOf(detail: TraceDetail): number | null {
  const started = detail.events.at(0)?.event.started_at;
  const ended = detail.events.at(-1)?.event.ended_at;
  return started && ended ? Date.parse(ended) - Date.parse(started) : null;
}

function LoadingState(): ReactNode {
  return (
    <div className="page-state" aria-label="加载审阅队列">
      <span className="spinner spinner--large" />
      <h2>正在打开加密 vault</h2>
      <p>读取 manifest 与规范化事件索引…</p>
    </div>
  );
}

function EmptyState(): ReactNode {
  return (
    <div className="page-state">
      <span className="empty-glyph" aria-hidden="true">◇</span>
      <h2>审阅队列为空</h2>
      <p>运行 <code>trajpack capture</code> 或 <code>trajpack import</code> 后，待审轨迹会出现在这里。</p>
    </div>
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "未知错误";
}
