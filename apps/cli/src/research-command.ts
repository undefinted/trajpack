import { deriveResearchAnalytics, toTraceLabWorkloadRows } from "@trajpack/core";

import { loadManagedBundlesBounded } from "./dataset-memory.js";
import { readPassphrase } from "./secret.js";

export type ResearchOutputFormat = "summary" | "tracelab-jsonl";

export async function runResearchAnalyze(
  traceIds: string[],
  options: { format?: ResearchOutputFormat } = {},
): Promise<void> {
  if (traceIds.length === 0 || traceIds.some((traceId) => !/^[a-f0-9]{32}$/u.test(traceId))) {
    throw new Error("Research analysis requires one or more exact managed trace ids");
  }
  if (new Set(traceIds).size !== traceIds.length) {
    throw new Error("Research analysis trace ids must be unique");
  }
  const passphrase = await readPassphrase();
  const bundles = await loadManagedBundlesBounded(traceIds, passphrase);
  const input = { kind: "approved_bundles" as const, bundles };
  if ((options.format ?? "summary") === "tracelab-jsonl") {
    const rows = toTraceLabWorkloadRows(input);
    process.stdout.write(rows.length === 0 ? "" : `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(deriveResearchAnalytics(input), null, 2)}\n`);
}
