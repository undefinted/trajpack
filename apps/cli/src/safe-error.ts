import { redactText, scanText } from "@trajpack/core";

const MAX_PUBLIC_ERROR_CHARACTERS = 500;

function errorName(error: unknown): string | null {
  if (error instanceof Error) return error.name;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const name = (error as Record<string, unknown>).name;
    return typeof name === "string" ? name : null;
  }
  return null;
}

/** Render an operator-useful error without echoing untrusted JSON/Zod input. */
export function safeCliErrorMessage(error: unknown): string {
  const name = errorName(error);
  if (name === "SyntaxError" || name === "ZodError") {
    return "input could not be parsed or did not match the required schema";
  }
  if (!(error instanceof Error)) return "operation failed";
  const oneLine = error.message
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/[\u0000-\u001f\u007f]/gu, "�")
    .trim();
  if (!oneLine) return "operation failed";
  const findings = scanText(oneLine);
  const redacted = findings.length > 0 ? redactText(oneLine, findings) : oneLine;
  return redacted.length <= MAX_PUBLIC_ERROR_CHARACTERS
    ? redacted
    : `${redacted.slice(0, MAX_PUBLIC_ERROR_CHARACTERS)}…`;
}

/** Debug output intentionally excludes message and stack payloads. */
export function safeCliDebugDiagnostic(error: unknown): string {
  const name = errorName(error) ?? "UnknownError";
  const code = error && typeof error === "object" && !Array.isArray(error)
    ? (error as Record<string, unknown>).code
    : undefined;
  return typeof code === "string" && /^[A-Z0-9_]+$/u.test(code)
    ? `${name} code=${code}`
    : name;
}
