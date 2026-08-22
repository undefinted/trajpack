import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  canonicalJson,
  consentReceipt,
  createManifest,
  defaultSource,
  vaultPath,
} from "../packages/core/dist/index.js";
import { DEEPSEEK_HARNESS_INTERFACE_VERSION } from "../packages/adapters/dist/index.js";
import { CaptureSession } from "../apps/cli/dist/capture-session.js";
import { startIngestServer } from "../apps/cli/dist/ingest-server.js";

const MiB = 1024 * 1024;
const DEFAULTS = Object.freeze({
  events: 10_000,
  sessions: 16,
  concurrency: 8,
  collectorConcurrency: 4,
  payloadBytes: 512,
});
const CI_DEFAULTS = Object.freeze({
  events: 128,
  sessions: 8,
  concurrency: 4,
  collectorConcurrency: 2,
  payloadBytes: 256,
});
const CAPS = Object.freeze({
  events: 100_000,
  sessions: 1_024,
  concurrency: 64,
  payloadBytes: 64 * 1024,
  logicalBytes: 96 * MiB,
  retries: 64,
});

class BenchmarkFailure extends Error {
  constructor(code) {
    super(code);
    this.name = "BenchmarkFailure";
    this.code = code;
  }
}

function fail(code) {
  throw new BenchmarkFailure(code);
}

function integerOption(name, value, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`INVALID_${name.toUpperCase().replaceAll("-", "_")}`);
  }
  return parsed;
}

function parseArguments(argv) {
  const ci = argv.includes("--ci");
  const defaults = ci ? CI_DEFAULTS : DEFAULTS;
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--ci") continue;
    if (!argument.startsWith("--")) fail("INVALID_ARGUMENT");
    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals);
    const value = equals === -1 ? argv[++index] : argument.slice(equals + 1);
    if (value === undefined || value.startsWith("--")) fail("MISSING_OPTION_VALUE");
    if (values.has(name)) fail("DUPLICATE_OPTION");
    values.set(name, value);
  }
  const supported = new Set([
    "events", "sessions", "concurrency", "collector-concurrency", "payload-bytes",
  ]);
  for (const name of values.keys()) if (!supported.has(name)) fail("UNKNOWN_OPTION");

  const options = {
    ci,
    events: integerOption("events", values.get("events") ?? defaults.events, 1, CAPS.events),
    sessions: integerOption("sessions", values.get("sessions") ?? defaults.sessions, 1, CAPS.sessions),
    concurrency: integerOption(
      "concurrency",
      values.get("concurrency") ?? defaults.concurrency,
      1,
      CAPS.concurrency,
    ),
    collectorConcurrency: integerOption(
      "collector-concurrency",
      values.get("collector-concurrency") ?? defaults.collectorConcurrency,
      1,
      CAPS.concurrency,
    ),
    payloadBytes: integerOption(
      "payload-bytes",
      values.get("payload-bytes") ?? defaults.payloadBytes,
      128,
      CAPS.payloadBytes,
    ),
  };
  if (options.sessions > options.events) fail("SESSIONS_EXCEED_EVENTS");
  if (options.concurrency > options.sessions) fail("CONCURRENCY_EXCEEDS_SESSIONS");
  if (options.events * (options.payloadBytes + 4_096) > CAPS.logicalBytes) {
    fail("CONFIGURATION_EXCEEDS_LOGICAL_BYTE_CAP");
  }
  return options;
}

function pathsFor(root) {
  return {
    data: root,
    vault: join(root, "vault"),
    runtime: join(root, "runtime"),
    tombstones: join(root, "tombstones"),
  };
}

function expectedEventsForSession(totalEvents, sessionCount, sessionIndex) {
  return Math.floor(totalEvents / sessionCount) + (sessionIndex < totalEvents % sessionCount ? 1 : 0);
}

function syntheticCapsule(sessionIndex, sourceSequence, payloadBytes, sentinel) {
  const sessionId = `benchmark-session-${String(sessionIndex).padStart(4, "0")}`;
  const prefix = `${sentinel}:${sessionIndex}:${sourceSequence}:`;
  if (prefix.length > payloadBytes) fail("PAYLOAD_TOO_SMALL_FOR_SENTINEL");
  const text = `${prefix}${"x".repeat(payloadBytes - prefix.length)}`;
  const timestamp = 1_787_000_000_000 + sourceSequence;
  return {
    session_id: sessionId,
    session_header: {
      version: 0,
      id: sessionId,
      first_live_seq: 0,
      first_observed_seq: 0,
      unpublished_boundary_marker: null,
      seed_length: 0,
      parent_session: null,
      delegation_depth: 0,
      origin: "trajpack-collector-benchmark",
    },
    route: {
      provider: "self_hosted",
      model: "synthetic-owned-model",
    },
    event_id: `${sessionId}:${sourceSequence}`,
    timestamp,
    event: {
      type: "feedback/record",
      seq: sourceSequence,
      time: timestamp,
      data: {
        turn: `turn-${sourceSequence}`,
        benchmark_owned_text: text,
      },
    },
  };
}

function updatePeak(peak) {
  const current = process.memoryUsage().rss;
  if (current > peak.value) peak.value = current;
}

function latencyPercentiles(latencies, length) {
  const values = latencies.subarray(0, length);
  values.sort();
  const percentile = (fraction) => {
    if (values.length === 0) return 0;
    const index = Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1);
    return Number(values[index].toFixed(3));
  };
  return {
    p50: percentile(0.50),
    p95: percentile(0.95),
    p99: percentile(0.99),
  };
}

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function fileContains(path, needle) {
  if (needle.length === 0) return false;
  let carry = Buffer.alloc(0);
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const searchable = carry.length === 0 ? bytes : Buffer.concat([carry, bytes]);
    if (searchable.indexOf(needle) !== -1) return true;
    const retained = Math.min(needle.length - 1, searchable.length);
    carry = retained === 0 ? Buffer.alloc(0) : Buffer.from(searchable.subarray(searchable.length - retained));
  }
  return false;
}

function assertTopology(bundle, options) {
  if (bundle.raw.length !== options.events) fail("RAW_EVENT_LOSS");
  if (bundle.events.length !== options.events) fail("NORMALIZED_EVENT_LOSS");

  const rawState = new Map();
  const normalizedState = new Map();
  for (const envelope of bundle.raw) {
    const payload = envelope.payload;
    const sessionId = payload?.session_id;
    const sourceEvent = payload?.event;
    const sourceSequence = sourceEvent?.seq;
    const sourceType = sourceEvent?.type;
    if (typeof sessionId !== "string" || !Number.isSafeInteger(sourceSequence)
      || typeof sourceType !== "string") fail("RAW_TOPOLOGY_INVALID");
    const state = rawState.get(sessionId) ?? { next: 0, hash: createHash("sha256") };
    if (sourceSequence !== state.next || envelope.source_event_id !== `${sessionId}:${sourceSequence}`) {
      fail("RAW_SOURCE_SEQUENCE_INVALID");
    }
    state.hash.update(canonicalJson({ session_id: sessionId, source_sequence: sourceSequence, type: sourceType }));
    state.hash.update("\n");
    state.next += 1;
    rawState.set(sessionId, state);
  }
  for (const event of bundle.events) {
    const sessionId = event.source_session_id;
    const sourceSequence = event.metadata?.harness_seq;
    if (typeof sessionId !== "string" || !Number.isSafeInteger(sourceSequence)) {
      fail("NORMALIZED_TOPOLOGY_INVALID");
    }
    const state = normalizedState.get(sessionId) ?? { next: 0, hash: createHash("sha256") };
    if (sourceSequence !== state.next || event.source_event_id !== `${sessionId}:${sourceSequence}`) {
      fail("NORMALIZED_SOURCE_SEQUENCE_INVALID");
    }
    state.hash.update(canonicalJson({
      event_type: event.event_type,
      session_id: sessionId,
      source_sequence: sourceSequence,
    }));
    state.hash.update("\n");
    state.next += 1;
    normalizedState.set(sessionId, state);
  }
  if (rawState.size !== options.sessions || normalizedState.size !== options.sessions) {
    fail("SOURCE_SESSION_LOSS");
  }

  const rawTopology = createHash("sha256");
  const normalizedTopology = createHash("sha256");
  for (let sessionIndex = 0; sessionIndex < options.sessions; sessionIndex += 1) {
    const sessionId = `benchmark-session-${String(sessionIndex).padStart(4, "0")}`;
    const expected = expectedEventsForSession(options.events, options.sessions, sessionIndex);
    const raw = rawState.get(sessionId);
    const normalized = normalizedState.get(sessionId);
    if (raw?.next !== expected || normalized?.next !== expected) fail("SOURCE_SESSION_COUNT_MISMATCH");
    rawTopology.update(`${sessionId}\0${raw.hash.digest("hex")}\n`);
    normalizedTopology.update(`${sessionId}\0${normalized.hash.digest("hex")}\n`);
  }
  return {
    raw_source_topology_sha256: rawTopology.digest("hex"),
    normalized_source_topology_sha256: normalizedTopology.digest("hex"),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = await mkdtemp(join(tmpdir(), "trajpack-collector-benchmark-"));
  const paths = pathsFor(root);
  const passphrase = randomBytes(32).toString("base64url");
  const token = randomBytes(32).toString("base64url");
  const sentinel = `TRAJPACK_BENCH_${randomBytes(24).toString("hex")}`;
  const source = {
    ...defaultSource("deepseek_harness", "self_hosted"),
    model_id: "synthetic-owned-model",
    model_snapshot_or_weights_digest: createHash("sha256").update("synthetic-owned-model").digest("hex"),
  };
  source.authenticity_evidence_ref = `local-model-artifact:${source.model_snapshot_or_weights_digest}`;
  const manifest = createManifest({
    source,
    accountType: "self_hosted",
    rights: {
      source_license_expression: "Apache-2.0",
      model_license_chain: ["Apache-2.0"],
      input_rights_basis: "owned",
      third_party_content: "none",
      rights_holder: "synthetic-benchmark-owner",
    },
    consentReceipt: consentReceipt("deepseek_harness", root),
    consentPurposes: ["archive", "research", "capture"],
    competitive: "no",
    targetModelOwner: "synthetic-benchmark-owner",
    targetProduct: "collector-throughput-validation",
  });

  globalThis.gc?.();
  const baselineRss = process.memoryUsage().rss;
  const peakRss = { value: baselineRss };
  const monitor = setInterval(() => updatePeak(peakRss), 20);
  monitor.unref();
  const totalStarted = performance.now();
  let session;
  let collector;
  let finalized = false;
  try {
    session = await CaptureSession.create("deepseek_harness", manifest, passphrase, paths, {
      maxRawEvents: options.events,
      maxRawBytes: 128 * MiB,
      maxPendingIngest: 1_024,
    });
    collector = await startIngestServer({
      host: "deepseek_harness",
      token,
      session,
      maxEvents: options.events,
      maxTotalRawBytes: 128 * MiB,
      maxConcurrentRequests: options.collectorConcurrency,
    });

    const counters = { accepted202: 0, busy429: 0, errors: 0, attempts: 0 };
    const acceptedLatencies = new Float64Array(options.events);
    let acceptedLatencyCount = 0;
    let logicalRequestBytes = 0;
    let nextSession = 0;
    const ingestStarted = performance.now();

    const send = async (capsule) => {
      const body = canonicalJson(capsule);
      const bodyBytes = Buffer.byteLength(body, "utf8");
      for (let retry = 0; retry <= CAPS.retries; retry += 1) {
        const requestStarted = performance.now();
        let response;
        try {
          counters.attempts += 1;
          response = await fetch(`${collector.url}/v1/hooks/events`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "x-trajpack-host": "deepseek_harness",
              "x-trajpack-interface": DEEPSEEK_HARNESS_INTERFACE_VERSION,
            },
            body,
          });
        } catch {
          counters.errors += 1;
          if (retry === CAPS.retries) fail("TRANSPORT_RETRY_EXHAUSTED");
          await sleep(Math.min(25, 1 + retry));
          continue;
        }
        const latency = performance.now() - requestStarted;
        if (response.status === 202) {
          const result = await response.json().catch(() => null);
          if (result?.accepted !== true) fail("INVALID_ACCEPT_RESPONSE");
          acceptedLatencies[acceptedLatencyCount] = latency;
          acceptedLatencyCount += 1;
          counters.accepted202 += 1;
          logicalRequestBytes += bodyBytes;
          updatePeak(peakRss);
          return;
        }
        if (response.status === 429) {
          counters.busy429 += 1;
          const result = await response.json().catch(() => null);
          if (result?.error !== "collector_busy") fail("TERMINAL_COLLECTOR_LIMIT");
          if (retry === CAPS.retries) fail("BACKPRESSURE_RETRY_EXHAUSTED");
          await sleep(Math.min(25, 1 + retry));
          continue;
        }
        counters.errors += 1;
        await response.arrayBuffer().catch(() => undefined);
        fail("UNEXPECTED_HTTP_STATUS");
      }
    };

    const runWorker = async () => {
      while (true) {
        const sessionIndex = nextSession;
        nextSession += 1;
        if (sessionIndex >= options.sessions) return;
        const eventCount = expectedEventsForSession(options.events, options.sessions, sessionIndex);
        for (let sourceSequence = 0; sourceSequence < eventCount; sourceSequence += 1) {
          await send(syntheticCapsule(sessionIndex, sourceSequence, options.payloadBytes, sentinel));
        }
      }
    };
    await Promise.all(Array.from({ length: options.concurrency }, () => runWorker()));
    const ingestFinished = performance.now();
    await collector.close();
    collector = undefined;
    const bundle = await session.finalize();
    finalized = true;
    const totalFinished = performance.now();
    updatePeak(peakRss);

    if (counters.accepted202 !== options.events || acceptedLatencyCount !== options.events) {
      fail("HTTP_ACCEPT_COUNT_MISMATCH");
    }
    if (session.captureStats().rawEvents !== options.events) fail("CAPTURE_STATS_EVENT_LOSS");
    const topology = assertTopology(bundle, options);
    const target = vaultPath(manifest.trace_id, paths);
    const details = await stat(target);
    if (!details.isFile() || details.size <= 0) fail("VAULT_NOT_PUBLISHED");
    const [vaultSha256, sentinelFound, passphraseFound] = await Promise.all([
      sha256File(target),
      fileContains(target, Buffer.from(sentinel, "utf8")),
      fileContains(target, Buffer.from(passphrase, "utf8")),
    ]);
    if (sentinelFound) fail("PLAINTEXT_SENTINEL_FOUND_IN_VAULT");
    if (passphraseFound) fail("PLAINTEXT_PASSPHRASE_FOUND_IN_VAULT");

    const ingestSeconds = (ingestFinished - ingestStarted) / 1_000;
    const totalSeconds = (totalFinished - totalStarted) / 1_000;
    const stats = session.captureStats();
    const report = {
      benchmark_version: "collector-e2e/0.1",
      mode: options.ci ? "ci_smoke" : "local",
      configuration: {
        source_sessions: options.sessions,
        events: options.events,
        client_concurrency: options.concurrency,
        collector_concurrency: options.collectorConcurrency,
        synthetic_content_bytes_per_event: options.payloadBytes,
      },
      http: {
        attempts: counters.attempts,
        accepted_202: counters.accepted202,
        backpressure_429: counters.busy429,
        errors: counters.errors,
      },
      timing: {
        ingest_seconds: Number(ingestSeconds.toFixed(3)),
        total_seconds: Number(totalSeconds.toFixed(3)),
        events_per_second: Math.round(options.events / ingestSeconds),
        logical_mib_per_second: Number((logicalRequestBytes / MiB / ingestSeconds).toFixed(3)),
        accepted_request_latency_ms: latencyPercentiles(acceptedLatencies, acceptedLatencyCount),
      },
      memory: {
        baseline_rss_mib: Number((baselineRss / MiB).toFixed(1)),
        peak_rss_mib: Number((peakRss.value / MiB).toFixed(1)),
        peak_rss_delta_mib: Number(((peakRss.value - baselineRss) / MiB).toFixed(1)),
      },
      storage: {
        logical_request_bytes: logicalRequestBytes,
        raw_envelope_bytes: stats.rawBytes,
        encrypted_vault_bytes: details.size,
      },
      verification: {
        zero_event_loss: true,
        source_sessions_verified: options.sessions,
        raw_events_verified: bundle.raw.length,
        normalized_events_verified: bundle.events.length,
        plaintext_sentinel_absent: true,
        plaintext_passphrase_absent: true,
      },
      lineage: {
        raw_lineage_sha256: stats.rawLineageSha256,
        raw_source_topology_sha256: topology.raw_source_topology_sha256,
        normalized_source_topology_sha256: topology.normalized_source_topology_sha256,
        encrypted_vault_sha256: vaultSha256,
      },
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    clearInterval(monitor);
    await collector?.close().catch(() => undefined);
    if (!finalized) await session?.abort().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  const code = error instanceof BenchmarkFailure ? error.code : "UNEXPECTED_FAILURE";
  process.stderr.write(`${JSON.stringify({ benchmark_version: "collector-e2e/0.1", error: code })}\n`);
  process.exitCode = 1;
});
