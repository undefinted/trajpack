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
  if (milliseconds === null || !Number.isFinite(milliseconds) || milliseconds < 0) return "—";
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
  // The wire format may omit zod-defaulted fields on older servers; treat a
  // missing array as empty rather than crashing the whole review page.
  const content = event.content ?? [];
  const values = content
    .map((part) => part.value)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (values.length > 0) return values.join("\n");
  if (event.tool?.arguments !== null && event.tool?.arguments !== undefined) {
    return safeStringify(event.tool.arguments, false);
  }
  return "（此事件没有内联文本；内容可能位于加密 blob 中）";
}

export function safeStringify(value: unknown, pretty = true): string {
  try {
    // Track only the objects on the current serialization branch so a shared
    // (non-circular) reference is serialized fully instead of being reported
    // as circular the second time it appears.
    const ancestors = new Set<object>();
    const visit = (entry: unknown): unknown => {
      if (entry === null || typeof entry !== "object") return entry;
      if (ancestors.has(entry)) return "[Circular]";
      ancestors.add(entry);
      const result = Array.isArray(entry)
        ? entry.map(visit)
        : Object.fromEntries(
          Object.entries(entry as Record<string, unknown>).map(([key, child]) => [key, visit(child)]),
        );
      ancestors.delete(entry);
      return result;
    };
    const result = JSON.stringify(visit(value), null, pretty ? 2 : 0);
    return result ?? String(value);
  } catch {
    return "[Unserializable value]";
  }
}

export function humanize(value: string): string {
  return value.replaceAll("_", " ").replaceAll(".", " · ");
}
