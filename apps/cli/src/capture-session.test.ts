import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyJsonLine } from "@trajpack/adapters";
import {
  consentReceipt,
  canonicalJson,
  createManifest,
  defaultSource,
  readBundle,
  sha256,
  vaultPath,
  type TrajpackPaths,
} from "@trajpack/core";
import {
  CaptureBackpressureError,
  CaptureLimitError,
  CaptureSession,
  HarnessCaptureIntegrityError,
  reconcileObservedHarnessTeacher,
} from "./capture-session.js";

const ownedRights = {
  source_license_expression: "Apache-2.0",
  model_license_chain: ["Apache-2.0"],
  input_rights_basis: "owned" as const,
  third_party_content: "none" as const,
  rights_holder: "fixture-owner",
};

function deepseekCapsule(
  seq: number,
  type: string,
  data: Record<string, unknown>,
  options: {
    firstLiveSeq?: number;
    firstObservedSeq?: number;
    seedLength?: number;
    boundaryMarker?: boolean;
    provider?: string;
    model?: string;
    sessionId?: string;
    parentSession?: string | null;
    delegationDepth?: number;
    ignorable?: boolean;
  } = {},
) {
  const sessionId = options.sessionId ?? "session-1";
  const payload = {
    session_id: sessionId,
    session_header: {
      version: 0,
      id: sessionId,
      first_live_seq: options.firstLiveSeq ?? 0,
      first_observed_seq: options.firstObservedSeq ?? options.firstLiveSeq ?? 0,
      unpublished_boundary_marker: options.boundaryMarker
        ? { type: "session/end-seed", seq: options.firstLiveSeq ?? 0 }
        : null,
      seed_length: options.seedLength ?? options.firstLiveSeq ?? 0,
      parent_session: options.parentSession ?? null,
      delegation_depth: options.delegationDepth ?? 0,
      origin: null,
    },
    route: options.provider && options.model
      ? { provider: options.provider, model: options.model }
      : null,
    event_id: `${sessionId}:${seq}`,
    timestamp: 1_787_000_000_000 + seq,
    event: {
      type,
      seq,
      time: 1_787_000_000_000 + seq,
      data,
      ...(options.ignorable ? { ignorable: true } : {}),
    },
  };
  const envelope = classifyJsonLine("deepseek_harness", JSON.stringify(payload), seq);
  if (envelope === null) throw new Error("DeepSeek test capsule was rejected");
  return envelope;
}

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
    const envelope = deepseekCapsule(0, "request/header", {
      header: {
        config: { provider: "deepseek-official", model: "deepseek-reasoner", temperature: 0 },
        system: "research fixture",
        tools: [],
      },
      reason: "initial",
    }, { provider: "deepseek-official", model: "deepseek-reasoner" });
    const reconciled = reconcileObservedHarnessTeacher(source, [envelope]);
    expect(reconciled.authenticity_evidence_ref)
      .toMatch(/^native-request-header:sha256:[a-f0-9]{64}$/u);
    expect(reconciled.model_id).toBe("deepseek-reasoner");
    expect(() => reconcileObservedHarnessTeacher({ ...source, model_id: "different-model" }, [envelope]))
      .toThrow("does not match");
    const conflictingRoute = deepseekCapsule(0, "request/header", {
      header: { config: { provider: "deepseek-official", model: "deepseek-reasoner" } },
      reason: "initial",
    }, { provider: "openai", model: "deepseek-reasoner" });
    expect(() => reconcileObservedHarnessTeacher(source, [conflictingRoute])).toThrow("route conflicts");
    expect(reconcileObservedHarnessTeacher(source, []).authenticity_evidence_ref).toBeNull();

    const selfHosted = defaultSource("deepseek_harness", "self_hosted");
    selfHosted.model_id = "local-r1";
    selfHosted.model_snapshot_or_weights_digest = `sha256:${"a".repeat(64)}`;
    selfHosted.authenticity_evidence_ref = `local-model-artifact:${selfHosted.model_snapshot_or_weights_digest}`;
    const localHeader = deepseekCapsule(0, "request/header", {
      header: { config: { provider: "ollama", model: "local-r1" } },
      reason: "initial",
    }, { provider: "ollama", model: "local-r1" });
    expect(reconcileObservedHarnessTeacher(selfHosted, [localHeader]).authenticity_evidence_ref)
      .toBe(selfHosted.authenticity_evidence_ref);
    const remoteHeader = deepseekCapsule(0, "request/header", {
      header: { config: { provider: "openai", model: "local-r1" } },
      reason: "initial",
    }, { provider: "openai", model: "local-r1" });
    expect(() => reconcileObservedHarnessTeacher(selfHosted, [remoteHeader]))
      .toThrow("provider does not match");

    const childHeader = deepseekCapsule(0, "request/header", {
      header: { config: { provider: "openai", model: "gpt-child" } },
      reason: "subagent",
    }, {
      provider: "openai",
      model: "gpt-child",
      sessionId: "child-session",
      parentSession: "session-1",
      delegationDepth: 1,
    });
    const heterogeneous = reconcileObservedHarnessTeacher(source, [envelope, childHeader]);
    expect(heterogeneous.provider).toBe("deepseek");
    expect(heterogeneous.model_id).toBe("deepseek-reasoner");

    const switchedRootHeader = deepseekCapsule(1, "request/header", {
      header: { config: { provider: "openai", model: "gpt-root-epoch-2" } },
      reason: "user-switch",
    }, { provider: "openai", model: "gpt-root-epoch-2" });
    const switched = reconcileObservedHarnessTeacher(source, [envelope, switchedRootHeader]);
    expect(switched.provider).toBe("deepseek");
    expect(switched.model_id).toBe("deepseek-reasoner");
    expect(switched.authenticity_evidence_ref).toMatch(/^native-request-header:sha256:[a-f0-9]{64}$/u);
  });

  it("quarantines a live Harness sequence gap before canonical resequencing", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dsh-seq-gap-"));
    const paths: TrajpackPaths = {
      data: root,
      vault: join(root, "vault"),
      runtime: join(root, "runtime"),
      tombstones: join(root, "tombstones"),
    };
    const manifest = createManifest({
      source: defaultSource("deepseek_harness", "deepseek"),
      accountType: "api",
      rights: ownedRights,
      consentReceipt: consentReceipt("deepseek_harness", root),
      consentPurposes: ["archive", "research", "capture"],
    });
    const session = await CaptureSession.create("deepseek_harness", manifest, "test-passphrase", paths);
    try {
      expect(await session.ingest(deepseekCapsule(0, "turn/start", { turn: 0 }))).toBe(true);
      await expect(session.ingest(deepseekCapsule(2, "turn/end", {
        turn: 0,
        reason: "completed",
      }))).rejects.toMatchObject({
        name: "HarnessCaptureIntegrityError",
        reason: "HARNESS_SEQUENCE_GAP",
      } satisfies Partial<HarnessCaptureIntegrityError>);
      await session.abort();
      await expect(stat(vaultPath(manifest.trace_id, paths))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await session.abort().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("archives unknown ignorable Harness extensions but rejects unknown required records", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dsh-ignorable-"));
    const paths: TrajpackPaths = {
      data: root,
      vault: join(root, "vault"),
      runtime: join(root, "runtime"),
      tombstones: join(root, "tombstones"),
    };
    const makeManifest = (receipt: string) => {
      const source = defaultSource("deepseek_harness", "deepseek");
      source.model_id = "deepseek-reasoner";
      return createManifest({
        source,
        accountType: "api",
        rights: ownedRights,
        consentReceipt: consentReceipt("deepseek_harness", receipt),
        consentPurposes: ["archive", "research", "capture"],
      });
    };
    const acceptedManifest = makeManifest(`${root}-accepted`);
    const accepted = await CaptureSession.create("deepseek_harness", acceptedManifest, "test-passphrase", paths);
    try {
      expect(await accepted.ingest(deepseekCapsule(0, "request/header", {
        header: { config: { provider: "deepseek-official", model: "deepseek-reasoner" }, tools: [] },
      }, { provider: "deepseek-official", model: "deepseek-reasoner" }))).toBe(true);
      expect(await accepted.ingest(deepseekCapsule(1, "plugin/telemetry", { counter: 1 }, {
        provider: "deepseek-official",
        model: "deepseek-reasoner",
        ignorable: true,
      }))).toBe(true);
      await accepted.finalize();
      const stored = await readBundle(vaultPath(acceptedManifest.trace_id, paths), "test-passphrase");
      expect(stored.events).toContainEqual(expect.objectContaining({
        event_type: "evaluation",
        metadata: expect.objectContaining({
          durable_event_type: "plugin/telemetry",
          opaque_durable_event: true,
        }),
      }));

      const rejectedManifest = makeManifest(`${root}-required`);
      const rejected = await CaptureSession.create("deepseek_harness", rejectedManifest, "test-passphrase", paths);
      expect(await rejected.ingest(deepseekCapsule(0, "future/required", {}, {
        sessionId: "required-session",
      }))).toBe(true);
      await expect(rejected.finalize()).rejects.toThrow("Unsupported or incomplete deepseek_harness event");
      await rejected.abort().catch(() => undefined);
    } finally {
      await accepted.abort().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("accepts the documented seeded boundary marker omission but no larger live-prefix gap", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dsh-seeded-boundary-"));
    const paths: TrajpackPaths = {
      data: root,
      vault: join(root, "vault"),
      runtime: join(root, "runtime"),
      tombstones: join(root, "tombstones"),
    };
    const manifest = createManifest({
      source: defaultSource("deepseek_harness", "deepseek"),
      accountType: "api",
      rights: ownedRights,
      consentReceipt: consentReceipt("deepseek_harness", root),
      consentPurposes: ["archive", "research", "capture"],
    });
    const accepted = await CaptureSession.create("deepseek_harness", manifest, "test-passphrase", paths);
    try {
      expect(await accepted.ingest(deepseekCapsule(6, "turn/start", { turn: 1 }, {
        firstLiveSeq: 5,
        firstObservedSeq: 6,
        seedLength: 5,
        boundaryMarker: true,
      }))).toBe(true);
      await accepted.abort();

      const rejectedManifest = createManifest({
        source: defaultSource("deepseek_harness", "deepseek"),
        accountType: "api",
        rights: ownedRights,
        consentReceipt: consentReceipt("deepseek_harness", `${root}-rejected`),
        consentPurposes: ["archive", "research", "capture"],
      });
      const rejected = await CaptureSession.create("deepseek_harness", rejectedManifest, "test-passphrase", paths);
      await expect(rejected.ingest(deepseekCapsule(7, "turn/start", { turn: 1 }, {
        firstLiveSeq: 5,
        firstObservedSeq: 7,
        seedLength: 5,
        sessionId: "session-gap",
      }))).rejects.toMatchObject({ reason: "HARNESS_CAPSULE_INVALID" });
      await rejected.abort();
    } finally {
      await accepted.abort().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts an idempotent Harness retry but quarantines a conflicting duplicate", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dsh-seq-conflict-"));
    const paths: TrajpackPaths = {
      data: root,
      vault: join(root, "vault"),
      runtime: join(root, "runtime"),
      tombstones: join(root, "tombstones"),
    };
    const manifest = createManifest({
      source: defaultSource("deepseek_harness", "deepseek"),
      accountType: "api",
      rights: ownedRights,
      consentReceipt: consentReceipt("deepseek_harness", root),
      consentPurposes: ["archive", "research", "capture"],
    });
    const session = await CaptureSession.create("deepseek_harness", manifest, "test-passphrase", paths);
    const first = deepseekCapsule(5, "turn/start", { turn: 1 }, { firstLiveSeq: 5 });
    try {
      expect(await session.ingest(first)).toBe(true);
      expect(await session.ingest(first)).toBe(false);
      await expect(session.ingest(deepseekCapsule(
        5,
        "turn/start",
        { turn: 999 },
        { firstLiveSeq: 5 },
      ))).rejects.toMatchObject({ reason: "HARNESS_SEQUENCE_CONFLICT" });
      await session.abort();
      await expect(stat(vaultPath(manifest.trace_id, paths))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await session.abort().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
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
      expect(reopened.manifest.lineage.raw_sha256).toBe(sha256(canonicalJson(reopened.raw)));
      expect(reopened.events.length).toBeGreaterThan(0);
    } finally {
      await session.abort().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("bounds pending direct ingestion without poisoning already-admitted work", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-capture-session-backpressure-"));
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
      { maxPendingIngest: 2 },
    );
    const envelope = (sequence: number) => classifyJsonLine("codex", JSON.stringify({
      type: "item.completed",
      item: { id: `answer-${sequence}`, type: "agent_message", text: `answer ${sequence}` },
    }), sequence)!;
    try {
      const first = session.ingest(envelope(0));
      const second = session.ingest(envelope(1));
      await expect(session.ingest(envelope(2))).rejects.toBeInstanceOf(CaptureBackpressureError);
      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
      // A released queue slot accepts new work; transient pressure is not a
      // capture-integrity failure and does not poison the session.
      await expect(session.ingest(envelope(2))).resolves.toBe(true);
      await session.abort();
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
