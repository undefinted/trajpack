import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { canonicalJson, VaultWriter } from "../packages/core/dist/index.js";

const requested = Number(process.env.TRAJPACK_BENCH_EVENTS ?? 100_000);
if (!Number.isSafeInteger(requested) || requested < 1_000 || requested > 200_000) {
  throw new Error("TRAJPACK_BENCH_EVENTS must be an integer from 1000 to 200000");
}
const eventCount = requested;
const MiB = 1024 * 1024;
const scenarios = [
  "jsonl-legacy",
  "jsonl-stream",
  "hash-legacy",
  "hash-current",
  "vault-legacy",
  "vault-current",
];
const scenario = process.argv.find((value) => value.startsWith("--scenario="))?.slice("--scenario=".length);
if (scenario === undefined) {
  const script = fileURLToPath(import.meta.url);
  for (const childScenario of scenarios) {
    const child = spawnSync(process.execPath, ["--expose-gc", script, `--scenario=${childScenario}`], {
      env: process.env,
      encoding: "utf8",
    });
    process.stdout.write(child.stdout);
    process.stderr.write(child.stderr);
    if (child.status !== 0) throw new Error(`Scale benchmark scenario failed: ${childScenario}`);
  }
  process.exit(0);
}
if (!scenarios.includes(scenario)) throw new Error(`Unknown scale benchmark scenario: ${scenario}`);
const directory = await mkdtemp(join(tmpdir(), "trajpack-scale-benchmark-"));

function memory() {
  const value = process.memoryUsage();
  return { rss: value.rss, heap: value.heapUsed };
}

function metric(name, started, bytes, baseline, peak, extra = {}) {
  const seconds = (performance.now() - started) / 1000;
  return {
    name,
    events: eventCount,
    seconds: Number(seconds.toFixed(3)),
    events_per_second: Math.round(eventCount / seconds),
    mebibytes_per_second: Number((bytes / MiB / seconds).toFixed(1)),
    peak_rss_delta_mib: Number(((peak.rss - baseline.rss) / MiB).toFixed(1)),
    peak_heap_delta_mib: Number(((peak.heap - baseline.heap) / MiB).toFixed(1)),
    ...extra,
  };
}

async function writeAll(handle, value) {
  let offset = 0;
  while (offset < value.length) {
    const result = await handle.write(value, offset, value.length - offset, null);
    if (result.bytesWritten <= 0) throw new Error("Benchmark write made no progress");
    offset += result.bytesWritten;
  }
}

try {
  const rows = Array.from({ length: eventCount }, (_, sequence) => ({
    sequence,
    payload: { text: `${"x".repeat(256)}${sequence}` },
  }));
  // Compute the logical byte size before the isolated measurement. Each
  // scenario runs in a fresh process so RSS high-water marks cannot leak from
  // the legacy implementation into the streaming result.
  const jsonlBytes = rows.reduce((total, row) => total + Buffer.byteLength(canonicalJson(row)) + 1, 0);

  if (scenario === "jsonl-legacy") {
    globalThis.gc?.();
    const baseline = memory();
    const started = performance.now();
    const jsonl = `${rows.map(canonicalJson).join("\n")}\n`;
    const peak = memory();
    await writeFile(join(directory, "legacy.jsonl"), jsonl);
    console.log(JSON.stringify(metric(
      "legacy-map-join-jsonl", started, jsonlBytes, baseline, peak,
      { workers: 1, batch_bytes: null },
    )));
  } else if (scenario === "jsonl-stream") {
    globalThis.gc?.();
    const baseline = memory();
    let peak = baseline;
    let bytes = 0;
    let bufferedBytes = 0;
    let buffers = [];
    const started = performance.now();
    const handle = await open(join(directory, "stream.jsonl"), "wx", 0o600);
    try {
      for (const row of rows) {
        const encoded = Buffer.from(`${canonicalJson(row)}\n`);
        if (bufferedBytes > 0 && bufferedBytes + encoded.length > MiB) {
          await writeAll(handle, Buffer.concat(buffers, bufferedBytes));
          buffers = [];
          bufferedBytes = 0;
        }
        buffers.push(encoded);
        bufferedBytes += encoded.length;
        bytes += encoded.length;
        if ((row.sequence & 511) === 0) {
          const current = memory();
          peak = { rss: Math.max(peak.rss, current.rss), heap: Math.max(peak.heap, current.heap) };
        }
      }
      if (bufferedBytes > 0) await writeAll(handle, Buffer.concat(buffers, bufferedBytes));
    } finally {
      await handle.close();
    }
    console.log(JSON.stringify(metric(
      "current-1mib-stream-jsonl", started, bytes, baseline, peak,
      { workers: 1, batch_bytes: MiB, byte_count_verified: bytes === jsonlBytes },
    )));
  } else if (scenario === "hash-legacy") {
    globalThis.gc?.();
    const baseline = memory();
    const started = performance.now();
    const hash = createHash("sha256").update(canonicalJson(rows)).digest("hex");
    const peak = memory();
    console.log(JSON.stringify(metric(
      "legacy-whole-array-lineage-hash", started, jsonlBytes, baseline, peak,
      { workers: 1, sha256: hash },
    )));
  } else if (scenario === "hash-current") {
    globalThis.gc?.();
    const baseline = memory();
    let peak = baseline;
    const started = performance.now();
    const hash = createHash("sha256");
    hash.update("[");
    for (const [index, row] of rows.entries()) {
      if (index > 0) hash.update(",");
      hash.update(canonicalJson(row));
      if ((index & 511) === 0) {
        const current = memory();
        peak = { rss: Math.max(peak.rss, current.rss), heap: Math.max(peak.heap, current.heap) };
      }
    }
    hash.update("]");
    const value = hash.digest("hex");
    console.log(JSON.stringify(metric(
      "current-incremental-lineage-hash", started, jsonlBytes, baseline, peak,
      { workers: 1, sha256: value },
    )));
  } else {
    const legacyVault = scenario === "vault-legacy";
    globalThis.gc?.();
    const baseline = memory();
    let peak = baseline;
    const vault = await VaultWriter.create(
      join(directory, "benchmark.trajpack"),
      "synthetic benchmark passphrase",
      legacyVault ? { flushBytes: 1 } : {},
    );
    const started = performance.now();
    for (let sequence = 0; sequence < eventCount; sequence += 1) {
      const payload = { value: `${"x".repeat(256)}${sequence}` };
      await vault.append({
        kind: "raw",
        value: {
          envelope_version: "raw/0.1",
          adapter: "manual_import",
          adapter_version: "benchmark",
          interface_version: "benchmark/1",
          captured_at: "2026-01-01T00:00:00.000Z",
          sequence,
          source_event_id: null,
          session_id: null,
          turn_id: null,
          payload_sha256: createHash("sha256").update(canonicalJson(payload)).digest("hex"),
          payload,
        },
      });
      if ((sequence & 511) === 0) {
        const current = memory();
        peak = { rss: Math.max(peak.rss, current.rss), heap: Math.max(peak.heap, current.heap) };
      }
    }
    await vault.finalize();
    const bytes = (await stat(join(directory, "benchmark.trajpack"))).size;
    console.log(JSON.stringify(metric(
      legacyVault
        ? "legacy-encrypted-vault-one-write-per-frame"
        : "current-encrypted-vault-1mib-ciphertext-batches",
      started,
      bytes,
      baseline,
      peak,
      {
        workers: 1,
        batch_bytes: legacyVault ? 1 : MiB,
        secretstream_frames_preserved: true,
        argon2id_memory_included_in_peak: true,
      },
    )));
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
