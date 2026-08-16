import { describe, expect, it } from "vitest";
import { safeCliDebugDiagnostic, safeCliErrorMessage } from "./safe-error.js";

describe("safe CLI errors", () => {
  it("does not echo parser or schema input snippets", () => {
    const secret = "Authorization: Bearer must-not-reach-stderr";
    expect(safeCliErrorMessage(new SyntaxError(`Unexpected token in ${secret}`))).not.toContain(secret);
    expect(safeCliErrorMessage({ name: "ZodError", message: `invalid ${secret}` })).not.toContain(secret);
  });

  it("redacts secrets from otherwise actionable errors", () => {
    expect(safeCliErrorMessage(new Error("collector failed: Authorization: Bearer abcdef123456")))
      .toBe("collector failed: [REDACTED:authorization]");
  });

  it("never emits message or stack content in debug diagnostics", () => {
    const error = Object.assign(new Error("password=hunter2"), { code: "E_INPUT" });
    expect(safeCliDebugDiagnostic(error)).toBe("Error code=E_INPUT");
  });
});
