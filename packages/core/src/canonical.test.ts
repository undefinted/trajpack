import { describe, expect, it } from "vitest";
import { canonicalJson, sha256 } from "./canonical.js";

describe("canonical serialization", () => {
  it("uses locale-independent code-unit key ordering with a pinned digest", () => {
    const serialized = canonicalJson({ z: 1, "é": 3, a: { z: 2, a: 1 } });
    expect(serialized).toBe("{\"a\":{\"a\":1,\"z\":2},\"z\":1,\"é\":3}");
    expect(sha256(serialized)).toBe("6c77762a0856cafb5ec3aae4c14114b083f59ff4fac7aef01d0193106a636652");
  });
});
