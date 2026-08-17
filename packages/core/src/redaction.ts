import type { ContentPart, TraceBundle } from "@trajpack/schema";
import { sha256 } from "./canonical.js";

export type FindingKind =
  | "api_key"
  | "authorization"
  | "private_key"
  | "cloud_credential"
  | "cookie"
  | "password"
  | "url_credential"
  | "email"
  | "phone"
  | "sensitive_path";

export interface RedactionFinding {
  kind: FindingKind;
  start: number;
  end: number;
  severity: "high" | "medium";
}

export interface StructuredRedactionFinding extends RedactionFinding {
  path: string;
}

const PATTERNS: Array<{ kind: FindingKind; severity: RedactionFinding["severity"]; expression: RegExp }> = [
  { kind: "private_key", severity: "high", expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { kind: "authorization", severity: "high", expression: /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi },
  { kind: "cookie", severity: "high", expression: /\b(?:Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi },
  { kind: "url_credential", severity: "high", expression: /\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/gi },
  { kind: "url_credential", severity: "high", expression: /\bhttps?:\/\/[^\s?#]+[^\s#]*[?&](?:access_?token|api_?key|token|key|signature|credential|x-amz-signature|x-amz-credential|sig|sas)=[^&#\s]+[^\s]*/gi },
  { kind: "cloud_credential", severity: "high", expression: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: "api_key", severity: "high", expression: /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g },
  { kind: "email", severity: "medium", expression: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { kind: "phone", severity: "medium", expression: /(?<!\d)(?:\+?\d[\d .()-]{7,}\d)(?!\d)/g },
  { kind: "sensitive_path", severity: "medium", expression: /(?:(?:[A-Za-z]:[\\/]Users[\\/])|\/(?:home|Users)\/)[^\\/\s]+/g },
  { kind: "sensitive_path", severity: "medium", expression: /(?:^|[\\/])(?:\.env|id_rsa|id_ed25519|credentials)(?:$|[.\\/\s])/gim },
  {
    kind: "password",
    severity: "high",
    expression: /^(?:export\s+)?(?:db[_-]?password|password|passwd|pwd)\s*[:=]\s*[^\s#;]{3,}.*$/gim,
  },
  {
    kind: "cloud_credential",
    severity: "high",
    expression: /^(?:export\s+)?(?:aws[_-]?secret[_-]?access[_-]?key|aws[_-]?access[_-]?key[_-]?id|google[_-]?(?:application[_-]?)?credentials|azure[_-]?(?:client[_-]?)?secret)\s*[:=]\s*[^\s#;]{4,}.*$/gim,
  },
  {
    kind: "api_key",
    severity: "high",
    expression: /^(?:export\s+)?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|session[_-]?token|auth[_-]?token|secret)\s*[:=]\s*[^\s#;]{4,}.*$/gim,
  },
];

function normalizedLeaf(path: string): string {
  const raw = /(?:^|\.)([^.[\]]+)$/.exec(path)?.[1] ?? "";
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function sensitiveKeyKind(path: string): FindingKind | null {
  const leaf = normalizedLeaf(path);
  if (["password", "passwd", "pwd", "db_password"].includes(leaf)) return "password";
  if (["authorization", "proxy_authorization"].includes(leaf)) return "authorization";
  if (["cookie", "set_cookie"].includes(leaf)) return "cookie";
  if (["private_key", "ssh_private_key"].includes(leaf)) return "private_key";
  if ([
    "aws_secret_access_key",
    "aws_access_key_id",
    "access_key_id",
    "google_application_credentials",
    "azure_client_secret",
    "cloud_credentials",
  ].includes(leaf)) return "cloud_credential";
  if ([
    "api_key",
    "access_token",
    "refresh_token",
    "client_secret",
    "session_token",
    "auth_token",
    "bearer_token",
    "token",
    "secret",
    "env",
  ].includes(leaf)) return "api_key";
  return null;
}

function alreadyRedacted(value: unknown): boolean {
  return typeof value === "string" && /^\[REDACTED:[a-z_]+\]$/.test(value);
}

/**
 * Content-addresses and integrity keys are deliberate lineage. A random
 * hexadecimal digest can accidentally match the phone detector, so exempt
 * only an exact lowercase SHA-256 value under a narrowly named digest key.
 * Invalid or non-digest values continue through the privacy scanner.
 */
export function isSafeIntegrityDigest(path: string, value: unknown): boolean {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) return false;
  const leaf = normalizedLeaf(path);
  return leaf === "dedupe_key" || leaf === "sha256" || leaf.endsWith("_sha256");
}

function structuredStringFindings(value: string, path: string): StructuredRedactionFinding[] {
  const findings = scanText(value).map((finding) => ({ ...finding, path }));
  if (alreadyRedacted(value)) return [];
  const kind = sensitiveKeyKind(path);
  if (kind && value.length > 0 && !findings.some((finding) => finding.kind === kind)) {
    findings.push({ kind, start: 0, end: value.length, severity: "high", path });
  }
  return findings;
}

export function scanText(value: string): RedactionFinding[] {
  const findings: RedactionFinding[] = [];
  for (const pattern of PATTERNS) {
    pattern.expression.lastIndex = 0;
    for (const match of value.matchAll(pattern.expression)) {
      if (match.index === undefined) continue;
      if (pattern.kind === "phone" && (/^\d{4}-\d{2}-\d{2}(?:\.\d+)?$/.test(match[0])
        || match[0].replace(/\D/g, "").length > 15)) continue;
      findings.push({
        kind: pattern.kind,
        start: match.index,
        end: match.index + match[0].length,
        severity: pattern.severity,
      });
    }
  }
  return findings.sort((left, right) => left.start - right.start || right.end - left.end);
}

export function redactText(value: string, findings = scanText(value)): string {
  let output = value;
  for (const finding of [...findings].sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, finding.start)}[REDACTED:${finding.kind}]${output.slice(finding.end)}`;
  }
  return output;
}

export function scanStructured(value: unknown, rootPath = "$", seen = new WeakSet<object>()): StructuredRedactionFinding[] {
  if (isSafeIntegrityDigest(rootPath, value)) return [];
  const sensitiveKind = sensitiveKeyKind(rootPath);
  if (sensitiveKind && value !== null && value !== undefined && !alreadyRedacted(value)) {
    const rendered = typeof value === "string" ? value : String(value);
    return [{ kind: sensitiveKind, start: 0, end: Math.max(1, rendered.length), severity: "high", path: rootPath }];
  }
  if (typeof value === "string") return structuredStringFindings(value, rootPath);
  if (!value || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => scanStructured(entry, `${rootPath}[${index}]`, seen));
  }
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([key, entry]) => scanStructured(entry, `${rootPath}.${key}`, seen));
}

export function redactStructured(value: unknown): { value: unknown; findings: StructuredRedactionFinding[] } {
  const findings: StructuredRedactionFinding[] = [];
  const visit = (entry: unknown, path: string, seen: WeakSet<object>): unknown => {
    if (isSafeIntegrityDigest(path, entry)) return entry;
    const sensitiveKind = sensitiveKeyKind(path);
    if (sensitiveKind && entry !== null && entry !== undefined && !alreadyRedacted(entry)) {
      const rendered = typeof entry === "string" ? entry : String(entry);
      findings.push({ kind: sensitiveKind, start: 0, end: Math.max(1, rendered.length), severity: "high", path });
      return `[REDACTED:${sensitiveKind}]`;
    }
    if (typeof entry === "string") {
      const matches = structuredStringFindings(entry, path);
      findings.push(...matches);
      return matches.length ? redactText(entry, matches) : entry;
    }
    if (!entry || typeof entry !== "object") return entry;
    if (seen.has(entry)) return "[REDACTED:cyclic_reference]";
    seen.add(entry);
    if (Array.isArray(entry)) return entry.map((item, index) => visit(item, `${path}[${index}]`, seen));
    return Object.fromEntries(Object.entries(entry as Record<string, unknown>)
      .map(([key, item]) => [key, visit(item, `${path}.${key}`, seen)]));
  };
  return { value: visit(value, "$", new WeakSet<object>()), findings };
}

function sanitizePart(part: ContentPart): ContentPart {
  if (part.value === null) {
    if (part.blob_ref === null) return { ...part, redaction_status: "quarantined" };
    const referenceFindings = scanText(part.blob_ref);
    if (referenceFindings.length === 0) return { ...part, redaction_status: "passed" };
    const value = "[REDACTED:sensitive_reference]";
    return {
      ...part,
      value,
      blob_ref: null,
      sha256: sha256(value),
      redaction_status: "redacted",
      sensitivity: "restricted",
    };
  }
  const findings = scanText(part.value);
  if (findings.length === 0) return { ...part, redaction_status: "passed" };
  const value = redactText(part.value, findings);
  return {
    ...part,
    value,
    blob_ref: null,
    sha256: sha256(value),
    redaction_status: "redacted",
    sensitivity: findings.some((finding) => finding.severity === "high") ? "restricted" : "confidential",
  };
}

export function sanitizeBundle(bundle: TraceBundle): { bundle: TraceBundle; findingCount: number } {
  let findingCount = 0;
  const redactedCallIds = new Map<string, string>();
  for (const event of bundle.events) {
    const callId = event.tool?.call_id;
    if (callId && scanText(callId).length > 0 && !redactedCallIds.has(callId)) {
      redactedCallIds.set(callId, `redacted-call-${redactedCallIds.size + 1}`);
    }
  }
  const safeSourceId = (value: string | null): string | null => {
    if (value === null) return null;
    const findings = scanText(value);
    findingCount += findings.length;
    return findings.length === 0 ? value : null;
  };
  const events = bundle.events.map((event) => {
    const structured = [
      redactStructured(event.tool?.arguments),
      redactStructured(event.tool?.result),
      redactStructured(event.metadata),
      redactStructured(event.links),
    ];
    const structuredCount = structured.reduce((total, result) => total + result.findings.length, 0);
    findingCount += structuredCount;
    const eventIdFindings = scanText(event.event_id);
    const toolNameFindings = event.tool?.name ? scanText(event.tool.name) : [];
    findingCount += eventIdFindings.length + toolNameFindings.length;
    return {
      ...event,
      content: event.content.map((part) => {
        const findings = part.value === null ? (part.blob_ref === null ? [] : scanText(part.blob_ref)) : scanText(part.value);
        const mimeFindings = scanText(part.mime_type);
        findingCount += findings.length + mimeFindings.length;
        return {
          ...sanitizePart(part),
          ...(mimeFindings.length ? { mime_type: "application/octet-stream" } : {}),
        };
      }),
      tool: event.tool === null ? null : {
        ...event.tool,
        call_id: event.tool.call_id === null ? null : redactedCallIds.get(event.tool.call_id) ?? event.tool.call_id,
        name: toolNameFindings.length ? "redacted_tool" : event.tool.name,
        arguments: structured[0]!.value,
        result: structured[1]!.value,
      },
      metadata: {
        ...(structured[2]!.value as Record<string, unknown>),
        ...(structuredCount > 0 ? {
          trajpack_structured_redaction: {
            finding_count: structuredCount,
            policy_version: "redaction/0.1",
          },
        } : {}),
      },
      links: structured[3]!.value as typeof event.links,
      event_id: eventIdFindings.length
        ? `redacted-event-${sha256(canonicalEventIdentity(event)).slice(0, 24)}`
        : event.event_id,
      source_event_id: safeSourceId(event.source_event_id),
      source_session_id: safeSourceId(event.source_session_id),
      source_turn_id: safeSourceId(event.source_turn_id),
      source_step_id: safeSourceId(event.source_step_id),
    };
  });
  return { bundle: { ...bundle, events }, findingCount };
}

function canonicalEventIdentity(event: TraceBundle["events"][number]): string {
  return `${event.trace_id}:${event.sequence}:${event.event_type}:${event.actor}`;
}
