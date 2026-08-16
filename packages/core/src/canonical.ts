import { createHash, randomBytes } from "node:crypto";

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, child]) => [key, normalize(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function traceId(): string {
  return randomBytes(16).toString("hex");
}

export function spanId(): string {
  return randomBytes(8).toString("hex");
}

export function stableId(namespace: string, value: unknown, length = 24): string {
  return `${namespace}_${sha256(canonicalJson(value)).slice(0, length)}`;
}
