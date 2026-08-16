import { describe, expect, it } from "vitest";
import { validateCollectorBaseUrl, validatePairingNonce } from "./pairing.js";

describe("one-time loopback pairing", () => {
  it("accepts only an explicit IPv4 loopback port", () => {
    expect(validateCollectorBaseUrl("http://127.0.0.1:49152").origin).toBe("http://127.0.0.1:49152");
    for (const rejected of [
      "https://127.0.0.1:49152",
      "http://localhost:49152",
      "http://127.0.0.1",
      "http://127.0.0.1:49152/path",
      "http://user:pass@127.0.0.1:49152",
    ]) {
      expect(() => validateCollectorBaseUrl(rejected)).toThrow();
    }
  });

  it("requires a nontrivial base64url nonce", () => {
    expect(validatePairingNonce("abcdefghijklmnopqrst")).toBe("abcdefghijklmnopqrst");
    expect(() => validatePairingNonce("short")).toThrow();
    expect(() => validatePairingNonce("abcdefghijklmnopqrs+")).toThrow();
  });
});
