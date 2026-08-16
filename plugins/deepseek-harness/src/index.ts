import process from "node:process";

export const name = "trajpack";
export const harnessCompatibility = "0.1.0-rc.6";

const MAX_EVENT_BYTES = 16 * 1024 * 1024;

interface HarnessContext {
  on(event: "session/event", listener: (...args: unknown[]) => Promise<void>): unknown;
}

let forwardQueue: Promise<void> = Promise.resolve();

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

async function forward(args: unknown[]): Promise<void> {
  const collector = process.env.TRAJPACK_COLLECTOR_URL;
  const token = process.env.TRAJPACK_CAPTURE_TOKEN;
  if (typeof collector !== "string" || typeof token !== "string" || token.length === 0 || token.length > 4096) return;
  const endpoint = loopbackUrl(collector);
  if (endpoint === null) return;

  let body: string;
  try {
    body = JSON.stringify(args.length === 1 ? args[0] : { channel_arguments: args });
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
        "x-trajpack-interface": "deepseek-harness@0.1.0-rc.6/session-event/0"
      },
      body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(2500)
    });
  } catch {
    // Session capture is observational and must never interrupt Harness.
  }
}

export function apply(ctx: HarnessContext): void {
  ctx.on("session/event", (...args: unknown[]) => {
    forwardQueue = forwardQueue.then(() => forward(args), () => forward(args));
    return forwardQueue;
  });
}

/** Allows compatible Harness runtimes/tests to await every queued event. */
export function flush(): Promise<void> {
  return forwardQueue;
}
