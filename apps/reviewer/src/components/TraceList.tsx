import { useMemo, useState, type ReactNode } from "react";
import type { TraceSummary } from "../api/types.js";
import { formatDateTime, shortId } from "../format.js";
import { StatusBadge } from "./StatusBadge.js";

interface TraceListProps {
  traces: TraceSummary[];
  selectedId: string | null;
  onSelect: (traceId: string) => void;
  busy?: boolean;
}

type Filter = "all" | "pending" | "blocked" | "approved" | "rejected";

const filters: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "pending", label: "待审" },
  { value: "blocked", label: "阻断" },
  { value: "approved", label: "已批准" },
  { value: "rejected", label: "已拒绝" },
];

export function TraceList({ traces, selectedId, onSelect, busy = false }: TraceListProps): ReactNode {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return traces.filter((trace) => {
      const matchesQuery = !normalized || [
        trace.trace_id,
        trace.source.host,
        trace.source.provider,
        trace.source.model_id ?? "",
        trace.source.product,
      ].some((value) => value.toLowerCase().includes(normalized));
      const matchesFilter = filter === "all" ||
        (filter === "pending" && trace.human_approval === "pending" && trace.blocker_count === 0) ||
        (filter === "blocked" && trace.blocker_count > 0) ||
        (filter === "approved" && trace.human_approval === "approved") ||
        (filter === "rejected" && trace.human_approval === "rejected");
      return matchesQuery && matchesFilter;
    });
  }, [filter, query, traces]);

  return (
    <aside className="trace-rail" aria-label="轨迹列表">
      <div className="trace-rail__header">
        <div>
          <p className="eyebrow">REVIEW QUEUE</p>
          <h2>审阅队列</h2>
        </div>
        <span className="count-bubble" aria-label={`${traces.length} 条轨迹`}>{traces.length}</span>
      </div>

      <label className="search-field">
        <span className="visually-hidden">搜索轨迹</span>
        <span aria-hidden="true">⌕</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索模型、来源或 ID"
          type="search"
        />
      </label>

      <div className="filter-row" aria-label="轨迹筛选">
        {filters.map((entry) => (
          <button
            className={filter === entry.value ? "filter-chip filter-chip--active" : "filter-chip"}
            key={entry.value}
            onClick={() => setFilter(entry.value)}
            type="button"
            aria-pressed={filter === entry.value}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="trace-list" aria-busy={busy}>
        {visible.map((trace) => {
          const blocked = trace.blocker_count > 0;
          return (
            <button
              className={selectedId === trace.trace_id ? "trace-card trace-card--selected" : "trace-card"}
              key={trace.trace_id}
              onClick={() => onSelect(trace.trace_id)}
              type="button"
              aria-current={selectedId === trace.trace_id ? "true" : undefined}
            >
              <span className="trace-card__topline">
                <span className="source-mark" aria-hidden="true">{trace.source.host.slice(0, 1).toUpperCase()}</span>
                <span className="trace-card__source">{trace.source.product}</span>
                <StatusBadge
                  status={blocked ? "failed" : trace.human_approval}
                  label={blocked ? "阻断" : trace.human_approval === "approved" ? "已批准" : trace.human_approval === "rejected" ? "已拒绝" : "待审"}
                />
              </span>
              <strong>{trace.source.model_id ?? "未知模型"}</strong>
              <span className="trace-card__meta">
                <code>{shortId(trace.trace_id)}</code>
                <span>{formatDateTime(trace.created_at)}</span>
              </span>
              <span className="trace-card__counts">
                <span>{trace.event_count} events</span>
                {trace.warning_count > 0 && <span className="text-warning">{trace.warning_count} warning</span>}
                {blocked && <span className="text-danger">{trace.blocker_count} blocker</span>}
              </span>
            </button>
          );
        })}
        {visible.length === 0 && (
          <div className="empty-small">
            <span aria-hidden="true">◇</span>
            <p>没有匹配的轨迹</p>
          </div>
        )}
      </div>
    </aside>
  );
}
