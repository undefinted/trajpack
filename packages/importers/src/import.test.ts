import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectImportFormat, extractNonExecutingHtmlPreview, importToRawEnvelopes } from "./index.js";

const capturedAt = "2026-08-16T00:00:00.000Z";

function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}

describe("format detection and raw envelopes", () => {
  it("imports generic JSON and JSONL deterministically", () => {
    const json = importToRawEnvelopes('[{"id":"a"},{"id":"b"}]', { capturedAt, filename: "events.json" });
    expect(json.detection.format).toBe("generic_json");
    expect(json.envelopes.map((envelope) => envelope.sequence)).toEqual([0, 1]);
    expect(json.envelopes[0]?.adapter).toBe("manual_import");
    expect(json.envelopes[0]?.payload_sha256).toMatch(/^[a-f0-9]{64}$/u);

    const jsonl = importToRawEnvelopes('{"event":1}\n{"event":2}\n', { capturedAt });
    expect(jsonl.detection.format).toBe("generic_jsonl");
    expect(jsonl.envelopes).toHaveLength(2);
  });

  it("recognizes ChatGPT only with the official filename or an explicit hint and a strict mapping shape", () => {
    const exportFixture = [{
      id: "conversation-1",
      title: "Fixture",
      mapping: {
        node: {
          message: {
            author: { role: "user" },
            content: { content_type: "text", parts: ["hello"] },
          },
        },
      },
    }];
    const result = importToRawEnvelopes(JSON.stringify(exportFixture), {
      capturedAt,
      filename: "conversations.json",
    });
    expect(result.detection.format).toBe("chatgpt_official_json");
    expect(result.provenance.import_method).toBe("official_export");
    expect(result.provenance.source_product).toBe("chatgpt");

    expect(
      detectImportFormat(JSON.stringify(exportFixture), { filename: "arbitrary.json" }).detection.format,
    ).toBe("generic_json");
  });

  it("recognizes a conservative Claude conversations.json shape", () => {
    const exportFixture = [{
      uuid: "conversation-2",
      name: "Fixture",
      chat_messages: [{ uuid: "message-1", sender: "human", text: "hello" }],
    }];
    const result = importToRawEnvelopes(JSON.stringify(exportFixture), {
      capturedAt,
      filename: "conversations.json",
    });
    expect(result.detection.format).toBe("claude_official_json");
    expect(result.envelopes[0]?.session_id).toBe("conversation-2");
  });

  it("recognizes Google Takeout Gemini Apps activity without pretending it is a conversation graph", () => {
    const activity = [{
      header: "Gemini Apps",
      title: "Prompted Explain deterministic data splits",
      description: "Activity metadata and an exported response may appear here.",
      time: "2026-08-15T12:00:00.000Z",
      products: ["Gemini Apps"],
    }];
    const result = importToRawEnvelopes(JSON.stringify(activity), {
      capturedAt,
      filename: "MyActivity.json",
    });
    expect(result.detection.format).toBe("gemini_takeout_activity_json");
    expect(result.provenance).toMatchObject({
      import_method: "official_export",
      source_product: "gemini",
      source_authenticity: "unverified_user_supplied",
    });
    expect(result.warnings.join(" ")).toContain("activity log");
    expect(detectImportFormat(JSON.stringify(activity), { filename: "activity.json" }).detection.format)
      .toBe("generic_json");
  });

  it("rejects source hints when the official shape is absent", () => {
    expect(() => importToRawEnvelopes("{}", { capturedAt, sourceHint: "claude" })).toThrow(
      "does not match the conservative claude official export shape",
    );
  });

  it("conservatively recognizes complete and streaming DeepSeek API response artifacts", () => {
    const response = importToRawEnvelopes(fixture("deepseek-api.response.json"), {
      capturedAt,
      filename: "response.json",
    });
    expect(response.detection).toMatchObject({
      format: "deepseek_api_response",
      mediaType: "application/json",
    });
    expect(response.provenance).toMatchObject({
      import_method: "manual_import",
      source_product: "deepseek_api",
      detected_format: "deepseek_api_response",
      fidelity: "B",
    });
    expect(response.envelopes[0]).toMatchObject({
      adapter: "manual_import",
      interface_version: "deepseek_api_response",
      session_id: "chatcmpl-deepseek-fixture-1",
    });

    const stream = importToRawEnvelopes(fixture("deepseek-api.stream.jsonl"), { capturedAt });
    expect(stream.detection).toMatchObject({
      format: "deepseek_api_response",
      mediaType: "application/x-ndjson",
    });
    expect(stream.envelopes).toHaveLength(3);
  });

  it("requires an explicit hint or a DeepSeek model identifier for OpenAI-compatible API shapes", () => {
    const compatibleResponse = JSON.stringify({
      id: "chatcmpl-compatible",
      object: "chat.completion",
      created: 1786838400,
      model: "vendor-model-v1",
      choices: [{
        index: 0,
        message: { role: "assistant", reasoning_content: "Visible rationale", content: "Answer" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    });
    expect(importToRawEnvelopes(compatibleResponse, { capturedAt }).detection.format).toBe("generic_json");
    expect(() => importToRawEnvelopes(compatibleResponse, {
      capturedAt,
      sourceHint: "deepseek-api",
    })).toThrow("does not match the conservative DeepSeek API response shape");

    expect(() => importToRawEnvelopes(JSON.stringify({
      object: "chat.completion",
      model: "deepseek-reasoner",
      choices: [],
    }), { capturedAt, sourceHint: "deepseek-api" })).toThrow(
      "does not match the conservative DeepSeek API response shape",
    );
  });

  it("rejects empty JSON collections instead of silently producing no records", () => {
    expect(() => importToRawEnvelopes("[]", { capturedAt })).toThrow("contains no records");
  });
});

describe("untrusted HTML import", () => {
  it("never constructs a DOM or executes malicious active content", () => {
    const malicious = '<!doctype html><script>globalThis.__owned = true</script><p>Hello &amp; goodbye</p><iframe src="https://evil.invalid"></iframe>';
    const preview = extractNonExecutingHtmlPreview(malicious);
    expect(preview).toBe("Hello & goodbye");
    expect((globalThis as Record<string, unknown>)["__owned"]).toBeUndefined();

    const result = importToRawEnvelopes(malicious, { capturedAt, filename: "archive.html" });
    expect(result.detection.format).toBe("generic_html");
    expect(result.warnings[0]).toContain("never rendered");
    expect(JSON.stringify(result.envelopes[0]?.payload)).toContain("preview_is_not_visibility_evidence");

    expect(extractNonExecutingHtmlPreview("<script>never closed and never executed")).toBe("");
  });

  it("stores a marked Gemini Takeout activity page as inert text", () => {
    const exported = [
      "<!doctype html><html><head><title>My Activity</title></head><body>",
      "<h1>Gemini Apps</h1><script>globalThis.__geminiOwned = true</script>",
      "<p>Prompted safe import</p></body></html>",
    ].join("");
    const result = importToRawEnvelopes(exported, {
      capturedAt,
      filename: "MyActivity.html",
      sourceHint: "gemini",
    });
    expect(result.detection.format).toBe("gemini_takeout_activity_html");
    expect(JSON.stringify(result.envelopes[0]?.payload)).toContain("Prompted safe import");
    expect((globalThis as Record<string, unknown>)["__geminiOwned"]).toBeUndefined();
  });
});
