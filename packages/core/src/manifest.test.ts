import { describe, expect, it } from "vitest";
import { consentReceipt, privatePathHmac } from "./manifest.js";

describe("manifest privacy identifiers", () => {
  it("uses a keyed, per-trace path digest", () => {
    const path = "C:\\Users\\private-user\\secret-repository";
    const firstKey = new Uint8Array(32).fill(1);
    const secondKey = new Uint8Array(32).fill(2);
    expect(privatePathHmac(path, firstKey)).toBe(privatePathHmac(path, firstKey));
    expect(privatePathHmac(path, firstKey)).not.toBe(privatePathHmac(path, secondKey));
    expect(privatePathHmac(path, firstKey)).not.toContain("private-user");
  });

  it("does not deterministically encode a path into consent receipts", () => {
    const at = new Date("2026-08-16T00:00:00.000Z");
    const first = consentReceipt("codex", "C:\\Users\\private-user\\repo", at);
    const second = consentReceipt("codex", "C:\\Users\\private-user\\repo", at);
    expect(first).not.toBe(second);
    expect(first).not.toContain("private-user");
  });
});
