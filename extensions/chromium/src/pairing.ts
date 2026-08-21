export function validateCollectorBaseUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Collector URL is invalid");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) {
    throw new Error("Collector must be an explicit http://127.0.0.1:<random-port> URL");
  }
  // The collector is an ephemeral local server; port 0 ("ephemeral") is not
  // connectable and ports outside 1..65535 cannot exist. Reject them so a
  // stale or hand-edited URL fails closed instead of targeting a wrong port.
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Collector must use a real TCP port from 1 to 65535");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Collector URL must not contain credentials, a path, query, or fragment");
  }
  return url;
}

export function validatePairingNonce(nonce: string): string {
  if (!/^[A-Za-z0-9_-]{20,512}$/u.test(nonce)) {
    throw new Error("Pairing nonce must be a 20–512 character base64url value");
  }
  return nonce;
}
