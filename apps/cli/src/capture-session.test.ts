import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyJsonLine } from "@trajpack/adapters";
import {
  consentReceipt,
  createManifest,
  defaultSource,
  readBundle,
  vaultPath,
  type TrajpackPaths,
} from "@trajpack/core";
import { CaptureLimitError, CaptureSession, reconcileObservedHarnessTeacher } from "./capture-session.js";

const ownedRights = {
  source_license_expression: "Apache-2.0",
  model_license_chain: ["Apache-2.0"],
  input_rights_basis: "owned" as const,
  third_party_content: "none" as const,
  rights_holder: "fixture-owner",
};

describe("capture session publication", () => {
  it("does not publish an empty capture when no authoritative plugin or stream event arrived", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-empty-capture-"));
    const paths: TrajpackPaths = {
      data: root,
      vault: join(root, "vault"),
      runtime: join(root, "runtime"),
      tombstones: join(root, "tombstones"),
    };
    const manifest = createManifest({
      source: defaultSource("codex", "openai"),
      accountType: "api",
      rights: ownedRights,
      consentReceipt: consentReceipt("codex", root),
      consentPurposes: ["archive", "research", "capture"],
    });
    const session = await CaptureSession.create("codex", manifest, "test-passphrase", paths);
    try {
      await expect(session.finalize()).rejects.toThrow("no authoritative raw events");
      await expect(stat(vaultPath(manifest.trace_id, paths))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await session.abort().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not publish a partially understood native hook capture", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-unsupported-hook-"));
    const paths: TrajpackPaths = {
      data: root,
      vault: join(root, "vault"),
      runtime: join(root, "runtime"),
      tombstones: join(root, "tombstones"),
    };
    const manifest = createManifest({
      source: defaultSource("gemini_cli", "google"),
      accountType: "api",
      rights: ownedRights,
      consentReceipt: consentReceipt("gemini_cli", root),
      consentPurposes: ["archive", "research", "capture"],
    });
    const session = await CaptureSession.create("gemini_cli", manifest, "test-passphrase", paths);
    const future = classifyJsonLine("gemini_cli", JSON.stringify({
      session_id: "future-session",
      hook_event_name: "FutureHook",
      cwd: root,
      timestamp: "2026-08-17T00:00:00.000Z",
    }), 0, "gemini-cli-hook/1");
    try {
      await session.ingest(future);
      await expect(session.finalize()).rejects.toThrow("Unsupported or incomplete gemini_cli event");
      await expect(stat(vaultPath(manifest.trace_id, paths))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await session.abort().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds a DeepSeek teacher label to the pinned Harness request header", () => {
    const source = defaultSource("deepseek_harness", "deepseek");
    source.model_id = "deepseek-reasoner";
    const envelope = classifyJsonLine("deepseek_harness", JSON.stringify({
      type: "request/header",
      id: "request-header-1",
      session_id: "session-1",
      data: { provider: "deepseek", model: "deepseek-reasoner" },
    }), 0);
    expect(envelope).not.toBeNull();
    const reconciled = reconcileObservedHarnessTeacher(source, [envelope!]);
    expect(reconciled.authenticity_evidence_ref)
      .toMatch(/^native-request-header:sha256:[a-f0-9]{64}$/u);
    expect(() => reconcileObservedHarnessTeacher({ ...source, model_id: "different-model" }, [envelope!]))
      .toThrow("does not match");
    expect(reconcileObservedHarnessTeacher(source, []).authenticity_evidence_ref).toBeNull();
  });

  it("publishes only a finalized vault that can be reopened by the bounded reader", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-capture-session-"));
    const paths: TrajpackPaths = {
      data: root,
      vault: join(root, "vault"),
      runtime: join(root, "runtime"),
      tombstones: join(root, "tombstones"),
    };
    const passphrase = "correct horse battery staple";
    const manifest = createManifest({
      source: defaultSource("codex", "openai"),
      accountType: "api",
      rights: ownedRights,
      consentReceipt: consentReceipt("codex", root),
      consentPurposes: ["archive", "research", "capture"],
    });
    const session = await CaptureSession.create("codex", manifest, passphrase, paths, {
      maxRawEvents: 2,
      maxRawBytes: 64 * 1024,
      maxVaultBytes: 128 * 1024,
    });
    const envelope = classifyJsonLine("codex", JSON.stringify({
      type: "item.completed",
      item: { id: "answer-1", type: "agent_message", text: "reopenable capture sentinel" },
    }), 0);
    expect(envelope).not.toBeNull();

    try {
      expect(await session.ingest(envelope)).toBe(true);
      const finalized = await session.finalize();
      const path = vaultPath(manifest.trace_id, paths);
      expect((await stat(path)).size).toBeLessThan(128 * 1024);
      const reopened = await readBundle(path, passphrase);
      expect(reopened).toEqual(finalized);
      expect(reopened.raw).toHaveLength(1);
      expect(reopened.events.length).toBeGreaterThan(0);
    } finally {
      await session.abort().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("enforces the aggregate stored-raw budget before appending an envelope", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-capture-session-limit-"));
    const paths: TrajpackPaths = {
      data: root,
      vault: join(root, "vault"),
      runtime: join(root, "runtime"),
      tombstones: join(root, "tombstones"),
    };
    const manifest = createManifest({
      source: defaultSource("codex", "openai"),
      accountType: "api",
      rights: ownedRights,
      consentReceipt: consentReceipt("codex", root),
      consentPurposes: ["archive", "research", "capture"],
    });
    const session = await CaptureSession.create(
      "codex",
      manifest,
      "correct horse battery staple",
      paths,
      { maxRawEvents: 1, maxRawBytes: 1 },
    );
    const envelope = classifyJsonLine("codex", JSON.stringify({
      type: "item.completed",
      item: { id: "answer-1", type: "agent_message", text: "too large" },
    }), 0);
    try {
      await expect(session.ingest(envelope)).rejects.toMatchObject({
        reason: "CAPTURE_RAW_BYTE_LIMIT_EXCEEDED",
      });
      await session.abort();
      await expect(stat(vaultPath(manifest.trace_id, paths))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await session.abort().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
