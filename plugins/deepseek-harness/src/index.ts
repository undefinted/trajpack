import process from "node:process";
import type { Context } from "@deepseek-ai/cordis";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";

export const name = "trajpack";
export const harnessCompatibility = "0.1.0-rc.6";
export const sessionFormatVersion = 0;
export const interfaceVersion = "deepseek-harness@0.1.0-rc.6/session-event/0";

const MAX_EVENT_BYTES = 8 * 1024 * 1024;
export const queueLimits = Object.freeze({
  perSessionEvents: 1_024,
  perSessionBytes: 16 * 1024 * 1024,
  globalSessions: 1_024,
  globalEvents: 4_096,
  globalBytes: 64 * 1024 * 1024,
});

type JsonObject = Record<string, unknown>;

type HarnessContext = Pick<Context, "on" | "effect">;

interface Route {
  provider: string;
  model: string;
}

interface ForwardState {
  readonly session: object;
  readonly sessionId: string;
  /** First sequence actually delivered through the observable event feed. */
  readonly firstObservedSeq: number;
  /** Seed topology is immutable for one live session; compute it only once. */
  readonly boundaryMarker: { type: "session/end-seed"; seq: number } | null;
  route: Route | null;
  queue: Promise<void>;
  failure: unknown;
  pendingEvents: number;
  pendingBytes: number;
}

interface CollectorConfiguration {
  endpoint: URL;
  token: string;
}

interface CollectorSetup {
  configuration: CollectorConfiguration | null;
  failure: CollectorForwardError | null;
}

interface SerializedCapsule {
  body: string;
  bytes: number;
}

export interface HarnessCaptureController {
  /** Await all admitted events, or only the queue belonging to `session`. */
  flush(session?: unknown): Promise<void>;
  /** Aggregate in-memory plaintext queue usage; exposed for local diagnostics. */
  queueUsage(): Readonly<{ events: number; bytes: number }>;
  /** Number of session objects currently retained by an active forwarding state. */
  liveStateCount(): number;
}

export class CollectorForwardError extends Error {
  constructor(readonly status: number | null, message: string) {
    super(message);
    this.name = "CollectorForwardError";
  }
}

function record(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function safeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function loopbackUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
    return url.protocol === "http:" && loopback && url.username === "" && url.password === "" ? url : null;
  } catch {
    return null;
  }
}

function collectorSetup(): CollectorSetup {
  const collector = process.env.TRAJPACK_COLLECTOR_URL;
  const token = process.env.TRAJPACK_CAPTURE_TOKEN;
  // The wrapper capability is for this in-process observer only. Harness tools
  // execute as child processes, so leaving it in process.env would let an
  // untrusted workspace command inherit the collector bearer token and forge
  // provider-looking events. Consume it once during plugin boot, before any
  // agent turn starts, and keep only the parsed values in this closure.
  delete process.env.TRAJPACK_COLLECTOR_URL;
  delete process.env.TRAJPACK_CAPTURE_TOKEN;
  delete process.env.TRAJPACK_CAPTURE_HOST;
  if (collector === undefined && token === undefined) {
    return { configuration: null, failure: null };
  }
  if (typeof collector !== "string" || typeof token !== "string" || token.length === 0 || token.length > 4096) {
    return {
      configuration: null,
      failure: new CollectorForwardError(null, "Trajpack collector configuration is invalid"),
    };
  }
  const endpoint = loopbackUrl(collector);
  return endpoint === null
    ? {
        configuration: null,
        failure: new CollectorForwardError(null, "Trajpack collector URL must be an HTTP loopback origin"),
      }
    : { configuration: { endpoint, token }, failure: null };
}

function validEvent(value: unknown): value is JsonObject {
  const event = record(value);
  return event !== null &&
    text(event.type) !== null &&
    safeInteger(event.seq) !== null &&
    typeof event.time === "number" &&
    Number.isFinite(event.time) &&
    event.time >= 0 &&
    record(event.data) !== null &&
    (event.ignorable === undefined || event.ignorable === true);
}

function sessionIdentity(value: unknown): {
  session: JsonObject;
  header: JsonObject;
  sessionId: string;
  firstLiveSeq: number;
} | null {
  const session = record(value);
  const header = session === null ? null : record(session.header);
  const sessionId = session === null ? null : text(session.id) ?? (header === null ? null : text(header.id));
  const firstLiveSeq = session === null ? null : safeInteger(session.firstLiveSeq);
  if (
    session === null || header === null || sessionId === null || firstLiveSeq === null ||
    header.version !== sessionFormatVersion || (header.id !== undefined && header.id !== sessionId)
  ) return null;
  return { session, header, sessionId, firstLiveSeq };
}

function seedBoundaryMarker(
  session: JsonObject,
  firstLiveSeq: number,
): { type: "session/end-seed"; seq: number } | null {
  const events = Array.isArray(session.events) ? session.events : [];
  // This function belongs exclusively to ForwardState construction. The
  // official Session instance and its seed boundary are immutable for the
  // live lifecycle, so the backwards O(seed) lookup is paid once; capsule()
  // reads the cached marker in O(1) for every subsequent event.
  // The harness contract locates the LAST session/end-seed marker, which for a
  // resumed seed may sit at firstLiveSeq - 1 (a seed that already ended is not
  // re-marked). Only scanning events[firstLiveSeq] would miss it and report a
  // wrong live boundary.
  let boundaryMarker: { type: "session/end-seed"; seq: number } | null = null;
  for (let index = Math.min(firstLiveSeq, events.length - 1); index >= 0; index -= 1) {
    const marker = record(events[index]);
    if (marker?.type === "session/end-seed" && marker.seq === index && index <= firstLiveSeq) {
      boundaryMarker = { type: "session/end-seed" as const, seq: index };
      break;
    }
  }
  return boundaryMarker;
}

function routeFromEvent(event: JsonObject): Route | null {
  const data = record(event.data);
  if (data === null) return null;
  if (event.type === "request/header") {
    const header = record(data.header);
    const config = header === null ? null : record(header.config);
    const provider = config === null ? null : text(config.provider);
    const model = config === null ? null : text(config.model);
    return provider === null || model === null ? null : { provider, model };
  }
  if (event.type === "request/context") {
    const provider = text(data.provider);
    const model = text(data.model);
    return provider === null || model === null ? null : { provider, model };
  }
  if (event.type === "assistant/message") {
    const message = record(data.message);
    const source = message === null ? null : record(message.source);
    const provider = source?.kind === "model" ? text(source.provider) : null;
    const model = source?.kind === "model" ? text(source.model) : null;
    return provider === null || model === null ? null : { provider, model };
  }
  return null;
}

function capsule(state: ForwardState, identity: NonNullable<ReturnType<typeof sessionIdentity>>, event: JsonObject): JsonObject {
  state.route = routeFromEvent(event) ?? state.route;
  return {
    session_id: identity.sessionId,
    session_header: {
      version: sessionFormatVersion,
      id: identity.sessionId,
      first_live_seq: identity.firstLiveSeq,
      first_observed_seq: state.firstObservedSeq,
      unpublished_boundary_marker: state.boundaryMarker,
      seed_length: safeInteger(identity.header.seedLength),
      parent_session: text(identity.header.parentSession),
      origin: text(identity.header.origin),
      delegation_depth: safeInteger(identity.header.delegationDepth),
      agent_preset: text(identity.header.agentPreset),
    },
    route: state.route,
    event_id: `${identity.sessionId}:${String(event.seq)}`,
    timestamp: event.time,
    event,
  };
}

function serializeCapsule(payload: JsonObject): SerializedCapsule {
  let body: string;
  try {
    body = JSON.stringify(payload);
  } catch {
    throw new CollectorForwardError(null, "Trajpack capsule is not losslessly serializable");
  }
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > MAX_EVENT_BYTES) {
    throw new CollectorForwardError(null, "Trajpack capsule exceeds the bounded collector frame");
  }

  return { body, bytes };
}

async function forward(frame: SerializedCapsule, configuration: CollectorConfiguration): Promise<void> {
  let response: Response;
  try {
    response = await fetch(configuration.endpoint, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${configuration.token}`,
        "content-type": "application/json",
        "x-trajpack-host": "deepseek_harness",
        "x-trajpack-interface": interfaceVersion,
      },
      body: frame.body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(2500),
    });
  } catch {
    throw new CollectorForwardError(null, "Trajpack collector request failed");
  }
  if (!response.ok) {
    throw new CollectorForwardError(response.status, `Trajpack collector rejected the event with HTTP ${response.status}`);
  }
}

function failureFrom(states: Iterable<ForwardState>): unknown[] {
  return [...states].flatMap((state) => state.failure === null ? [] : [state.failure]);
}

function sanitizedTerminalFailure(failure: unknown): CollectorForwardError {
  const status = failure instanceof CollectorForwardError ? failure.status : null;
  return status === null
    ? new CollectorForwardError(null, "Trajpack collector forwarding failed")
    : new CollectorForwardError(status, `Trajpack collector rejected an event with HTTP ${status}`);
}

/**
 * Install the rc.6 durable observer. The official `session/event` feed is
 * observe-only, while `session/flush` is its awaited durability checkpoint.
 * Registering the async effect before the listeners makes Cordis remove event
 * admission first and await one final queue drain during profile disposal.
 */
export function apply(ctx: HarnessContext): HarnessCaptureController {
  const setup = collectorSetup();
  const configuration = setup.configuration;
  const bySession = new WeakMap<object, ForwardState>();
  const liveStates = new Set<ForwardState>();
  let terminalFailure: CollectorForwardError | null = setup.failure;
  let pendingEvents = 0;
  let pendingBytes = 0;

  const latchTerminalFailure = (failure: unknown): void => {
    terminalFailure ??= sanitizedTerminalFailure(failure);
  };

  const findState = (sessionValue: unknown): ForwardState | null => {
    const session = record(sessionValue);
    return session === null ? null : bySession.get(session) ?? null;
  };

  const drainStates = async (states: Iterable<ForwardState>): Promise<void> => {
    const snapshot = [...states];
    // `session/flush` is a durability barrier: events admitted while it runs
    // append a new queue tail that must also be awaited before draining.
    await Promise.all(snapshot.map(async (state) => {
      for (;;) {
        const tail = state.queue;
        await tail;
        if (tail === state.queue) break;
      }
    }));
    const failures = failureFrom(snapshot);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Trajpack collector drain failed");
  };

  const controller: HarnessCaptureController = {
    flush: async (sessionValue?: unknown) => {
      if (sessionValue === undefined) {
        await drainStates(liveStates);
        if (terminalFailure !== null) throw terminalFailure;
        return;
      }
      const state = findState(sessionValue);
      if (state !== null) await drainStates([state]);
      if (terminalFailure !== null) throw terminalFailure;
    },
    queueUsage: () => Object.freeze({ events: pendingEvents, bytes: pendingBytes }),
    liveStateCount: () => liveStates.size,
  };

  ctx.effect(() => async () => controller.flush(), "trajpack: drain collector queue");

  ctx.on("session/event", (sessionValue: Session, eventValue: SessionEvent) => {
    // Wrapper credentials exist before Harness starts. Keeping the unarmed
    // observer entirely inert avoids allocating a queue for ordinary sessions.
    if (configuration === null || terminalFailure !== null) return;
    const identity = sessionIdentity(sessionValue);
    if (identity === null || !validEvent(eventValue)) return;
    let state = bySession.get(identity.session);
    if (state === undefined) {
      if (liveStates.size >= queueLimits.globalSessions) {
        latchTerminalFailure(new CollectorForwardError(
          null,
          "Trajpack live session set exceeded its bounded capacity",
        ));
        return;
      }
      state = {
        session: identity.session,
        sessionId: identity.sessionId,
        firstObservedSeq: eventValue.seq as number,
        boundaryMarker: seedBoundaryMarker(identity.session, identity.firstLiveSeq),
        route: null,
        queue: Promise.resolve(),
        failure: null,
        pendingEvents: 0,
        pendingBytes: 0,
      };
      bySession.set(identity.session, state);
      liveStates.add(state);
    }
    if (state.failure !== null) return;
    const payload = capsule(state, identity, eventValue);
    let frame: SerializedCapsule;
    try {
      frame = serializeCapsule(payload);
    } catch (error) {
      state.failure ??= error;
      return;
    }
    const exceedsQueueLimit = state.pendingEvents + 1 > queueLimits.perSessionEvents
      || state.pendingBytes + frame.bytes > queueLimits.perSessionBytes
      || pendingEvents + 1 > queueLimits.globalEvents
      || pendingBytes + frame.bytes > queueLimits.globalBytes;
    if (exceedsQueueLimit) {
      state.failure ??= new CollectorForwardError(null, "Trajpack pending collector queue exceeded its bounded capacity");
      return;
    }
    state.pendingEvents += 1;
    state.pendingBytes += frame.bytes;
    pendingEvents += 1;
    pendingBytes += frame.bytes;
    state.queue = state.queue.then(async () => {
      try {
        if (state!.failure === null && terminalFailure === null) await forward(frame, configuration);
      } catch (error) {
        state!.failure ??= error;
      } finally {
        state!.pendingEvents -= 1;
        state!.pendingBytes -= frame.bytes;
        pendingEvents -= 1;
        pendingBytes -= frame.bytes;
      }
    });
  });

  ctx.on("session/flush", async (sessionValue: Session) => controller.flush(sessionValue));

  ctx.on("session/disposed", (sessionValue: Session) => {
    const state = findState(sessionValue);
    if (state === null) return;
    // Retain the session only until its admitted tail drains. A single fresh,
    // content-free error preserves the global durability failure without
    // retaining provider errors, payload closures, or the full session object.
    void state.queue.then(() => {
      if (state.failure !== null) latchTerminalFailure(state.failure);
    }, (failure: unknown) => {
      latchTerminalFailure(failure);
    }).finally(() => {
      liveStates.delete(state);
      bySession.delete(state.session);
    });
  });

  return controller;
}
