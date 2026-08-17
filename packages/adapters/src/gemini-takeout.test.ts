import { describe, expect, it } from "vitest";
import { normalizeManualImport } from "./imported.js";

describe("Gemini Takeout activity import", () => {
  it("keeps role inference conservative and never labels activity metadata as an assistant answer", () => {
    const normalized = normalizeManualImport({
      record_kind: "imported_record",
      provenance: {
        detected_format: "gemini_takeout_activity_json",
        source_product: "gemini",
        source_authenticity: "unverified_user_supplied",
      },
      record: {
        header: "Gemini Apps",
        title: "Prompted Explain trajectory provenance",
        description: "Flat activity metadata, not a verified assistant response.",
        time: "2026-08-15T12:00:00.000Z",
        products: ["Gemini Apps"],
      },
    }, {
      traceId: "0123456789abcdef0123456789abcdef",
      sequence: 0,
      capturedAt: "2026-08-16T00:00:00.000Z",
      interfaceVersion: "gemini_takeout_activity_json",
    });

    expect(normalized.events.map((event) => [event.actor, event.content[0]?.value])).toEqual([
      ["user", "Explain trajectory provenance"],
      ["environment", "Flat activity metadata, not a verified assistant response."],
    ]);
    expect(normalized.events.some((event) => event.actor === "assistant")).toBe(false);
    expect(normalized.events[1]?.metadata.source_role_inference)
      .toBe("takeout_activity_metadata_not_assistant");
  });
});
