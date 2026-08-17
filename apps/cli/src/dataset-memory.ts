import type { TraceBundle } from "@trajpack/schema";
import { loadTrace } from "@trajpack/core";

// v1 dataset compilation is intentionally in-process. Bound its aggregate
// decrypted object graph until the streaming compiler lands, rather than
// letting a 10k-trace plan exhaust the workstation heap unpredictably.
export const MAX_DATASET_RESIDENT_ESTIMATE_BYTES = 256 * 1024 * 1024;
export const MAX_DATASET_RESIDENT_NODES = 2_000_000;

export function estimateResidentBytes(value: unknown, maxNodes = MAX_DATASET_RESIDENT_NODES): number {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  let bytes = 0;
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    nodes += 1;
    if (nodes > maxNodes) throw new Error("Dataset bundle object graph exceeds the bounded node budget");
    if (current === null || current === undefined) {
      bytes += 8;
    } else if (typeof current === "string") {
      bytes += 24 + current.length * 2;
    } else if (typeof current === "number" || typeof current === "bigint") {
      bytes += 16;
    } else if (typeof current === "boolean") {
      bytes += 8;
    } else if (typeof current === "object") {
      if (seen.has(current)) continue;
      seen.add(current);
      if (Buffer.isBuffer(current)) {
        bytes += 32 + current.byteLength;
      } else if (Array.isArray(current)) {
        bytes += 32 + current.length * 8;
        for (const child of current) pending.push(child);
      } else {
        const entries = Object.entries(current as Record<string, unknown>);
        bytes += 48 + entries.length * 16;
        for (const [key, child] of entries) {
          bytes += key.length * 2;
          pending.push(child);
        }
      }
    }
  }
  return bytes;
}

export async function loadManagedBundlesBounded(
  traceIds: readonly string[],
  passphrase: string,
  maxResidentBytes = MAX_DATASET_RESIDENT_ESTIMATE_BYTES,
): Promise<TraceBundle[]> {
  if (!Number.isSafeInteger(maxResidentBytes) || maxResidentBytes < 1) {
    throw new Error("Dataset resident-memory budget must be a positive safe integer");
  }
  const bundles: TraceBundle[] = [];
  let estimatedBytes = 0;
  for (const traceId of traceIds) {
    const bundle = await loadTrace(traceId, passphrase);
    estimatedBytes += estimateResidentBytes(bundle);
    if (estimatedBytes > maxResidentBytes) {
      throw new Error(
        `Dataset selection exceeds the ${maxResidentBytes}-byte in-process compilation budget; split the build into smaller selections`,
      );
    }
    bundles.push(bundle);
  }
  return bundles;
}
