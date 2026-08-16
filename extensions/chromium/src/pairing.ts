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
