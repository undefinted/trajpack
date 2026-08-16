import type { ReactNode } from "react";
import { safeStringify } from "../format.js";

interface SafeTextProps {
  value: string | unknown;
  label?: string;
  compact?: boolean;
}

/** Renders provider-controlled data only as a React text node. */
export function SafeText({ value, label = "不可信内容", compact = false }: SafeTextProps): ReactNode {
  const text = typeof value === "string" ? value : safeStringify(value);
  return (
    <pre className={compact ? "safe-text safe-text--compact" : "safe-text"} aria-label={label}>
      {text}
    </pre>
  );
}
