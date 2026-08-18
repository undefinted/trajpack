import process from "node:process";

export const name = "trajpack";
export const harnessCompatibility = "0.1.0-rc.6";
export const sessionFormatVersion = 0;
export const interfaceVersion = "deepseek-harness@0.1.0-rc.6/session-event/0";

const MAX_EVENT_BYTES = 8 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

interface HarnessContext {
  on(event: "session/event", listener: (session: unknown, event: unknown) => void): unknown;
  on(event: "session/flush", listener: (session: unknown) => Promise<void>): unknown;
  on(event: "session/disposed", listener: (session: unknown) => void): unknown;
  effect(effect: () => () => Promise<void>, label?: string): unknown;
}

interface Route {
  provider: string;
  model: string;
}

interface ForwardState {
  readonly session: object;
  readonly sessionId: string;
  /** First sequence actually delivered through the observable event feed. */
  readonly firstObservedSeq: number;
  route: Route | null;
  queue: Promise<void>;
  failure: unknown;
}

export interface HarnessCaptureController {
  /** Await all admitted events, or only the queue belonging to `session`. */
  flush(session?: unknown): Promise<void>;
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
  boundaryMarker: { type: "session/end-seed"; seq: number } | null;
} | null {
  const session = record(value);
  const header = session === null ? null : record(session.header);
  const sessionId = session === null ? null : text(session.id) ?? (header === null ? null : text(header.id));
  const firstLiveSeq = session === null ? null : safeInteger(session.firstLiveSeq);
  if (
    session === null || header === null || sessionId === null || firstLiveSeq === null ||
    header.version !== sessionFormatVersion || (header.id !== undefined && header.id !== sessionId)
  ) return null;
  const events = Array.isArray(session.events) ? session.events : [];
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
  return { session, header, sessionId, firstLiveSeq, boundaryMarker };
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
      unpublished_boundary_marker: identity.boundaryMarker,
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

async function forward(payload: JsonObject): Promise<void> {
  const collector = process.env.TRAJPACK_COLLECTOR_URL;
  const token = process.env.TRAJPACK_CAPTURE_TOKEN;
  // No-op only when the plugin is entirely unarmed. Present-but-invalid
  // configuration must fail the durability checkpoint instead of silently
  // producing an empty vault with a successful session/flush.
  if (collector === undefined && token === undefined) return;
  if (typeof collector !== "string" || typeof token !== "string"
    || token.length === 0 || token.length > 4096) {
    throw new CollectorForwardError(null, "Trajpack collector configuration is invalid");
  }
  const endpoint = loopbackUrl(collector);
  if (endpoint === null) {
    throw new CollectorForwardError(null, "Trajpack collector URL must be an HTTP loopback origin");
  }

  let body: string;
  try {
    body = JSON.stringify(payload);
  } catch {
    throw new CollectorForwardError(null, "Trajpack capsule is not losslessly serializable");
  }
  if (Buffer.byteLength(body, "utf8") > MAX_EVENT_BYTES) {
    throw new CollectorForwardError(null, "Trajpack capsule exceeds the bounded collector frame");
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
        "x-trajpack-host": "deepseek_harness",
        "x-trajpack-interface": interfaceVersion,
      },
      body,
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

/**
 * Install the rc.6 durable observer. The official `session/event` feed is
 * observe-only, while `session/flush` is its awaited durability checkpoint.
 * Registering the async effect before the listeners makes Cordis remove event
 * admission first and await one final queue drain during profile disposal.
 */
export function apply(ctx: HarnessContext): HarnessCaptureController {
  const bySession = new WeakMap<object, ForwardState>();
  const liveStates = new Set<ForwardState>();

  const findState = (sessionValue: unknown): ForwardState | null => {
    const session = record(sessionValue);
    return session === null ? null : bySession.get(session) ?? null;
  };

  const drainStates = async (states: Iterable<ForwardState>): Promise<void> => {
    const snapshot = [...states];
    // `session/flush` is a durability barrier: events admitted while it runs
    // append a new queue tail that must also be awaited before draining.
    for (const state of snapshot) {
      for (;;) {
        const tail = state.queue;
        await tail;
        if (tail === state.queue) break;
      }
    }
    const failures = failureFrom(snapshot);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Trajpack collector drain failed");
  };

  const controller: HarnessCaptureController = {
    flush: async (sessionValue?: unknown) => {
      if (sessionValue === undefined) return drainStates(liveStates);
      const state = findState(sessionValue);
      if (state !== null) await drainStates([state]);
    },
  };

  ctx.effect(() => async () => controller.flush(), "trajpack: drain collector queue");

  ctx.on("session/event", (sessionValue, eventValue) => {
    const identity = sessionIdentity(sessionValue);
    if (identity === null || !validEvent(eventValue)) return;
    let state = bySession.get(identity.session);
    if (state === undefined) {
      state = {
        session: identity.session,
        sessionId: identity.sessionId,
        firstObservedSeq: eventValue.seq as number,
        route: null,
        queue: Promise.resolve(),
        failure: null,
      };
      bySession.set(identity.session, state);
      liveStates.add(state);
    }
    const payload = capsule(state, identity, eventValue);
    state.queue = state.queue.then(async () => {
      try {
        await forward(payload);
      } catch (error) {
        state!.failure ??= error;
      }
    });
  });

  ctx.on("session/flush", async sessionValue => controller.flush(sessionValue));

  ctx.on("session/disposed", (sessionValue) => {
    const state = findState(sessionValue);
    if (state === null) return;
    // session/disposed is observe-only. Remove successful state after its tail
    // drains, but retain a failed state so the owning Cordis dispose effect can
    // still surface the failure instead of silently forgetting it.
    void drainStates([state]).then(() => {
      liveStates.delete(state);
      bySession.delete(state.session);
    }, () => undefined);
  });

  return controller;
}
