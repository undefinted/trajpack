import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJson, sha256, writeBundle } from "@trajpack/core";
import { fixtureBundle } from "../../../packages/core/src/testing.js";

const capture = vi.hoisted(() => ({
  create: vi.fn(),
  ingest: vi.fn(async () => true),
  abort: vi.fn(async () => undefined),
}));

vi.mock("./secret.js", () => ({
  readPassphrase: vi.fn(async () => "test-passphrase-long-enough"),
}));

vi.mock("./capture-session.js", () => ({
  CaptureSession: {
    create: capture.create,
  },
}));

import { runImport } from "./import-command.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  capture.create.mockReset();
  capture.ingest.mockClear();
  capture.abort.mockClear();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("import command integration", () => {
  it("imports a validated Gemini Takeout activity snapshot as Google consumer archive metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trajpack-cli-gemini-takeout-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "MyActivity.json");
    const termsPath = join(directory, "google-terms.json");
    await writeFile(path, JSON.stringify([{
      header: "Gemini Apps",
      title: "Prompted summarize this fixture",
      description: "Activity metadata; not an inferred assistant answer.",
      time: "2026-08-16T12:00:00.000Z",
      products: ["Gemini Apps"],
    }]));
    await writeFile(termsPath, JSON.stringify({
      name: "Google Terms of Service",
      url: "https://policies.google.com/terms",
      effective_at: "2026-01-01T00:00:00.000Z",
      retrieved_at: "2026-08-16T00:00:00.000Z",
      snapshot_sha256: "a".repeat(64),
      review_after: "2099-01-01T00:00:00.000Z",
    }));
    capture.create.mockImplementation(async (_host: string, manifest: { trace_id: string }) => ({
      ingest: capture.ingest,
      abort: capture.abort,
      finalize: vi.fn(async () => ({ manifest })),
    }));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runImport(path, {
      sourceHint: "gemini",
      accountType: "consumer",
      terms: termsPath,
    });

    expect(capture.create).toHaveBeenCalledWith(
      "manual_import",
      expect.objectContaining({
        source: expect.objectContaining({
          provider: "google",
          product: "official-export:gemini_takeout_activity_json",
          interface_version: "gemini_takeout_activity_json",
          authenticity: "user_supplied",
        }),
        eligibility: expect.objectContaining({
          local_archive: expect.objectContaining({ status: "allow" }),
          training_noncompetitive: expect.objectContaining({ status: "unknown" }),
          training_competitive_distillation: expect.objectContaining({ status: "unknown" }),
        }),
      }),
      "test-passphrase-long-enough",
      undefined,
      { maxRawEvents: 250_000, maxRawBytes: 192 * 1024 * 1024 },
    );
  });

  it("keeps a DeepSeek-shaped offline response user-supplied and non-training by default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trajpack-cli-deepseek-json-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "deepseek-response.json");
    const termsPath = join(directory, "deepseek-terms.json");
    await writeFile(path, JSON.stringify({
      id: "chatcmpl-user-authored-deepseek-shape",
      object: "chat.completion",
      created: 1_786_838_400,
      model: "deepseek-reasoner",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          reasoning_content: "This string was authored offline.",
          content: "Not provider-authenticated.",
        },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }));
    await writeFile(termsPath, JSON.stringify({
      name: "DeepSeek Terms of Use",
      url: "https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html",
      effective_at: "2026-01-01T00:00:00.000Z",
      retrieved_at: "2026-08-16T00:00:00.000Z",
      snapshot_sha256: "a".repeat(64),
      review_after: "2099-01-01T00:00:00.000Z",
    }));
    capture.create.mockImplementation(async (_host: string, manifest: { trace_id: string }) => ({
      ingest: capture.ingest,
      abort: capture.abort,
      finalize: vi.fn(async () => ({ manifest })),
    }));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runImport(path, {
      sourceHint: "deepseek-api",
      terms: termsPath,
      sourceLicense: "Apache-2.0",
      inputRights: "owned",
      thirdParty: "none",
      rightsHolder: "fixture-owner",
      targetModelOwner: "research-lab",
      targetProduct: "general-model",
      competitive: "yes",
    });

    expect(capture.create).toHaveBeenCalledWith(
      "manual_import",
      expect.objectContaining({
        source: expect.objectContaining({
          provider: "deepseek",
          product: "deepseek-api-response",
          authenticity: "user_supplied",
          authenticity_evidence_ref: null,
        }),
        eligibility: expect.objectContaining({
          training_noncompetitive: expect.objectContaining({ status: "unknown" }),
          training_competitive_distillation: expect.objectContaining({ status: "unknown" }),
        }),
      }),
      "test-passphrase-long-enough",
      undefined,
      { maxRawEvents: 250_000, maxRawBytes: 192 * 1024 * 1024 },
    );
  });

  it("routes a validated ChatGPT official archive into manual_import capture with ZIP provenance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trajpack-cli-zip-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "chatgpt-export.zip");
    const termsPath = join(directory, "terms.json");
    const conversation = [{
      id: "chatgpt-cli-fixture",
      mapping: {
        node: {
          message: {
            author: { role: "user" },
            content: { content_type: "text", parts: ["hello"] },
          },
        },
      },
    }];
    await writeFile(path, zipSync({ "conversations.json": strToU8(JSON.stringify(conversation)) }));
    await writeFile(termsPath, JSON.stringify({
      name: "OpenAI Terms of Use",
      url: "https://openai.com/policies/row-terms-of-use/",
      effective_at: "2026-01-01T00:00:00.000Z",
      retrieved_at: "2026-08-16T00:00:00.000Z",
      snapshot_sha256: "a".repeat(64),
      review_after: "2099-01-01T00:00:00.000Z",
    }));

    capture.create.mockImplementation(async (_host: string, manifest: { trace_id: string }) => ({
      ingest: capture.ingest,
      abort: capture.abort,
      finalize: vi.fn(async () => ({ manifest })),
    }));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const traceId = await runImport(path, {
      sourceHint: "chatgpt",
      provider: "openai",
      accountType: "consumer",
      writtenPermission: "fixture-contract-evidence",
      terms: termsPath,
    });

    expect(traceId).toMatch(/^[a-f0-9]{32}$/u);
    expect(capture.create).toHaveBeenCalledWith(
      "manual_import",
      expect.objectContaining({
        source: expect.objectContaining({
          provider: "openai",
          interface_version: "chatgpt_official_json",
          product: "official-export:chatgpt_official_json",
          authenticity: "user_supplied",
        }),
      }),
      "test-passphrase-long-enough",
      undefined,
      { maxRawEvents: 250_000, maxRawBytes: 192 * 1024 * 1024 },
    );
    expect(capture.ingest).toHaveBeenCalledTimes(1);
    expect(capture.ingest).toHaveBeenCalledWith(expect.objectContaining({
      adapter: "manual_import",
      interface_version: "chatgpt_official_json",
      payload: expect.objectContaining({
        provenance: expect.objectContaining({
          archive: expect.objectContaining({
            container_format: "zip",
            selected_entry_name: "conversations.json",
          }),
        }),
      }),
    }));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("imported chatgpt_official_json"));

    await expect(runImport(path, {
      sourceHint: "chatgpt",
      provider: "deepseek",
      accountType: "api",
      terms: termsPath,
    })).rejects.toThrow("provenance conflicts with --provider deepseek");

    await expect(runImport(path, { maxBytes: "not-a-number" })).rejects.toThrow("--max-bytes must be a positive integer");
    await expect(runImport(path, { maxBytes: 1 })).rejects.toThrow("1-byte limit");
  });

  it("keeps a generic DeepSeek web archive labeled manual rather than official", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trajpack-cli-deepseek-manual-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "manual-conversation.json");
    const termsPath = join(directory, "deepseek-terms.json");
    await writeFile(path, JSON.stringify({ messages: [{ role: "user", content: "archived by the user" }] }));
    await writeFile(termsPath, JSON.stringify({
      name: "DeepSeek Terms of Use",
      url: "https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html",
      effective_at: "2026-01-01T00:00:00.000Z",
      retrieved_at: "2026-08-16T00:00:00.000Z",
      snapshot_sha256: "a".repeat(64),
      review_after: "2099-01-01T00:00:00.000Z",
    }));
    capture.create.mockImplementation(async (_host: string, manifest: { trace_id: string }) => ({
      ingest: capture.ingest,
      abort: capture.abort,
      finalize: vi.fn(async () => ({ manifest })),
    }));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runImport(path, {
      sourceHint: "generic",
      provider: "deepseek",
      accountType: "consumer",
      terms: termsPath,
    });

    expect(capture.create).toHaveBeenCalledWith(
      "manual_import",
      expect.objectContaining({
        source: expect.objectContaining({
          provider: "deepseek",
          product: "manual-archive:generic_json",
          capture_method: "manual_copy",
          fidelity: "C",
          authenticity: "user_supplied",
        }),
      }),
      "test-passphrase-long-enough",
      undefined,
      { maxRawEvents: 250_000, maxRawBytes: 192 * 1024 * 1024 },
    );
  });

  it("downgrades unsigned vault assertions, preserves consent, and rejects source relabeling", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trajpack-cli-vault-import-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "attacker-authored.trajpack");
    const imported = fixtureBundle("external encrypted vault");
    imported.manifest.source.authenticity = "cryptographically_verified";
    imported.manifest.source.authenticity_evidence_ref = "attacker-controlled:signature-looking-string";
    imported.manifest.account_contract.order_form_or_written_permission_ref = "attacker-controlled:contract";
    imported.manifest.account_contract.scoped_permission = {
      evidence_ref: "attacker-controlled:contract",
      provider: "self_hosted",
      account_type: "self_hosted",
      capture_methods: ["instrumented_harness"],
      origins: [],
      permitted_purposes: ["training_competitive_distillation"],
      target_model_owner: "owner",
      target_product: "open-model",
      reviewer: "attacker-controlled-reviewer",
      effective_at: "2026-01-01T00:00:00.000Z",
      expires_at: "2099-01-01T00:00:00.000Z",
    };
    const payload = { type: "session.created", session_id: "external-session" };
    imported.raw = [{
      envelope_version: "raw/0.1",
      adapter: "deepseek_harness",
      adapter_version: imported.manifest.source.adapter_version,
      interface_version: imported.manifest.source.interface_version,
      captured_at: imported.manifest.created_at,
      sequence: 0,
      source_event_id: "external-0",
      session_id: "external-session",
      turn_id: null,
      payload_sha256: sha256(canonicalJson(payload)),
      payload,
    }];
    imported.manifest.lineage.raw_sha256 = sha256(canonicalJson(imported.raw));
    await writeBundle(path, "test-passphrase-long-enough", imported);

    capture.create.mockImplementation(async (_host: string, manifest: { trace_id: string }) => ({
      ingest: capture.ingest,
      abort: capture.abort,
      finalize: vi.fn(async () => ({ manifest })),
    }));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const traceId = await runImport(path, {});

    expect(traceId).toMatch(/^[a-f0-9]{32}$/u);
    const importedManifest = capture.create.mock.calls[0]?.[1];
    expect(importedManifest).toEqual(expect.objectContaining({
      source: expect.objectContaining({
        host: "deepseek_harness",
        provider: "self_hosted",
        authenticity: "user_supplied",
        authenticity_evidence_ref: null,
      }),
      account_contract: expect.objectContaining({
        order_form_or_written_permission_ref: null,
      }),
      eligibility: expect.objectContaining({
        training_noncompetitive: expect.objectContaining({ status: "unknown" }),
        training_competitive_distillation: expect.objectContaining({ status: "unknown" }),
      }),
      consent: imported.manifest.consent,
      lineage: expect.objectContaining({ parent_trace_ids: [imported.manifest.trace_id] }),
    }));
    expect(importedManifest?.account_contract.scoped_permission).toBeUndefined();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("source authenticity downgraded"));

    await expect(runImport(path, { provider: "deepseek" }))
      .rejects.toThrow("Encrypted trajpack source provider is immutable");
  }, 30_000);

  it("does not revive consent withdrawn in an imported vault", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trajpack-cli-withdrawn-vault-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "withdrawn.trajpack");
    const imported = fixtureBundle("withdrawn external vault");
    imported.manifest.source.authenticity = "request_receipt_verified";
    imported.manifest.source.authenticity_evidence_ref = "untrusted:receipt";
    imported.manifest.consent.active = false;
    imported.manifest.consent.withdrawal_ref = "withdrawal:fixture-17";
    const payload = { type: "session.created", session_id: "withdrawn-session" };
    imported.raw = [{
      envelope_version: "raw/0.1",
      adapter: "deepseek_harness",
      adapter_version: imported.manifest.source.adapter_version,
      interface_version: imported.manifest.source.interface_version,
      captured_at: imported.manifest.created_at,
      sequence: 0,
      source_event_id: "withdrawn-0",
      session_id: "withdrawn-session",
      turn_id: null,
      payload_sha256: sha256(canonicalJson(payload)),
      payload,
    }];
    imported.manifest.lineage.raw_sha256 = sha256(canonicalJson(imported.raw));
    await writeBundle(path, "test-passphrase-long-enough", imported);

    await expect(runImport(path, {})).rejects.toThrow(/CONSENT_INACTIVE|CONSENT_WITHDRAWN/u);
    expect(capture.create).not.toHaveBeenCalled();
  }, 30_000);
});
