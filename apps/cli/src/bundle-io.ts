import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { TraceBundle } from "@trajpack/schema";
import { traceBundleSchema, traceManifestSchema, trajectoryEventSchema } from "@trajpack/schema";
import { loadTrace, readBundle } from "@trajpack/core";
import { readPassphrase } from "./secret.js";

const TRACE_ID = /^[a-f0-9]{32}$/;

export async function loadSelection(selection: string): Promise<TraceBundle> {
  if (TRACE_ID.test(selection)) return loadTrace(selection, await readPassphrase());
  const details = await stat(selection);
  if (details.isDirectory()) {
    const manifest = traceManifestSchema.parse(JSON.parse(await readFile(join(selection, "manifest.json"), "utf8")));
    const lines = (await readFile(join(selection, "events.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean);
    const events = lines.map((line) => trajectoryEventSchema.parse(JSON.parse(line)));
    return traceBundleSchema.parse({ manifest, events, raw: [] });
  }
  if (basename(selection).endsWith(".trajpack")) return readBundle(selection, await readPassphrase());
  const parsed = JSON.parse(await readFile(selection, "utf8")) as unknown;
  return traceBundleSchema.parse(parsed);
}
