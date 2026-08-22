import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  consentReceipt,
  createManifest,
  defaultSource,
  readBundle,
  vaultPath,
  type TrajpackPaths,
} from "@trajpack/core";
import {
  apply as applyDeepSeekHarnessPlugin,
  interfaceVersion,
  type HarnessCaptureController,
} from "../../../plugins/deepseek-harness/src/index.js";
import { CaptureSession } from "./capture-session.js";
import {
  makeCaptureReceipt,
  prepareCaptureReceiptPath,
  writeCaptureReceipt,
} from "./capture-receipt.js";
import { startIngestServer } from "./ingest-server.js";

type EventListener = (session: unknown, event: unknown) => void;
type FlushListener = (session: unknown) => Promise<void>;

const ownedRights = {
  source_license_expression: "Apache-2.0",
  model_license_chain: ["LicenseRef-DeepSeek-Terms"],
  input_rights_basis: "owned" as const,
  third_party_content: "none" as const,
  rights_holder: "canary-owner",
};

function event(type: string, seq: number, data: Record<string, unknown>): Record<string, unknown> {
  return { type, seq, time: 1_787_000_000_000 + seq, data };
}

describe("DeepSeek Harness encrypted capture canary", () => {
  it("walks plugin -> HTTP collector -> CaptureSession -> encrypted vault", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dsh-http-canary-"));
    const paths: TrajpackPaths = {
      data: root,
      vault: join(root, "vault"),
      runtime: join(root, "runtime"),
      tombstones: join(root, "tombstones"),
    };
    const passphrase = "correct horse battery staple";
    const token = "canary-one-session-token";
    const promptSentinel = "owned-canary-prompt-853b8a1f";
    const toolSentinel = "owned-canary-tool-result-044a91c2";
    const source = defaultSource("deepseek_harness", "deepseek");
    source.model_id = "deepseek-reasoner";
    source.interface_version = interfaceVersion;
    const manifest = createManifest({
      source,
      accountType: "api",
      rights: ownedRights,
      consentReceipt: consentReceipt("deepseek_harness", root),
      consentPurposes: ["archive", "research", "capture"],
    });
    const capture = await CaptureSession.create(
      "deepseek_harness",
      manifest,
      passphrase,
      paths,
      { maxRawEvents: 32, maxRawBytes: 1024 * 1024 },
    );
    const collector = await startIngestServer({
      host: "deepseek_harness",
      token,
      session: capture,
      maxEvents: 32,
      maxTotalRawBytes: 1024 * 1024,
    });
    const priorUrl = process.env.TRAJPACK_COLLECTOR_URL;
    const priorToken = process.env.TRAJPACK_CAPTURE_TOKEN;
    process.env.TRAJPACK_COLLECTOR_URL = `${collector.url}/v1/hooks/events`;
    process.env.TRAJPACK_CAPTURE_TOKEN = token;

    let lifecycleDispose: (() => Promise<void>) | null = null;
    const listeners = new Map<string, (...args: unknown[]) => unknown>();
    const controller: HarnessCaptureController = applyDeepSeekHarnessPlugin({
      on: (name: string, listener: (...args: unknown[]) => unknown) => {
        listeners.set(name, listener);
      },
      effect: (registration: () => () => Promise<void>) => {
        lifecycleDispose = registration();
      },
    } as Parameters<typeof applyDeepSeekHarnessPlugin>[0]);
    const onEvent = listeners.get("session/event") as EventListener | undefined;
    const onFlush = listeners.get("session/flush") as FlushListener | undefined;
    const liveSession = {
      id: "canary-session",
      firstLiveSeq: 0,
      events: [],
      header: {
        version: 0,
        id: "canary-session",
        seedLength: 0,
        parentSession: null,
        origin: "user",
        delegationDepth: 0,
        agentPreset: "default",
      },
      unobservableInternalState: "must-not-be-forwarded",
    };

    try {
      expect(onEvent).toBeTypeOf("function");
      expect(onFlush).toBeTypeOf("function");
      onEvent!(liveSession, event("request/header", 0, {
        header: {
          config: { provider: "deepseek-official", model: "deepseek-reasoner" },
          tools: [{ name: "shell", description: "run a command", parameters: { type: "object" } }],
        },
        reason: "initial",
      }));
      onEvent!(liveSession, event("user/message", 1, {
        id: "user-canary",
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: promptSentinel }],
      }));
      onEvent!(liveSession, event("assistant/chunk", 2, {
        turn: 0,
        step: 0,
        chunk: { type: "reasoning-delta", index: 0, text: "inspect the owned fixture" },
      }));
      onEvent!(liveSession, event("tool/call", 3, {
        turn: 0,
        step: 0,
        callId: "call-canary",
        name: "shell",
        arguments: "{\"command\":\"verify-owned-fixture\"}",
      }));
      onEvent!(liveSession, event("tool/result", 4, {
        turn: 0,
        step: 0,
        message: {
          id: "result-canary",
          role: "user",
          source: { kind: "tool", callId: "call-canary" },
          content: [{
            type: "tool-result",
            toolCallId: "call-canary",
            content: [{ type: "text", text: toolSentinel }],
          }],
        },
      }));
      onEvent!(liveSession, event("assistant/chunk", 5, {
        turn: 0,
        step: 0,
        chunk: { type: "text-delta", index: 1, text: "verified" },
      }));
      onEvent!(liveSession, event("turn/end", 6, {
        turn: 0,
        reason: { kind: "completed" },
      }));

      await onFlush!(liveSession);
      expect(controller.queueUsage()).toEqual({ events: 0, bytes: 0 });
      await collector.close();
      const bundle = await capture.finalize();
      expect(bundle.raw).toHaveLength(7);
      expect(bundle.events.map(value => value.event_type)).toEqual(expect.arrayContaining([
        "message", "reasoning", "tool.call", "tool.result", "evaluation",
      ]));
      expect(bundle.manifest.source).toMatchObject({
        host: "deepseek_harness",
        provider: "deepseek",
        model_id: "deepseek-reasoner",
        interface_version: interfaceVersion,
      });
      expect(capture.captureStats()).toMatchObject({
        rawEvents: 7,
        normalizedEvents: bundle.events.length,
        rawLineageSha256: bundle.manifest.lineage.raw_sha256,
      });

      const storedPath = vaultPath(manifest.trace_id, paths);
      const encrypted = await readFile(storedPath);
      expect(encrypted.includes(Buffer.from(promptSentinel, "utf8"))).toBe(false);
      expect(encrypted.includes(Buffer.from(toolSentinel, "utf8"))).toBe(false);
      expect(encrypted.includes(Buffer.from("must-not-be-forwarded", "utf8"))).toBe(false);

      const reopened = await readBundle(storedPath, passphrase);
      expect(reopened.raw).toEqual(bundle.raw);
      expect(reopened.events).toEqual(bundle.events);
      expect(reopened.manifest.lineage.raw_sha256).toBe(bundle.manifest.lineage.raw_sha256);
      expect(JSON.stringify(reopened.raw)).toContain(promptSentinel);
      expect(JSON.stringify(reopened.raw)).toContain(toolSentinel);
      expect(JSON.stringify(reopened.raw)).not.toContain("must-not-be-forwarded");

      const receiptPath = join(root, "capture-receipt.json");
      await writeCaptureReceipt(
        await prepareCaptureReceiptPath(receiptPath),
        makeCaptureReceipt({
          traceId: bundle.manifest.trace_id,
          host: "deepseek_harness",
          interfaceVersion: bundle.manifest.source.interface_version,
          status: "stored",
          reason: "CAPTURE_FINALIZED",
          hostExitCode: 0,
          stats: capture.captureStats(),
          terminalAt: "2026-08-22T00:00:00.000Z",
        }),
      );
      const receiptText = await readFile(receiptPath, "utf8");
      const receipt = JSON.parse(receiptText) as Record<string, unknown>;
      expect(receipt).toMatchObject({
        trace_id: bundle.manifest.trace_id,
        raw_event_count: bundle.raw.length,
        normalized_event_count: bundle.events.length,
        raw_lineage_sha256: bundle.manifest.lineage.raw_sha256,
        status: "stored",
      });
      for (const sentinel of [promptSentinel, toolSentinel, "inspect the owned fixture", "verified"]) {
        expect(receiptText).not.toContain(sentinel);
      }
    } finally {
      await collector.close().catch(() => undefined);
      await capture.abort().catch(() => undefined);
      if (lifecycleDispose !== null) await lifecycleDispose().catch(() => undefined);
      if (priorUrl === undefined) delete process.env.TRAJPACK_COLLECTOR_URL;
      else process.env.TRAJPACK_COLLECTOR_URL = priorUrl;
      if (priorToken === undefined) delete process.env.TRAJPACK_CAPTURE_TOKEN;
      else process.env.TRAJPACK_CAPTURE_TOKEN = priorToken;
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
