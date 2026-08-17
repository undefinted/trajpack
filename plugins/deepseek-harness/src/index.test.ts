import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  apply,
  flush,
  harnessCompatibility,
  interfaceVersion,
  name,
  sessionFormatVersion,
} from "./index.js";

type Listener = (session: unknown, event: unknown) => Promise<void>;

function install(): { listener: Listener; on: ReturnType<typeof vi.fn> } {
  let listener: Listener | null = null;
  const on = vi.fn((event: "session/event", callback: Listener) => {
    expect(event).toBe("session/event");
    listener = callback;
  });
  apply({ on });
  if (listener === null) throw new Error("listener was not installed");
  return { listener, on };
}

function session(version = 0): Record<string, unknown> {
  return {
    id: "session-1",
    header: {
      version,
      id: "session-1",
      parentSession: "parent-1",
      origin: "subagent",
      delegationDepth: 1,
      agentPreset: "researcher",
    },
    privateTranscript: "MUST_NOT_BE_SERIALIZED",
  };
}

function event(type: string, seq: number, data: Record<string, unknown>): Record<string, unknown> {
  return { type, seq, time: 1_787_000_000_000 + seq, data };
}

afterEach(() => {
  delete process.env.TRAJPACK_COLLECTOR_URL;
  delete process.env.TRAJPACK_CAPTURE_TOKEN;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DeepSeek Harness rc.6 plugin", () => {
  it("declares an installable dsh bundle and exact compatibility pin", async () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const manifest = JSON.parse(await readFile(`${root}/package.json`, "utf8")) as Record<string, unknown>;
    const dsh = manifest.dsh as { bundle?: { patch?: string } };
    expect(name).toBe("trajpack");
    expect(harnessCompatibility).toBe("0.1.0-rc.6");
    expect(sessionFormatVersion).toBe(0);
    expect(interfaceVersion).toBe("deepseek-harness@0.1.0-rc.6/session-event/0");
    expect(dsh.bundle?.patch).toBe("./cordis.patch.yml");
    expect(await readFile(`${root}/cordis.patch.yml`, "utf8")).toContain("@trajpack/deepseek-harness-plugin");
  });

  it("subscribes exactly once using the official (session, event) callback", async () => {
    const { listener, on } = install();
    expect(on).toHaveBeenCalledTimes(1);
    await listener(session(), event("turn/start", 0, { turn: 0 }));
    await flush();
  });

  it("is a no-op without an explicit wrapper token and rejects format drift", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { listener } = install();
    await listener(session(), event("user/message", 0, { message: { role: "user", content: "secret" } }));
    await listener(session(1), event("turn/start", 1, { turn: 0 }));
    await listener(session(), { type: "turn/start", seq: -1, time: 1, data: { turn: 0 } });
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards only the durable event, minimal topology, and resolved model route", async () => {
    process.env.TRAJPACK_COLLECTOR_URL = "http://127.0.0.1:43199/ingest";
    process.env.TRAJPACK_CAPTURE_TOKEN = "one-session-token";
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const { listener } = install();
    const liveSession = session();
    liveSession.self = liveSession;

    await listener(liveSession, event("request/header", 0, {
      header: { config: { provider: "deepseek-official", model: "deepseek-reasoner" } },
      reason: "turn",
    }));
    await listener(liveSession, event("assistant/chunk", 1, {
      turn: 0,
      step: 0,
      chunk: { type: "reasoning-delta", index: 0, text: "inspect" },
    }));
    await flush();

    expect(fetch).toHaveBeenCalledTimes(2);
    const [endpoint, init] = fetch.mock.calls[1] as unknown as [URL, RequestInit];
    expect(endpoint.href).toBe("http://127.0.0.1:43199/ingest");
    expect(new Headers(init.headers).get("x-trajpack-interface")).toBe(interfaceVersion);
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      session_id: "session-1",
      session_header: { version: 0, parent_session: "parent-1", origin: "subagent" },
      route: { provider: "deepseek-official", model: "deepseek-reasoner" },
      event_id: "session-1:1",
      event: { type: "assistant/chunk", seq: 1 },
    });
    expect(JSON.stringify(payload)).not.toContain("MUST_NOT_BE_SERIALIZED");
    expect(payload).not.toHaveProperty("channel_arguments");
  });

  it("refuses non-loopback collectors", async () => {
    process.env.TRAJPACK_COLLECTOR_URL = "https://collector.example/ingest";
    process.env.TRAJPACK_CAPTURE_TOKEN = "token";
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { listener } = install();
    await listener(session(), event("turn/start", 0, { turn: 0 }));
    await flush();
    expect(fetch).not.toHaveBeenCalled();
  });
});
