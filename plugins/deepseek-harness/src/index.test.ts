import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  apply,
  CollectorForwardError,
  harnessCompatibility,
  interfaceVersion,
  name,
  sessionFormatVersion,
  type HarnessCaptureController,
} from "./index.js";

type EventListener = (session: unknown, event: unknown) => void;
type FlushListener = (session: unknown) => Promise<void>;
type DisposedListener = (session: unknown) => void;

function install(): {
  controller: HarnessCaptureController;
  eventListener: EventListener;
  flushListener: FlushListener;
  disposedListener: DisposedListener;
  lifecycleDispose: () => Promise<void>;
  on: ReturnType<typeof vi.fn>;
  effect: ReturnType<typeof vi.fn>;
} {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  let lifecycleDispose: (() => Promise<void>) | null = null;
  const on = vi.fn((event: string, callback: (...args: unknown[]) => unknown) => {
    listeners.set(event, callback);
  });
  const effect = vi.fn((registration: () => () => Promise<void>) => {
    lifecycleDispose = registration();
  });
  const controller = apply({ on, effect } as unknown as Parameters<typeof apply>[0]);
  const eventListener = listeners.get("session/event");
  const flushListener = listeners.get("session/flush");
  const disposedListener = listeners.get("session/disposed");
  if (!eventListener || !flushListener || !disposedListener || lifecycleDispose === null) {
    throw new Error("plugin lifecycle was not installed");
  }
  return {
    controller,
    eventListener: eventListener as EventListener,
    flushListener: flushListener as FlushListener,
    disposedListener: disposedListener as DisposedListener,
    lifecycleDispose,
    on,
    effect,
  };
}

function session(version = 0, firstLiveSeq = 0): Record<string, unknown> {
  const events = firstLiveSeq > 0 ? Array.from({ length: firstLiveSeq + 1 }) : [];
  if (firstLiveSeq > 0) {
    events[firstLiveSeq] = { type: "session/end-seed", seq: firstLiveSeq, time: 1, data: {} };
  }
  return {
    id: "session-1",
    firstLiveSeq,
    events,
    header: {
      version,
      id: "session-1",
      seedLength: firstLiveSeq,
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

  it("owns the official event, flush, disposed, and Cordis teardown lifecycle", async () => {
    const installed = install();
    expect(installed.on.mock.calls.map((call) => call[0])).toEqual([
      "session/event",
      "session/flush",
      "session/disposed",
    ]);
    expect(installed.effect).toHaveBeenCalledTimes(1);
    installed.eventListener(session(), event("turn/start", 0, { turn: 0 }));
    await installed.flushListener(session());
    await installed.controller.flush();
  });

  it("is a no-op without an explicit wrapper token and rejects format drift", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const installed = install();
    installed.eventListener(session(), event("user/message", 0, {
      message: { role: "user", content: "secret" },
    }));
    installed.eventListener(session(1), event("turn/start", 1, { turn: 0 }));
    installed.eventListener(session(), { type: "turn/start", seq: -1, time: 1, data: { turn: 0 } });
    await installed.controller.flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards the durable event, live-sequence boundary, topology, and resolved route", async () => {
    process.env.TRAJPACK_COLLECTOR_URL = "http://127.0.0.1:43199/ingest";
    process.env.TRAJPACK_CAPTURE_TOKEN = "one-session-token";
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const installed = install();
    const liveSession = session();
    liveSession.self = liveSession;

    installed.eventListener(liveSession, event("request/header", 0, {
      header: { config: { provider: "deepseek-official", model: "deepseek-reasoner" } },
      reason: "initial",
    }));
    installed.eventListener(liveSession, event("assistant/chunk", 1, {
      turn: 0,
      step: 0,
      chunk: { type: "reasoning-delta", index: 0, text: "inspect" },
    }));
    await installed.flushListener(liveSession);

    expect(fetch).toHaveBeenCalledTimes(2);
    const [endpoint, init] = fetch.mock.calls[1] as unknown as [URL, RequestInit];
    expect(endpoint.href).toBe("http://127.0.0.1:43199/ingest");
    expect(new Headers(init.headers).get("x-trajpack-interface")).toBe(interfaceVersion);
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      session_id: "session-1",
      session_header: {
        version: 0,
        first_live_seq: 0,
        first_observed_seq: 0,
        seed_length: 0,
        parent_session: "parent-1",
        origin: "subagent",
      },
      route: { provider: "deepseek-official", model: "deepseek-reasoner" },
      event_id: "session-1:1",
      event: { type: "assistant/chunk", seq: 1 },
    });
    expect(JSON.stringify(payload)).not.toContain("MUST_NOT_BE_SERIALIZED");
    expect(payload).not.toHaveProperty("channel_arguments");
  });

  it("records the first event actually observable after a seeded lifecycle boundary", async () => {
    process.env.TRAJPACK_COLLECTOR_URL = "http://127.0.0.1:43199/ingest";
    process.env.TRAJPACK_CAPTURE_TOKEN = "one-session-token";
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const installed = install();
    const seeded = session(0, 5);

    // rc.6 may consume firstLiveSeq for session/end-seed without publishing
    // that lifecycle marker through session/event. The first callback is then
    // exactly one sequence above the live boundary.
    installed.eventListener(seeded, event("turn/start", 6, { turn: 1 }));
    await installed.flushListener(seeded);

    const [, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      session_header: {
        first_live_seq: 5,
        first_observed_seq: 6,
        unpublished_boundary_marker: { type: "session/end-seed", seq: 5 },
        seed_length: 5,
      },
      event: { seq: 6 },
    });
  });

  it("treats a non-2xx response as a failed durability checkpoint", async () => {
    process.env.TRAJPACK_COLLECTOR_URL = "http://127.0.0.1:43199/ingest";
    process.env.TRAJPACK_CAPTURE_TOKEN = "one-session-token";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 409 })));
    const installed = install();
    const liveSession = session();
    installed.eventListener(liveSession, event("turn/start", 0, { turn: 0 }));

    await expect(installed.flushListener(liveSession)).rejects.toMatchObject({
      name: "CollectorForwardError",
      status: 409,
    } satisfies Partial<CollectorForwardError>);
    await expect(installed.lifecycleDispose()).rejects.toThrow("HTTP 409");
  });

  it("drains an admitted tail event through the Cordis dispose effect", async () => {
    process.env.TRAJPACK_COLLECTOR_URL = "http://127.0.0.1:43199/ingest";
    process.env.TRAJPACK_CAPTURE_TOKEN = "one-session-token";
    let release!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })));
    const installed = install();
    installed.eventListener(session(), event("turn/end", 0, { turn: 0, reason: "completed" }));

    let drained = false;
    const pending = installed.lifecycleDispose().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release(new Response(null, { status: 202 }));
    await pending;
    expect(drained).toBe(true);
  });

  it("refuses non-loopback collectors", async () => {
    process.env.TRAJPACK_COLLECTOR_URL = "https://collector.example/ingest";
    process.env.TRAJPACK_CAPTURE_TOKEN = "token";
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const installed = install();
    installed.eventListener(session(), event("turn/start", 0, { turn: 0 }));
    await installed.controller.flush();
    expect(fetch).not.toHaveBeenCalled();
  });
});
