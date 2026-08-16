import { useMemo, useState, type ReactNode } from "react";
import type { EventDisposition, ReviewEvent } from "../api/types.js";
import { eventPreview, formatDateTime, humanize } from "../format.js";
import { SafeText } from "./SafeText.js";
import { StatusBadge } from "./StatusBadge.js";

interface EventTimelineProps {
  events: ReviewEvent[];
  selectedEventId: string | null;
  busyEventId: string | null;
  onSelect: (eventId: string) => void;
  onDisposition: (eventId: string, disposition: EventDisposition) => void;
}

type EventFilter = "all" | "messages" | "tools" | "artifacts" | "issues";

export function EventTimeline({
  events,
  selectedEventId,
  busyEventId,
  onSelect,
  onDisposition,
}: EventTimelineProps): ReactNode {
  const [filter, setFilter] = useState<EventFilter>("all");
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return events.filter(({ event }) => {
      const matchesQuery = !normalized || [
        event.event_id,
        event.event_type,
        event.actor,
        eventPreview(event),
      ].some((value) => value.toLowerCase().includes(normalized));
      const matchesFilter = filter === "all" ||
        (filter === "messages" && ["message", "reasoning", "plan"].includes(event.event_type)) ||
        (filter === "tools" && event.event_type.startsWith("tool.")) ||
        (filter === "artifacts" && event.event_type.startsWith("artifact.")) ||
        (filter === "issues" && event.status !== "ok");
      return matchesQuery && matchesFilter;
    });
  }, [events, filter, query]);

  return (
    <section className="timeline panel" aria-labelledby="timeline-heading">
      <header className="timeline__header">
        <div>
          <p className="eyebrow">NORMALIZED EVENTS</p>
          <h3 id="timeline-heading">事件时间线</h3>
        </div>
        <span className="count-bubble">{visible.length}/{events.length}</span>
      </header>

      <div className="timeline-tools">
        <label className="search-field search-field--compact">
          <span className="visually-hidden">搜索事件</span>
          <span aria-hidden="true">⌕</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索事件内容" type="search" />
        </label>
        <select aria-label="筛选事件类型" value={filter} onChange={(event) => setFilter(event.target.value as EventFilter)}>
          <option value="all">全部事件</option>
          <option value="messages">消息与理由</option>
          <option value="tools">工具调用</option>
          <option value="artifacts">文件变更</option>
          <option value="issues">错误与中断</option>
        </select>
      </div>

      <div className="event-list">
        {visible.map(({ event, review }) => {
          const selected = selectedEventId === event.event_id;
          const busy = busyEventId === event.event_id;
          const reasoning = event.content.find((part) => part.reasoning !== null)?.reasoning;
          return (
            <article
              className={`${selected ? "event-card event-card--selected" : "event-card"} event-card--${review.disposition}`}
              data-event-id={event.event_id}
              key={event.event_id}
            >
              <span className="timeline-dot" aria-hidden="true" />
              <button className="event-card__select" type="button" onClick={() => onSelect(event.event_id)}>
                <span className="event-card__headline">
                  <span className="sequence">#{String(event.sequence).padStart(2, "0")}</span>
                  <strong>{humanize(event.event_type)}</strong>
                  <span className="actor">{event.actor}</span>
                  <StatusBadge status={event.status} label={event.status} />
                  <time dateTime={event.started_at}>{formatDateTime(event.started_at)}</time>
                </span>
                {reasoning && (
                  <span className="reasoning-label">
                    {humanize(reasoning.representation)} · {reasoning.visibility} · loss {reasoning.include_in_loss ? "on" : "off"}
                  </span>
                )}
                <SafeText value={eventPreview(event)} label={`事件 ${event.sequence} 内容`} compact />
              </button>
              <div className="disposition-controls" aria-label={`事件 ${event.sequence} 处置`}>
                <DispositionButton value="include" current={review.disposition} busy={busy} onClick={() => onDisposition(event.event_id, "include")} />
                <DispositionButton value="redact" current={review.disposition} busy={busy} onClick={() => onDisposition(event.event_id, "redact")} />
                <DispositionButton value="exclude" current={review.disposition} busy={busy} onClick={() => onDisposition(event.event_id, "exclude")} />
              </div>
            </article>
          );
        })}
        {visible.length === 0 && <div className="empty-small"><span aria-hidden="true">◇</span><p>没有匹配的事件</p></div>}
      </div>
    </section>
  );
}

function DispositionButton({
  value,
  current,
  busy,
  onClick,
}: {
  value: EventDisposition;
  current: EventDisposition;
  busy: boolean;
  onClick: () => void;
}): ReactNode {
  const label = value === "include" ? "保留" : value === "redact" ? "遮盖" : "排除";
  return (
    <button
      className={current === value ? `disposition disposition--${value} disposition--active` : `disposition disposition--${value}`}
      type="button"
      disabled={busy}
      aria-pressed={current === value}
      onClick={onClick}
    >
      {label}
    </button>
  );
}
