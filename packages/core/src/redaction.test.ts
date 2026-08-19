import { describe, expect, it } from "vitest";
import { sha256 } from "./canonical.js";
import { fixtureBundle } from "./testing.js";
import { redactStructured, redactText, sanitizeBundle, scanStructured, scanText } from "./redaction.js";

describe("redaction", () => {
  it("redacts credentials without returning their value", () => {
    const secret = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz";
    const findings = scanText(secret);
    expect(findings.some((finding) => finding.kind === "authorization")).toBe(true);
    expect(redactText(secret, findings)).toBe("[REDACTED:authorization]");
  });

  it("recursively sanitizes tool payloads and recomputes content hashes", () => {
    const bundle = fixtureBundle("Authorization: Bearer abcdefghijklmnopqrstuvwxyz");
    bundle.events[0]!.tool = {
      call_id: "call-1",
      name: "request",
      arguments: { nested: { token: "sk-abcdefghijklmnopqrstuvwxyz" } },
      result: { headers: ["Cookie: session=abcdef"] },
      exit_code: 0,
    };
    const originalHash = bundle.events[0]!.content[0]!.sha256;
    const sanitized = sanitizeBundle(bundle);
    const part = sanitized.bundle.events[0]!.content[0]!;
    expect(sanitized.findingCount).toBeGreaterThanOrEqual(3);
    expect(part.value).toBe("[REDACTED:authorization]");
    if (part.value === null) throw new Error("Expected redacted inline content");
    expect(part.sha256).toBe(sha256(part.value));
    expect(part.sha256).not.toBe(originalHash);
    expect(JSON.stringify(sanitized.bundle.events[0]!.tool)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(scanStructured(sanitized.bundle.events[0]!.tool)).toEqual([]);
  });

  it("redacts key-labelled passwords and credentialed URLs", () => {
    const structured = {
      password: "ordinary-words-that-do-not-look-like-a-token",
      endpoint: "https://user:super-secret@example.test/path",
    };
    const findings = scanStructured(structured);
    expect(findings.map((finding) => finding.kind)).toEqual(expect.arrayContaining(["password", "url_credential"]));
    expect(JSON.stringify(sanitizeBundle({
      ...fixtureBundle(),
      events: [{ ...fixtureBundle().events[0]!, metadata: structured }],
    }).bundle.events[0]!.metadata)).not.toContain("super-secret");
  });

  it("treats camel-case, cloud, env, and non-string sensitive keys as secrets", () => {
    const value = {
      accessToken: "opaque-value",
      AWS_SECRET_ACCESS_KEY: "opaque-value",
      ".env": "opaque-value",
      password: 123456,
      nested: { accessKeyId: true },
    };
    const findings = scanStructured(value);
    expect(findings.map((finding) => finding.path)).toEqual(expect.arrayContaining([
      "$.accessToken",
      "$.AWS_SECRET_ACCESS_KEY",
      "$..env",
      "$.password",
      "$.nested.accessKeyId",
    ]));
    const bundle = fixtureBundle();
    bundle.events[0]!.metadata = value;
    const sanitized = sanitizeBundle(bundle).bundle.events[0]!.metadata;
    expect(sanitized).toEqual({
      accessToken: "[REDACTED:api_key]",
      AWS_SECRET_ACCESS_KEY: "[REDACTED:cloud_credential]",
      ".env": "[REDACTED:api_key]",
      password: "[REDACTED:password]",
      nested: { accessKeyId: "[REDACTED:cloud_credential]" },
      trajpack_structured_redaction: expect.any(Object),
    });
  });

  it("does not treat space-separated date-time stamps as phone numbers", () => {
    expect(scanText("log at 2024-05-10 12:34:56 ended")).toEqual([]);
    expect(scanText("log at 2024-05-10 12:34 ended")).toEqual([]);
    expect(scanText("log at 2024-05-10 ended")).toEqual([]);
    expect(scanText("log at 2024-05-10T12:34:56Z ended")).toEqual([]);
    // A genuine phone number is still detected.
    expect(scanText("call 123-456-7890 now")).not.toEqual([]);
  });

  it("does not mistake validated integrity digests for phone numbers", () => {
    const digest = "1".repeat(64);
    const value = {
      raw_payload_sha256: digest,
      request_header_sha256: digest,
      dedupe_key: digest,
      nested: { event_sha256: digest },
    };
    expect(scanStructured(value)).toEqual([]);
    expect(redactStructured(value)).toEqual({ value, findings: [] });
    expect(scanStructured({ raw_payload_sha256: "123 456 7890" })).not.toEqual([]);
  });

  it("redacts a shared non-circular reference only once and preserves it elsewhere", () => {
    const shared = { token: "sk-abcdefghijklmnopqrstuvwxyz" };
    const value = { a: shared, b: shared };
    const { value: redacted, findings } = redactStructured(value);
    expect(findings.map((finding) => finding.path)).toEqual(["$.a.token", "$.b.token"]);
    expect(redacted.a).toEqual({ token: "[REDACTED:api_key]" });
    // b must survive as a normal object, not be mistaken for a cycle.
    expect(redacted.b).toEqual({ token: "[REDACTED:api_key]" });
    expect(redacted.a).not.toBe("[REDACTED:cyclic_reference]");
    expect(redacted.b).not.toBe("[REDACTED:cyclic_reference]");
  });

  it("still replaces a genuine cycle with the cyclic marker", () => {
    const value: Record<string, unknown> = { name: "loop" };
    value.self = value;
    const { value: redacted } = redactStructured(value);
    expect(redacted.self).toBe("[REDACTED:cyclic_reference]");
  });

  it("detects secret assignments in plaintext env/config content", () => {
    const text = [
      "DB_PASSWORD=hunter2",
      "AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwxyz1234567890ABCD",
      "CLIENT_SECRET: opaque-client-value",
    ].join("\n");
    expect(scanText(text).map((finding) => finding.kind)).toEqual(expect.arrayContaining([
      "password",
      "cloud_credential",
      "api_key",
    ]));
    const sanitized = sanitizeBundle(fixtureBundle(text)).bundle.events[0]!.content[0]!;
    expect(sanitized.redaction_status).toBe("redacted");
    expect(sanitized.value).not.toContain("hunter2");
  });
});
