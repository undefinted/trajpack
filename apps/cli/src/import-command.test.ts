import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

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

describe("ZIP import command integration", () => {
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
        }),
      }),
      "test-passphrase-long-enough",
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
});
