import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RawEnvelope, TraceBundle, TrajectoryEvent } from "@trajpack/schema";
import {
  canonicalJson,
  consentReceipt,
  createManifest,
  defaultSource,
  listTraceIds,
  loadTrace,
  saveNewTrace,
  scanStructured,
  sha256,
  type TrajpackPaths,
} from "@trajpack/core";
import { CaptureSession } from "./capture-session.js";
import { startIngestServer } from "./ingest-server.js";
import { startReviewServer } from "./review-server.js";

const extensionOrigin = `chrome-extension://${"a".repeat(32)}`;
const pageOrigin = "https://agent.example.test";

function makeBrowserEnvelope(sourceOrigin = pageOrigin): RawEnvelope {
  const authorization = {
    basis: "site_owner",
    evidence_ref: "LicenseRef-owned-test-site",
    attested_by: "test-owner",
    attested_at: "2026-08-16T00:00:00.000Z",
    expires_at: "2099-08-16T00:00:00.000Z",
  };
  const recipeWithoutHash = {
    schema_version: "selector-recipe/0.1",
    recipe_id: "owned-test-site",
    name: "Owned test site",
    origin: sourceOrigin,
    version: "1",
    authorization,
    selectors: { root: "main", item: "article", content: "p", role_attribute: "data-role" },
    role_map: { user: "user", assistant: "assistant" },
    expectations: { root_count: 1, min_items: 1, max_items: 10, content_nodes_per_item: 1, max_text_characters_per_item: 10_000 },
    fingerprint_probes: [{ selector: "main", min_matches: 1, max_matches: 1 }],
  };
  const recipeSha256 = sha256(canonicalJson(recipeWithoutHash));
  const recipe = { ...recipeWithoutHash, recipe_sha256: recipeSha256 };
  const payload = {
    record_kind: "authorized_dom_capture",
    provenance: {
      capture_method: "authorized_dom",
      source_origin: sourceOrigin,
      selector_recipe_id: recipe.recipe_id,
      selector_recipe_version: recipe.version,
      selector_recipe_sha256: recipeSha256,
      authorization,
      visible_text_only: true,
      fidelity: "C",
    },
    capture: {
      schema_version: "authorized-dom/0.1",
      captured_at: "2026-08-16T00:00:00.000Z",
      page: { origin: sourceOrigin, title: "Owned agent" },
      recipe,
      observed_fingerprint: [{ selector: "main", matches: 1 }],
      messages: [
        { sequence: 0, role: "user", text: "owned prompt sentinel" },
        { sequence: 1, role: "assistant", text: "owned response sentinel" },
      ],
    },
  };
  return {
    envelope_version: "raw/0.1",
    adapter: "browser",
    adapter_version: "0.1.0",
    interface_version: "authorized-dom/0.1",
    captured_at: "2026-08-16T00:00:00.000Z",
    sequence: 0,
    source_event_id: null,
    session_id: null,
    turn_id: null,
    payload_sha256: sha256(canonicalJson(payload)),
    payload,
  };
}

function makeHookEnvelope(
  sessionId: string | null,
  hookEventName: string,
  cwd: string,
  sequence: number,
): RawEnvelope {
  const payload = {
    session_id: sessionId,
    cwd,
    hook_event_name: hookEventName,
  };
  return {
    envelope_version: "raw/0.1",
    adapter: "codex",
    adapter_version: "0.1.0",
    interface_version: "codex-hook/1",
    captured_at: "2026-08-16T00:00:00.000Z",
    sequence,
    source_event_id: null,
    session_id: sessionId,
    turn_id: null,
    payload_sha256: sha256(canonicalJson(payload)),
    payload,
  };
}

function makeClaudeHookEnvelope(
  sessionId: string,
  hookEventName: string,
  cwd: string,
  sequence: number,
  transcriptPath?: string,
): RawEnvelope {
  const payload = {
    session_id: sessionId,
    cwd,
    hook_event_name: hookEventName,
    ...(transcriptPath === undefined ? {} : { transcript_path: transcriptPath }),
  };
  return {
    envelope_version: "raw/0.1",
    adapter: "claude_code",
    adapter_version: "0.1.0",
    interface_version: "claude-hook/1",
    captured_at: "2026-08-16T00:00:00.000Z",
    sequence,
    source_event_id: null,
    session_id: sessionId,
    turn_id: null,
    payload_sha256: sha256(canonicalJson(payload)),
    payload,
  };
}

const temporaryRoots: string[] = [];

function testPaths(root: string): TrajpackPaths {
  return {
    data: root,
    vault: join(root, "vault"),
    runtime: join(root, "runtime"),
    tombstones: join(root, "tombstones"),
  };
}

function makeStructuredSecretBundle(): TraceBundle {
  const createdAt = new Date("2026-08-16T00:00:00.000Z");
  const source = defaultSource("deepseek_harness", "self_hosted");
  source.interface_version = "security-fixture/1";
  source.model_id = "local-open-model";
  const rights = {
    source_license_expression: "Apache-2.0",
    model_license_chain: ["Apache-2.0"],
    input_rights_basis: "owned" as const,
    third_party_content: "none" as const,
    rights_holder: "fixture-owner",
  };
  const manifest = createManifest({
    source,
    accountType: "self_hosted",
    rights,
    consentReceipt: consentReceipt("security-test", "fixture", createdAt),
    consentPurposes: ["archive", "review", "model_training"],
    writtenPermissionRef: "fixture-permission",
    targetModelOwner: "fixture-owner",
    targetProduct: "local-open-model",
    competitive: "no",
    createdAt,
  });
  const event: TrajectoryEvent = {
    record_type: "event",
    event_id: "evt_structured_secrets",
    trace_id: manifest.trace_id,
    span_id: "0123456789abcdef",
    parent_span_id: null,
    links: [{
      trace_id: manifest.trace_id,
      span_id: "fedcba9876543210",
      relation: "Cookie: session=structured-cookie-sentinel",
    }],
    sequence: 0,
    started_at: createdAt.toISOString(),
    ended_at: createdAt.toISOString(),
    event_type: "message",
    actor: "assistant",
    status: "ok",
    source_event_id: "fixture-event-0",
    source_session_id: "fixture-session",
    source_turn_id: "fixture-turn",
    source_step_id: null,
    content: [
      {
        ordinal: 0,
        type: "text",
        mime_type: "text/plain",
        value: "visible response",
        blob_ref: null,
        sha256: sha256("visible response"),
        sensitivity: "internal",
        redaction_status: "passed",
        review_disposition: "include",
        reasoning: null,
        rights_override: null,
      },
      {
        ordinal: 1,
        type: "file_ref",
        mime_type: "application/octet-stream",
        value: null,
        blob_ref: "vault-blob://opaque-content",
        sha256: sha256("opaque-content"),
        sensitivity: "confidential",
        redaction_status: "passed",
        review_disposition: "include",
        reasoning: null,
        rights_override: null,
      },
    ],
    tool: {
      call_id: "fixture-call",
      name: "fixture-tool",
      arguments: { nested: { header: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" } },
      result: { token: "sk-proj-abcdefghijklmnopqrstuv" },
      exit_code: 0,
    },
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      reasoning_tokens: 0,
      cache_read_tokens: 0,
      latency_ms: 1,
      cost_usd: 0,
    },
    metadata: { customer: { email: "structured-secret@example.test" } },
    review_disposition: "include",
  };
  return { manifest, events: [event], raw: [] };
}

async function reviewerHeaders(running: Awaited<ReturnType<typeof startReviewServer>>): Promise<Record<string, string>> {
  const launch = new URL(running.launchUrl);
  const reviewerToken = new URLSearchParams(launch.hash.replace(/^#/, "")).get("reviewer_token");
  expect(reviewerToken).toBeTruthy();
  const host = launch.host;
  const launched = await running.server.inject({
    method: "GET",
    url: `${launch.pathname}${launch.search}`,
    headers: { host },
  });
  expect(launched.statusCode).toBe(200);
  const setCookie = launched.headers["set-cookie"];
  const cookieValue = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const cookie = cookieValue?.split(";", 1)[0];
  expect(cookie).toBeTruthy();
  const bootstrap = await running.server.inject({
    method: "GET",
    url: "/api/v1/review/bootstrap",
    headers: { host, cookie: cookie!, "x-trajpack-reviewer-token": reviewerToken! },
  });
  expect(bootstrap.statusCode).toBe(200);
  const csrf = (bootstrap.json() as { csrf_token: string }).csrf_token;
  return {
    host,
    cookie: cookie!,
    origin: running.url,
    "x-requested-with": "trajpack-reviewer",
    "x-trajpack-csrf": csrf,
    "x-trajpack-reviewer-token": reviewerToken!,
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("loopback collectors", () => {
  it("binds an armed collector to its first non-empty session and only ends for that session", async () => {
    const cwd = "C:\\owned\\repo";
    const ingest = vi.fn(async () => true);
    const onSessionEnd = vi.fn();
    const running = await startIngestServer({
      host: "codex",
      token: "capture-token",
      session: { ingest } as unknown as CaptureSession,
      expectedCwd: cwd,
      bindNextSession: true,
      onSessionEnd,
    });
    const headers = {
      authorization: "Bearer capture-token",
      "x-trajpack-host": "codex",
      "x-trajpack-interface": "codex-hook/1",
    };
    const post = (envelope: RawEnvelope) => running.server.inject({
      method: "POST",
      url: "/v1/hooks/events",
      headers,
      payload: envelope.payload,
    });

    try {
      const missing = await post(makeHookEnvelope(null, "SessionStart", cwd, 0));
      expect(missing.statusCode).toBe(422);
      expect(missing.json()).toEqual({ error: "session_id_required" });

      expect((await post(makeHookEnvelope("session-a", "SessionStart", cwd, 1))).statusCode).toBe(202);

      const crossTalk = await post(makeHookEnvelope("session-b", "SessionEnd", cwd, 2));
      expect(crossTalk.statusCode).toBe(409);
      expect(crossTalk.json()).toEqual({ error: "session_mismatch" });
      expect(onSessionEnd).not.toHaveBeenCalled();

      expect((await post(makeHookEnvelope("session-a", "PostToolUse", cwd, 3))).statusCode).toBe(202);
      expect((await post(makeHookEnvelope("session-a", "SessionEnd", cwd, 4))).statusCode).toBe(202);
      expect((await post(makeHookEnvelope("session-a", "SessionEnd", cwd, 5))).statusCode).toBe(202);
      expect(onSessionEnd).toHaveBeenCalledTimes(1);
      expect(ingest).toHaveBeenCalledTimes(4);
    } finally {
      await running.close();
    }
  });

  it("keeps wrapper capture mode unbound and accepts events without a session id", async () => {
    const ingest = vi.fn(async () => true);
    const running = await startIngestServer({
      host: "codex",
      token: "capture-token",
      session: { ingest } as unknown as CaptureSession,
      expectedCwd: "C:\\owned\\repo",
    });
    try {
      const response = await running.server.inject({
        method: "POST",
        url: "/v1/hooks/events",
        headers: {
          authorization: "Bearer capture-token",
          "x-trajpack-host": "codex",
          "x-trajpack-interface": "codex-hook/1",
        },
        payload: makeHookEnvelope(null, "PostToolUse", "C:\\owned\\repo", 0).payload,
      });
      expect(response.statusCode).toBe(202);
      expect(ingest).toHaveBeenCalledTimes(1);
      const missingCwd = await running.server.inject({
        method: "POST",
        url: "/v1/hooks/events",
        headers: {
          authorization: "Bearer capture-token",
          "x-trajpack-host": "codex",
          "x-trajpack-interface": "codex-hook/1",
        },
        payload: { hook_event_name: "Stop", session_id: "session" },
      });
      expect(missingCwd.statusCode).toBe(422);
      expect(missingCwd.json()).toEqual({ error: "cwd_required" });
    } finally {
      await running.close();
    }
  });

  it("honors the authenticated hook interface header for raw host payloads", async () => {
    const ingest = vi.fn(async () => true);
    const running = await startIngestServer({
      host: "codex",
      token: "capture-token",
      session: { ingest } as unknown as CaptureSession,
    });
    try {
      const response = await running.server.inject({
        method: "POST",
        url: "/v1/hooks/events",
        headers: {
          authorization: "Bearer capture-token",
          "x-trajpack-host": "codex",
          "x-trajpack-interface": "codex-hook/1",
        },
        payload: {
          session_id: "hook-session",
          hook_event_name: "PreToolUse",
          tool_name: "shell",
          tool_input: { command: "pwd" },
        },
      });
      expect(response.statusCode).toBe(202);
      const ingested = ingest.mock.calls[0]?.[0] as RawEnvelope;
      expect(ingested.interface_version).toBe("codex-hook/1");
      expect(ingested.session_id).toBe("hook-session");

      const unknown = await running.server.inject({
        method: "POST",
        url: "/v1/hooks/events",
        headers: {
          authorization: "Bearer capture-token",
          "x-trajpack-host": "codex",
          "x-trajpack-interface": "codex-hook/999",
        },
        payload: { hook_event_name: "Stop" },
      });
      expect(unknown.statusCode).toBe(422);
      expect(ingest).toHaveBeenCalledTimes(1);

      const directEnvelope = await running.server.inject({
        method: "POST",
        url: "/v1/hooks/events",
        headers: {
          authorization: "Bearer capture-token",
          "x-trajpack-host": "codex",
          "x-trajpack-interface": "codex-hook/1",
        },
        payload: makeHookEnvelope("outer-session", "SessionEnd", "C:\\forged", 9),
      });
      expect(directEnvelope.statusCode).toBe(422);
      expect(directEnvelope.json()).toEqual({ error: "raw_hook_envelope_rejected" });
      expect(ingest).toHaveBeenCalledTimes(1);
    } finally {
      await running.close();
    }
  });

  it("stores a matching Claude SessionEnd transcript as base64 opaque bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-claude-opaque-test-"));
    temporaryRoots.push(root);
    const transcriptRoot = join(root, ".claude", "projects");
    const project = join(transcriptRoot, "owned-repo");
    const sessionId = "11111111-2222-3333-4444-555555555555";
    const transcriptPath = join(project, `${sessionId}.jsonl`);
    const transcriptBytes = Buffer.from("not-json\n{\"private_schema\":true}\n", "utf8");
    await mkdir(project, { recursive: true });
    await writeFile(transcriptPath, transcriptBytes);

    const cwd = join(root, "repo");
    const ingest = vi.fn(async () => true);
    const onSessionEnd = vi.fn();
    const running = await startIngestServer({
      host: "claude_code",
      token: "capture-token",
      session: { ingest } as unknown as CaptureSession,
      expectedCwd: cwd,
      bindNextSession: true,
      claudeTranscriptRoot: transcriptRoot,
      onSessionEnd,
    });
    const post = (envelope: RawEnvelope) => running.server.inject({
      method: "POST",
      url: "/v1/hooks/events",
      headers: {
        authorization: "Bearer capture-token",
        "x-trajpack-host": "claude_code",
        "x-trajpack-interface": "claude-hook/1",
      },
      payload: envelope.payload,
    });

    try {
      const unauthorized = await running.server.inject({
        method: "POST",
        url: "/v1/hooks/events",
        headers: { authorization: "Bearer wrong-token" },
        payload: makeClaudeHookEnvelope(sessionId, "SessionEnd", cwd, 0, transcriptPath).payload,
      });
      expect(unauthorized.statusCode).toBe(401);
      expect(ingest).not.toHaveBeenCalled();

      expect((await post(makeClaudeHookEnvelope(sessionId, "SessionStart", cwd, 0))).statusCode).toBe(202);
      expect((await post(makeClaudeHookEnvelope(sessionId, "SessionEnd", cwd, 1, transcriptPath))).statusCode).toBe(202);
      expect(ingest).toHaveBeenCalledTimes(3);
      expect(onSessionEnd).toHaveBeenCalledTimes(1);

      const artifact = ingest.mock.calls[2]?.[0] as RawEnvelope;
      expect(artifact.interface_version).toBe("claude-transcript-opaque/1");
      expect(artifact.session_id).toBe(sessionId);
      const payload = artifact.payload as Record<string, unknown>;
      expect(Buffer.from(payload.bytes_base64 as string, "base64")).toEqual(transcriptBytes);
      expect(payload.sha256).toBe(sha256(transcriptBytes));
      expect(payload.size).toBe(transcriptBytes.length);
      expect(payload.not_parsed).toBe(true);
      expect(payload.path_hmac).toMatch(/^[a-f0-9]{64}$/);
      expect(Object.keys(payload)).not.toContain("transcript_path");
      expect(Object.values(payload)).not.toContain(transcriptPath);

      const forged = await post(artifact);
      expect(forged.statusCode).toBe(422);
      expect(forged.json()).toEqual({ error: "hook_event_name_required" });
      expect(ingest).toHaveBeenCalledTimes(3);
    } finally {
      await running.close();
    }
  });

  it("rejects Claude transcript paths outside the configured root and invalid basenames", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-claude-boundary-test-"));
    temporaryRoots.push(root);
    const transcriptRoot = join(root, ".claude", "projects");
    const project = join(transcriptRoot, "owned-repo");
    const outside = join(root, "outside");
    await Promise.all([mkdir(project, { recursive: true }), mkdir(outside, { recursive: true })]);
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const outsidePath = join(outside, `${sessionId}.jsonl`);
    const mismatchedPath = join(project, "different-session.jsonl");
    const wrongExtension = join(project, `${sessionId}.txt`);
    await Promise.all([
      writeFile(outsidePath, "outside"),
      writeFile(mismatchedPath, "mismatch"),
      writeFile(wrongExtension, "wrong extension"),
    ]);

    const ingest = vi.fn(async () => true);
    const running = await startIngestServer({
      host: "claude_code",
      token: "capture-token",
      session: { ingest } as unknown as CaptureSession,
      bindNextSession: true,
      claudeTranscriptRoot: transcriptRoot,
    });
    const post = (envelope: RawEnvelope) => running.server.inject({
      method: "POST",
      url: "/v1/hooks/events",
      headers: {
        authorization: "Bearer capture-token",
        "x-trajpack-host": "claude_code",
        "x-trajpack-interface": "claude-hook/1",
      },
      payload: envelope.payload,
    });
    try {
      await post(makeClaudeHookEnvelope(sessionId, "SessionStart", root, 0));
      await post(makeClaudeHookEnvelope(sessionId, "SessionEnd", root, 1, outsidePath));
      await post(makeClaudeHookEnvelope(sessionId, "SessionEnd", root, 2, mismatchedPath));
      await post(makeClaudeHookEnvelope(sessionId, "SessionEnd", root, 3, wrongExtension));
      expect(ingest).toHaveBeenCalledTimes(4);
      expect(ingest.mock.calls.every(([envelope]) =>
        (envelope as RawEnvelope).interface_version === "claude-hook/1")).toBe(true);
    } finally {
      await running.close();
    }
  });

  it("rejects symlinked and oversized Claude transcripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-claude-file-test-"));
    temporaryRoots.push(root);
    const transcriptRoot = join(root, ".claude", "projects");
    const project = join(transcriptRoot, "owned-repo");
    await mkdir(project, { recursive: true });

    const attempts = [
      { sessionId: "symlink-session", kind: "symlink" as const },
      { sessionId: "oversized-session", kind: "oversized" as const },
    ];
    for (const [index, attempt] of attempts.entries()) {
      let path = join(project, `${attempt.sessionId}.jsonl`);
      if (attempt.kind === "symlink") {
        // A directory junction is available without Windows developer-mode
        // privileges and still exercises rejection of a linked path segment.
        const targetDirectory = join(project, "symlink-target");
        const linkedDirectory = join(project, "symlink-directory");
        await mkdir(targetDirectory);
        await writeFile(join(targetDirectory, `${attempt.sessionId}.jsonl`), "target");
        await symlink(targetDirectory, linkedDirectory, "junction");
        path = join(linkedDirectory, `${attempt.sessionId}.jsonl`);
      } else {
        await writeFile(path, "12345");
      }

      const ingest = vi.fn(async () => true);
      const running = await startIngestServer({
        host: "claude_code",
        token: `capture-token-${index}`,
        session: { ingest } as unknown as CaptureSession,
        bindNextSession: true,
        claudeTranscriptRoot: transcriptRoot,
        maxClaudeTranscriptBytes: attempt.kind === "oversized" ? 4 : 1024,
      });
      const post = (envelope: RawEnvelope) => running.server.inject({
        method: "POST",
        url: "/v1/hooks/events",
        headers: {
          authorization: `Bearer capture-token-${index}`,
          "x-trajpack-host": "claude_code",
          "x-trajpack-interface": "claude-hook/1",
        },
        payload: envelope.payload,
      });
      try {
        await post(makeClaudeHookEnvelope(attempt.sessionId, "SessionStart", root, 0));
        await post(makeClaudeHookEnvelope(attempt.sessionId, "SessionEnd", root, 1, path));
        expect(ingest).toHaveBeenCalledTimes(2);
      } finally {
        await running.close();
      }
    }
  });

  it("binds browser upload to one nonce, extension origin, and recipe digest", async () => {
    const envelope = makeBrowserEnvelope();
    const ingest = vi.fn(async () => true);
    const running = await startIngestServer({
      host: "browser",
      token: "unused-token",
      pairingNonce: "pairing-nonce-abcdefghijklmnop",
      session: { ingest } as unknown as CaptureSession,
    });
    const headers = {
      origin: extensionOrigin,
      "x-trajpack-pairing-nonce": "pairing-nonce-abcdefghijklmnop",
      "x-trajpack-recipe-sha256": (envelope.payload as { provenance: { selector_recipe_sha256: string } }).provenance.selector_recipe_sha256,
    };
    try {
      expect((await running.server.inject({ method: "POST", url: "/v1/browser/captures", headers: { ...headers, "x-trajpack-recipe-sha256": "0".repeat(64) }, payload: { envelope } })).statusCode).toBe(409);
      const accepted = await running.server.inject({ method: "POST", url: "/v1/browser/captures", headers, payload: { envelope } });
      expect(accepted.statusCode).toBe(201);
      expect(accepted.headers["access-control-allow-origin"]).toBe(extensionOrigin);
      expect((await running.server.inject({ method: "POST", url: "/v1/browser/captures", headers, payload: { envelope } })).statusCode).toBe(403);
      expect(ingest).toHaveBeenCalledTimes(1);
    } finally {
      await running.close();
    }
  });

  it("encrypts an authorized DOM capture immediately through the reviewer pairing route", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-review-test-"));
    temporaryRoots.push(root);
    const paths: TrajpackPaths = {
      data: root,
      vault: join(root, "vault"),
      runtime: join(root, "runtime"),
      tombstones: join(root, "tombstones"),
    };
    const passphrase = "correct horse battery staple";
    const running = await startReviewServer({ passphrase, paths, reviewerDist: join(root, "missing-dist") });
    const envelope = makeBrowserEnvelope();
    const recipeSha256 = (envelope.payload as { provenance: { selector_recipe_sha256: string } }).provenance.selector_recipe_sha256;
    const headers = {
      host: new URL(running.url).host,
      origin: extensionOrigin,
      "x-trajpack-pairing-nonce": running.browserPairingNonce,
      "x-trajpack-recipe-sha256": recipeSha256,
    };
    try {
      const response = await running.server.inject({ method: "POST", url: "/v1/browser/captures", headers, payload: { envelope } });
      expect(response.statusCode).toBe(201);
      const traceIds = await listTraceIds(paths);
      expect(traceIds).toHaveLength(1);
      const bundle = await loadTrace(traceIds[0]!, passphrase, paths);
      expect(bundle.manifest.source.capture_method).toBe("authorized_dom");
      expect(bundle.manifest.account_contract.order_form_or_written_permission_ref).toBe("LicenseRef-owned-test-site");
      expect(bundle.events.map((event) => event.content[0]?.value)).toEqual(["owned prompt sentinel", "owned response sentinel"]);
    } finally {
      await running.close();
    }
  }, 30_000);

  it("rejects commercial AI web origins without consuming the browser pairing nonce", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-commercial-origin-test-"));
    temporaryRoots.push(root);
    const running = await startReviewServer({
      passphrase: "correct horse battery staple",
      paths: testPaths(root),
      reviewerDist: join(root, "missing-dist"),
    });
    const blockedOrigins = [
      "https://chatgpt.com",
      "https://share.chatgpt.com",
      "https://chat.openai.com",
      "https://claude.ai",
      "https://workspace.claude.ai",
      "https://chat.deepseek.com",
      "https://platform.deepseek.com",
    ];
    try {
      for (const blockedOrigin of blockedOrigins) {
        const envelope = makeBrowserEnvelope(blockedOrigin);
        const recipeSha256 = (envelope.payload as { provenance: { selector_recipe_sha256: string } }).provenance.selector_recipe_sha256;
        const response = await running.server.inject({
          method: "POST",
          url: "/v1/browser/captures",
          headers: {
            host: new URL(running.url).host,
            origin: extensionOrigin,
            "x-trajpack-pairing-nonce": running.browserPairingNonce,
            "x-trajpack-recipe-sha256": recipeSha256,
          },
          payload: { envelope },
        });
        expect(response.statusCode, blockedOrigin).toBe(409);
        expect(response.json(), blockedOrigin).toMatchObject({ error: { code: "commercial_origin_blocked" } });
      }

      const allowedEnvelope = makeBrowserEnvelope();
      const nonceStillActive = await running.server.inject({
        method: "POST",
        url: "/v1/browser/captures",
        headers: {
          host: new URL(running.url).host,
          origin: extensionOrigin,
          "x-trajpack-pairing-nonce": running.browserPairingNonce,
          "x-trajpack-recipe-sha256": "0".repeat(64),
        },
        payload: { envelope: allowedEnvelope },
      });
      expect(nonceStillActive.statusCode).toBe(409);
      expect(nonceStillActive.json()).toEqual({ error: "recipe_hash_mismatch" });
    } finally {
      await running.close();
    }
  });

  it("detects structured secrets and clears tool payloads with hash-correct event redaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-review-security-test-"));
    temporaryRoots.push(root);
    const paths = testPaths(root);
    const passphrase = "correct horse battery staple";
    const bundle = makeStructuredSecretBundle();
    await saveNewTrace(bundle, passphrase, paths);
    const running = await startReviewServer({ passphrase, paths, reviewerDist: join(root, "missing-dist") });
    try {
      const headers = await reviewerHeaders(running);
      const before = await running.server.inject({
        method: "GET",
        url: `/api/v1/review/traces/${bundle.manifest.trace_id}`,
        headers,
      });
      expect(before.statusCode).toBe(200);
      const beforeDetail = before.json() as {
        revision: number;
        checks: Array<{ check_id: string; summary: string; affected_event_ids: string[] }>;
      };
      const structuredCheck = beforeDetail.checks.find((check) => check.check_id === "privacy-structured-evt_structured_secrets");
      expect(structuredCheck).toMatchObject({
        summary: "4 potential secrets remain in 4 structured fields",
        affected_event_ids: ["evt_structured_secrets"],
      });
      expect(canonicalJson(structuredCheck)).not.toContain("abcdefghijklmnopqrstuvwxyz");
      expect(canonicalJson(structuredCheck)).not.toContain("structured-secret@example.test");

      const replacement = "[MASKED FOR TRAINING]";
      const patched = await running.server.inject({
        method: "PATCH",
        url: `/api/v1/review/traces/${bundle.manifest.trace_id}/events/evt_structured_secrets`,
        headers,
        payload: {
          expected_revision: beforeDetail.revision,
          disposition: "redact",
          redaction_replacement: replacement,
        },
      });
      expect(patched.statusCode).toBe(200);
      const stored = await loadTrace(bundle.manifest.trace_id, passphrase, paths);
      const event = stored.events[0]!;
      expect(event.content).toHaveLength(2);
      for (const part of event.content) {
        expect(part.value).toBe(replacement);
        expect(part.blob_ref).toBeNull();
        expect(part.sha256).toBe(sha256(replacement));
        expect(part.redaction_status).toBe("redacted");
      }
      expect(event.tool?.arguments).toBe(replacement);
      expect(event.tool?.result).toBe(replacement);
      expect(canonicalJson(event.tool)).not.toContain("abcdefghijklmnopqrstuvwxyz");
      expect(canonicalJson(event.tool)).not.toContain("sk-proj-");
      expect(scanStructured(event.metadata)).toEqual([]);
      expect(scanStructured(event.links)).toEqual([]);
    } finally {
      await running.close();
    }
  }, 60_000);
});
