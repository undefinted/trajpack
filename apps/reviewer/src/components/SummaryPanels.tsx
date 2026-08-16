import type { ReactNode } from "react";
import type { TraceDetail } from "../api/types.js";
import { humanize, shortId } from "../format.js";
import { StatusBadge } from "./StatusBadge.js";

interface SummaryPanelsProps {
  detail: TraceDetail;
  onFocusEvent: (eventId: string) => void;
}

const eligibilityLabels: Record<keyof TraceDetail["manifest"]["eligibility"], string> = {
  local_archive: "本地归档",
  automatic_capture: "自动采集",
  training_noncompetitive: "非竞争训练",
  training_competitive_distillation: "竞争性蒸馏",
  redistribution: "再分发",
};

export function SummaryPanels({ detail, onFocusEvent }: SummaryPanelsProps): ReactNode {
  const failed = detail.checks.filter(({ status }) => status === "failed").length;
  const warnings = detail.checks.filter(({ status }) => status === "warning").length;
  const metrics = detail.metrics;

  return (
    <div className="summary-grid">
      <section className="panel checks-panel" aria-labelledby="checks-heading">
        <header className="panel__header">
          <div>
            <p className="eyebrow">AUTOMATED GATES</p>
            <h3 id="checks-heading">自动检查</h3>
          </div>
          <div className="check-tally" aria-label={`${failed} 个阻断，${warnings} 个警告`}>
            {failed > 0 && <span className="tally tally--failed">{failed} 阻断</span>}
            {warnings > 0 && <span className="tally tally--warning">{warnings} 警告</span>}
            {failed === 0 && warnings === 0 && <span className="tally tally--passed">全部通过</span>}
          </div>
        </header>
        <div className="check-list">
          {detail.checks.map((check) => (
            <details className={`check-row check-row--${check.status}`} key={check.check_id} open={check.status === "failed"}>
              <summary>
                <span className="check-icon" aria-hidden="true">{check.status === "passed" ? "✓" : check.status === "warning" ? "!" : "×"}</span>
                <span className="check-row__label">
                  <strong>{check.label}</strong>
                  <small>{humanize(check.category)} · {check.scanner_version}</small>
                </span>
                <StatusBadge status={check.status} label={check.status === "passed" ? "通过" : check.status === "warning" ? "警告" : "失败"} />
              </summary>
              <div className="check-row__detail">
                <p>{check.summary}</p>
                {check.affected_event_ids.length > 0 && (
                  <div className="affected-events" aria-label="受影响事件">
                    {check.affected_event_ids.map((eventId) => (
                      <button key={eventId} type="button" onClick={() => onFocusEvent(eventId)}>
                        {shortId(eventId, 14)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </details>
          ))}
        </div>
      </section>

      <section className="panel eligibility-panel" aria-labelledby="eligibility-heading">
        <header className="panel__header">
          <div>
            <p className="eyebrow">POLICY ROUTER</p>
            <h3 id="eligibility-heading">用途资格</h3>
          </div>
          <span className="policy-version">policy/0.1</span>
        </header>
        <div className="eligibility-list">
          {(Object.entries(detail.manifest.eligibility) as Array<[
            keyof TraceDetail["manifest"]["eligibility"],
            TraceDetail["manifest"]["eligibility"][keyof TraceDetail["manifest"]["eligibility"]],
          ]>).map(([key, decision]) => (
            <div className="eligibility-row" key={key}>
              <span>{eligibilityLabels[key]}</span>
              <StatusBadge status={decision.status} label={decision.status === "allow" ? "允许" : decision.status === "deny" ? "拒绝" : "未知"} />
              <small title={decision.basis}>{decision.reason_codes.at(0) ?? "no-reason"}</small>
            </div>
          ))}
        </div>
      </section>

      <section className="metric-strip" aria-label="轨迹指标">
        <Metric label="输入 tokens" value={metrics.input_tokens.toLocaleString()} />
        <Metric label="输出 tokens" value={metrics.output_tokens.toLocaleString()} />
        <Metric label="工具调用" value={String(metrics.tool_calls)} />
        <Metric label="失败事件" value={String(metrics.failed_events)} {...(metrics.failed_events > 0 ? { tone: "warm" as const } : {})} />
        <Metric label="验证事件" value={String(metrics.verification_events)} />
        <Metric
          label="Targeted Observation"
          value={metrics.targeted_observation_ratio === null ? "—" : `${Math.round(metrics.targeted_observation_ratio * 100)}%`}
        />
      </section>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "warm" }): ReactNode {
  return (
    <div className={tone ? "metric metric--warm" : "metric"}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}
