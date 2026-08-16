import type { TrajectoryEvent } from "@trajpack/schema";

export function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(parsed);
}

export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) return "—";
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  return `${(milliseconds / 1_000).toFixed(milliseconds >= 10_000 ? 0 : 1)} s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

export function shortId(value: string, head = 8): string {
  return value.length <= head ? value : `${value.slice(0, head)}…`;
}

export function eventPreview(event: TrajectoryEvent): string {
  const values = event.content
    .map((part) => part.value)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (values.length > 0) return values.join("\n");
  if (event.tool?.arguments !== null && event.tool?.arguments !== undefined) {
    return safeStringify(event.tool.arguments, false);
  }
  return "（此事件没有内联文本；内容可能位于加密 blob 中）";
}

export function safeStringify(value: unknown, pretty = true): string {
  const seen = new WeakSet<object>();
  try {
    const result = JSON.stringify(
      value,
      (_key, nested) => {
        if (typeof nested === "object" && nested !== null) {
          if (seen.has(nested)) return "[Circular]";
          seen.add(nested);
        }
        return nested;
      },
      pretty ? 2 : 0,
    );
    return result ?? String(value);
  } catch {
    return "[Unserializable value]";
  }
}

export function humanize(value: string): string {
  return value.replaceAll("_", " ").replaceAll(".", " · ");
}
