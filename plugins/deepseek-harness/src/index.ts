import process from "node:process";

export const name = "trajpack";
export const harnessCompatibility = "0.1.0-rc.6";
export const sessionFormatVersion = 0;
export const interfaceVersion = "deepseek-harness@0.1.0-rc.6/session-event/0";

const MAX_EVENT_BYTES = 8 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

interface HarnessContext {
  on(event: "session/event", listener: (session: unknown, event: unknown) => Promise<void>): unknown;
}

interface Route {
  provider: string | null;
  model: string | null;
}

const routes = new Map<string, Route>();
let forwardQueue: Promise<void> = Promise.resolve();

function record(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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
    Number.isSafeInteger(event.seq) &&
    (event.seq as number) >= 0 &&
    typeof event.time === "number" &&
    Number.isFinite(event.time) &&
    event.time >= 0 &&
    record(event.data) !== null &&
    (event.ignorable === undefined || event.ignorable === true);
}

function updateRoute(sessionId: string, event: JsonObject): Route | null {
  const data = record(event.data);
  if (event.type === "request/header" && data !== null) {
    const header = record(data.header);
    const config = header === null ? null : record(header.config);
    if (config !== null) {
      routes.set(sessionId, {
        provider: text(config.provider),
        model: text(config.model),
      });
    }
  }

  if (event.type === "assistant/message" && data !== null) {
    const message = record(data.message);
    const source = message === null ? null : record(message.source);
    if (source?.kind === "model") {
      routes.set(sessionId, {
        provider: text(source.provider),
        model: text(source.model),
      });
    }
  }
  return routes.get(sessionId) ?? null;
}

function capsule(sessionValue: unknown, eventValue: unknown): JsonObject | null {
  const session = record(sessionValue);
  const header = session === null ? null : record(session.header);
  const sessionId = session === null ? null : text(session.id) ?? (header === null ? null : text(header.id));
  if (
    session === null ||
    header === null ||
    sessionId === null ||
    header.version !== sessionFormatVersion ||
    (header.id !== undefined && header.id !== sessionId) ||
    !validEvent(eventValue)
  ) return null;

  const route = updateRoute(sessionId, eventValue);
  const result = {
    session_id: sessionId,
    session_header: {
      version: sessionFormatVersion,
      id: sessionId,
      parent_session: text(header.parentSession),
      origin: text(header.origin),
      delegation_depth: Number.isSafeInteger(header.delegationDepth) && (header.delegationDepth as number) >= 0
        ? header.delegationDepth
        : null,
      agent_preset: text(header.agentPreset),
    },
    route,
    event_id: `${sessionId}:${String(eventValue.seq)}`,
    timestamp: eventValue.time,
    event: eventValue,
  };
  if (eventValue.type === "turn/end") routes.delete(sessionId);
  return result;
}

async function forward(payload: JsonObject): Promise<void> {
  const collector = process.env.TRAJPACK_COLLECTOR_URL;
  const token = process.env.TRAJPACK_CAPTURE_TOKEN;
  if (typeof collector !== "string" || typeof token !== "string" || token.length === 0 || token.length > 4096) return;
  const endpoint = loopbackUrl(collector);
  if (endpoint === null) return;

  let body: string;
  try {
    body = JSON.stringify(payload);
  } catch {
    return;
  }
  if (Buffer.byteLength(body, "utf8") > MAX_EVENT_BYTES) return;

  try {
    await fetch(endpoint, {
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
    // Capture is observational and must never interrupt Harness.
  }
}

export function apply(ctx: HarnessContext): void {
  ctx.on("session/event", (session, event) => {
    const payload = capsule(session, event);
    if (payload === null) return Promise.resolve();
    forwardQueue = forwardQueue.then(() => forward(payload), () => forward(payload));
    return forwardQueue;
  });
}

/** Allows tests and compatible Harness shutdown paths to await queued events. */
export function flush(): Promise<void> {
  return forwardQueue;
}
