import { constants, realpathSync } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const HOST = "gemini_cli";
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

function loopbackUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
    return url.protocol === "http:" && loopback && url.username === "" && url.password === "" ? url : null;
  } catch {
    return null;
  }
}

function runtimeDirectory() {
  return join(homedir(), ".trajpack", "runtime");
}

async function armConfiguration() {
  const directUrl = process.env.TRAJPACK_COLLECTOR_URL;
  const directToken = process.env.TRAJPACK_CAPTURE_TOKEN;
  if (directUrl && directToken) return { url: directUrl, token: directToken, cwd: null };
  const directory = runtimeDirectory();
  const path = join(directory, `arm-${HOST}.json`);
  try {
    const directoryDetails = await lstat(directory);
    if (!directoryDetails.isDirectory() || directoryDetails.isSymbolicLink()) return null;
    if (process.platform !== "win32"
      && (directoryDetails.uid !== process.getuid?.() || (directoryDetails.mode & 0o077) !== 0)) return null;
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 8192) return null;
    if (process.platform !== "win32"
      && (before.uid !== process.getuid?.() || (before.mode & 0o077) !== 0)) return null;
    const noFollow = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
    // Open with O_NOFOLLOW and fstat the fd so a same-user symlink swap between
    // the directory check and the read cannot redirect the descriptor source.
    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
      const details = await handle.stat();
      if (!details.isFile() || details.dev !== before.dev || details.ino !== before.ino
        || details.size !== before.size || details.size > 8192) return null;
      if (process.platform !== "win32"
        && (details.uid !== process.getuid?.() || (details.mode & 0o077) !== 0)) return null;
      const descriptor = JSON.parse(await handle.readFile({ encoding: "utf8" }));
      const expiresAt = Date.parse(descriptor.expires_at);
      if (descriptor.version !== 1 || descriptor.host !== HOST
        || typeof descriptor.url !== "string" || typeof descriptor.token !== "string") return null;
      if (typeof descriptor.cwd !== "string" || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
      return { url: descriptor.url, token: descriptor.token, cwd: descriptor.cwd };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function readJsonInput() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) return null;
    chunks.push(chunk);
  }
  try {
    const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    return { body, value: JSON.parse(body) };
  } catch {
    return null;
  }
}

function sameDirectory(left, right) {
  // realpath returns the actual on-disk canonical path, so case-insensitive
  // APFS mounts compare equal regardless of input case while genuinely distinct
  // directories on case-sensitive volumes stay distinct.
  const normalize = (value) => process.platform === "win32" ? realpathSync(value).toLowerCase() : realpathSync(value);
  try { return normalize(left) === normalize(right); } catch { return false; }
}

const configuration = await armConfiguration();
const endpoint = configuration ? loopbackUrl(configuration.url) : null;
if (configuration && endpoint && configuration.token.length > 0 && configuration.token.length <= 4096) {
  const input = await readJsonInput();
  if (input && (!configuration.cwd || (typeof input.value.cwd === "string" && sameDirectory(input.value.cwd, configuration.cwd)))) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${configuration.token}`,
          "content-type": "application/json",
          "x-trajpack-host": HOST,
          "x-trajpack-interface": "gemini-cli-hook/1"
        },
        body: input.body,
        cache: "no-store",
        redirect: "manual",
        signal: AbortSignal.timeout(2500)
      });
      if (!response.ok) {
        process.stderr.write(`trajpack ${HOST} hook: collector rejected the event with HTTP ${response.status}\n`);
        process.exitCode = 1;
      }
    } catch {
      // An unavailable collector is an observational no-op; reachable HTTP rejections are reported above.
    }
  }
}

// Gemini CLI requires command hooks to emit one JSON object and no other
// stdout. This response changes no prompt, model, tool, or control decision.
process.stdout.write('{"suppressOutput":true}\n');
