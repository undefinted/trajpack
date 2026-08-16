import type { ReactNode } from "react";

type StatusTone = "positive" | "negative" | "warning" | "neutral" | "accent";

const toneMap: Record<string, StatusTone> = {
  passed: "positive",
  approved: "positive",
  allow: "positive",
  unlocked: "positive",
  ok: "positive",
  failed: "negative",
  rejected: "negative",
  deny: "negative",
  error: "negative",
  warning: "warning",
  partial: "warning",
  pending: "neutral",
  unknown: "neutral",
  locked: "neutral",
  cancelled: "neutral",
  include: "accent",
  redact: "warning",
  exclude: "neutral",
};

interface StatusBadgeProps {
  status: string;
  label?: string;
}

export function StatusBadge({ status, label = status }: StatusBadgeProps): ReactNode {
  return <span className={`status-badge status-badge--${toneMap[status] ?? "neutral"}`}>{label}</span>;
}
