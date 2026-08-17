import { extname, resolve } from "node:path";
import type { Host, Provider, RawEnvelope } from "@trajpack/schema";
import { consentReceipt, createManifest, evaluateGate, readBundle } from "@trajpack/core";
import { importFile, type ImportOptions, type ImportSourceHint } from "@trajpack/importers";
import { CaptureSession } from "./capture-session.js";
import { readPassphrase } from "./secret.js";
import { resolveSourceOptions, type SourceCliOptions } from "./source-options.js";

export interface ImportCommandOptions extends SourceCliOptions {
  sourceHint?: ImportSourceHint;
  maxBytes?: number | string;
  maxArchiveEntries?: number | string;
  maxArchiveEntryBytes?: number | string;
  maxArchiveUncompressedBytes?: number | string;
}

const MAX_IMPORT_RAW_EVENTS = 250_000;
const MAX_IMPORT_RAW_BYTES = 192 * 1024 * 1024;

function importCaptureLimits() {
  return { maxRawEvents: MAX_IMPORT_RAW_EVENTS, maxRawBytes: MAX_IMPORT_RAW_BYTES };
}

function optionalPositiveInteger(value: number | string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer number of bytes or entries`);
  return parsed;
}

function detectedApiModels(envelopes: Awaited<ReturnType<typeof importFile>>["envelopes"]): string[] {
  const models = new Set<string>();
  for (const envelope of envelopes) {
    if (!envelope.payload || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) continue;
    const record = (envelope.payload as Record<string, unknown>).record;
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const model = (record as Record<string, unknown>).model;
    if (typeof model === "string" && model.trim()) models.add(model.trim());
  }
  return [...models].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function providerFromHarnessRoute(route: string): Provider {
  const value = route.toLowerCase();
  if (value.includes("deepseek")) return "deepseek";
  if (value.includes("openai")) return "openai";
  if (value.includes("anthropic") || value.includes("claude")) return "anthropic";
  if (value.includes("google") || value.includes("gemini")) return "google";
  if (value.includes("self-host") || value.includes("local") || value.includes("ollama")) return "self_hosted";
  return "other";
}

function detectedHarnessTeacher(envelopes: readonly RawEnvelope[]): { provider: Provider; model: string } {
  const routes = new Map<string, { provider: Provider; model: string }>();
  for (const envelope of envelopes) {
    if (envelope.adapter !== "deepseek_harness" || !envelope.payload
      || typeof envelope.payload !== "object" || Array.isArray(envelope.payload)) continue;
    const payload = envelope.payload as Record<string, unknown>;
    const route = payload.route;
    if (!route || typeof route !== "object" || Array.isArray(route)) continue;
    const providerRoute = (route as Record<string, unknown>).provider;
    const model = (route as Record<string, unknown>).model;
    if (typeof providerRoute !== "string" || typeof model !== "string" || !model.trim()) continue;
    const provider = providerFromHarnessRoute(providerRoute);
    routes.set(`${provider}\0${model.trim()}`, { provider, model: model.trim() });
  }
  if (routes.size !== 1) {
    throw new Error("DeepSeek Harness persistence import requires one consistent observed provider/model route");
  }
  return [...routes.values()][0]!;
}

async function importTrajpackVault(path: string, options: ImportCommandOptions): Promise<string> {
  const passphrase = await readPassphrase();
  const imported = await readBundle(path, passphrase);
  if (imported.raw.length === 0) {
    throw new Error("A .trajpack import requires encrypted raw events; import canonical plaintext through its format-specific path");
  }
  const host = imported.manifest.source.host;
  const resolved = await resolveSourceOptions(host, options);
  const immutableClaims = [
    ["provider", resolved.provider === "unknown" ? undefined : resolved.provider, imported.manifest.source.provider],
    ["account type", resolved.accountType === "unknown" ? undefined : resolved.accountType, imported.manifest.account_contract.account_type],
    ["model", options.model, imported.manifest.source.model_id],
    ["model digest", options.modelDigest, imported.manifest.source.model_snapshot_or_weights_digest],
    ["origin", options.origin, imported.manifest.source.origin],
    ["interface version", options.interfaceVersion, imported.manifest.source.interface_version],
  ] as const;
  for (const [label, requested, recorded] of immutableClaims) {
    if (requested !== undefined && requested !== recorded) {
      throw new Error(`Encrypted trajpack source ${label} is immutable; requested ${requested}, recorded ${String(recorded)}`);
    }
  }
  // A vault passphrase authenticates encryption frames, not the producer's
  // identity or its manifest assertions. Preserve descriptive provenance while
  // deliberately removing any source-authenticity claim on this new trust
  // boundary. The original encrypted vault remains the lineage parent.
  const source = {
    ...imported.manifest.source,
    authenticity: imported.manifest.source.authenticity === "unknown"
      ? "unknown" as const
      : "user_supplied" as const,
    authenticity_evidence_ref: null,
  };
  const accountType = imported.manifest.account_contract.account_type;
  const rights = {
    source_license_expression: resolved.rights.source_license_expression === "NOASSERTION"
      ? imported.manifest.rights.source_license_expression
      : resolved.rights.source_license_expression,
    model_license_chain: options.modelLicense?.length
      ? options.modelLicense
      : imported.manifest.rights.model_license_chain,
    input_rights_basis: resolved.rights.input_rights_basis === "unknown"
      ? imported.manifest.rights.input_rights_basis
      : resolved.rights.input_rights_basis,
    third_party_content: resolved.rights.third_party_content === "unknown"
      ? imported.manifest.rights.third_party_content
      : resolved.rights.third_party_content,
    rights_holder: options.rightsHolder ?? imported.manifest.rights.rights_holder,
  };
  // Unsigned permission assertions inside an imported vault are equally
  // untrusted. They must be supplied again through this import invocation so
  // their exact provider/account/capture/target scope is revalidated.
  const permissionEvidence = resolved.permissionEvidence;
  const writtenPermissionRef = options.writtenPermission
    ?? resolved.permissionEvidence?.evidence_ref;
  const manifest = createManifest({
    source,
    accountType,
    rights,
    consentReceipt: consentReceipt("trajpack-import", path),
    consentPurposes: [...new Set(["archive", "research", "import", ...(options.consentPurpose ?? [])])],
    terms: resolved.terms.length ? resolved.terms : imported.manifest.account_contract.terms,
    ...(permissionEvidence === undefined ? {} : { permissionEvidence }),
    ...(writtenPermissionRef === undefined ? {} : { writtenPermissionRef }),
    ...(options.targetModelOwner === undefined ? {} : { targetModelOwner: options.targetModelOwner }),
    ...(options.targetProduct === undefined ? {} : { targetProduct: options.targetProduct }),
    ...(options.competitive === undefined ? {} : { competitive: options.competitive }),
    ...(options.region === undefined ? {} : { contractingRegion: options.region }),
  });
  // Re-normalization must never revive withdrawn consent, narrow a broader
  // participant scope, or manufacture new purposes from the importing user.
  manifest.consent = structuredClone(imported.manifest.consent);
  manifest.lineage.parent_trace_ids = [imported.manifest.trace_id];
  const preflight = evaluateGate({ manifest, raw: [], events: [] }, "archive");
  if (!preflight.allowed) throw new Error(`Import blocked by policy: ${preflight.reasonCodes.join(", ")}`);
  const session = await CaptureSession.create(host, manifest, passphrase, undefined, importCaptureLimits());
  try {
    for (const envelope of imported.raw) await session.ingest(envelope);
    const bundle = await session.finalize();
    process.stderr.write(`trajpack: re-normalized encrypted vault as trace ${bundle.manifest.trace_id}; source authenticity downgraded and human review reset to pending\n`);
    return bundle.manifest.trace_id;
  } catch (error) {
    await session.abort();
    throw error;
  }
}

export async function runImport(input: string, options: ImportCommandOptions): Promise<string> {
  const path = resolve(input);
  if (extname(path).toLowerCase() === ".trajpack") return importTrajpackVault(path, options);
  const importOptions: ImportOptions = {};
  if (options.sourceHint) importOptions.sourceHint = options.sourceHint;
  const maxBytes = optionalPositiveInteger(options.maxBytes, "--max-bytes");
  const maxArchiveEntries = optionalPositiveInteger(options.maxArchiveEntries, "--max-archive-entries");
  const maxArchiveEntryBytes = optionalPositiveInteger(options.maxArchiveEntryBytes, "--max-archive-entry-bytes");
  const maxArchiveUncompressedBytes = optionalPositiveInteger(
    options.maxArchiveUncompressedBytes,
    "--max-archive-uncompressed-bytes",
  );
  if (maxBytes !== undefined) importOptions.maxBytes = maxBytes;
  if (maxArchiveEntries !== undefined) importOptions.maxArchiveEntries = maxArchiveEntries;
  if (maxArchiveEntryBytes !== undefined) importOptions.maxArchiveEntryBytes = maxArchiveEntryBytes;
  if (maxArchiveUncompressedBytes !== undefined) importOptions.maxArchiveUncompressedBytes = maxArchiveUncompressedBytes;
  const imported = await importFile(path, importOptions);
  const harnessPersistence = imported.detectedFormat === "deepseek_harness_session_jsonl";
  const host: Host = harnessPersistence ? "deepseek_harness" : "manual_import";
  const resolved = await resolveSourceOptions(host, options);
  const detectedProvider = imported.detectedFormat === "chatgpt_official_json"
      || imported.detectedFormat === "chatgpt_official_html"
    ? "openai"
    : imported.detectedFormat === "claude_official_json"
      ? "anthropic"
      : imported.detectedFormat === "gemini_takeout_activity_json"
          || imported.detectedFormat === "gemini_takeout_activity_html"
        ? "google"
      : imported.detectedFormat === "deepseek_api_response"
        ? "deepseek"
        : harnessPersistence
          ? detectedHarnessTeacher(imported.envelopes).provider
        : null;
  if (detectedProvider !== null && resolved.source.provider !== "unknown"
    && resolved.source.provider !== detectedProvider) {
    throw new Error(`Detected ${imported.detectedFormat} provenance conflicts with --provider ${resolved.source.provider}`);
  }
  if (
    resolved.source.provider === "unknown" &&
    (imported.detectedFormat === "chatgpt_official_json" || imported.detectedFormat === "chatgpt_official_html")
  ) {
    resolved.source.provider = "openai";
  } else if (resolved.source.provider === "unknown" && imported.detectedFormat === "claude_official_json") {
    resolved.source.provider = "anthropic";
  } else if (resolved.source.provider === "unknown"
    && (imported.detectedFormat === "gemini_takeout_activity_json"
      || imported.detectedFormat === "gemini_takeout_activity_html")) {
    resolved.source.provider = "google";
  } else if (
    resolved.source.provider === "unknown" &&
    imported.detectedFormat === "deepseek_api_response"
  ) {
    resolved.source.provider = "deepseek";
    resolved.provider = "deepseek";
  }
  if (
    resolved.accountType === "unknown" &&
    imported.detectedFormat === "deepseek_api_response"
  ) {
    resolved.accountType = "api";
  }
  resolved.source.interface_version = harnessPersistence
    ? "deepseek-harness@0.1.0-rc.6/session-event/0"
    : imported.detectedFormat;
  if (harnessPersistence) {
    const observed = detectedHarnessTeacher(imported.envelopes);
    resolved.source.provider = observed.provider;
    resolved.provider = observed.provider;
    if (options.model !== undefined && options.model !== observed.model) {
      throw new Error(`Harness request model ${observed.model} conflicts with --model ${options.model}`);
    }
    resolved.source.product = "deepseek-harness-persistence-import";
    resolved.source.surface = "harness";
    resolved.source.capture_method = "official_export";
    resolved.source.fidelity = "B";
    resolved.source.authenticity = "user_supplied";
    resolved.source.authenticity_evidence_ref = null;
    resolved.source.model_id = observed.model;
  } else if (imported.detectedFormat === "deepseek_api_response") {
    const models = detectedApiModels(imported.envelopes);
    if (models.length !== 1) throw new Error("DeepSeek API import requires one consistent response model identifier");
    if (options.model !== undefined && options.model !== models[0]) {
      throw new Error(`DeepSeek API response model ${models[0]} conflicts with --model ${options.model}`);
    }
    resolved.source.product = "deepseek-api-response";
    resolved.source.surface = "api";
    resolved.source.capture_method = "manual_copy";
    resolved.source.fidelity = "B";
    resolved.source.model_id = models[0]!;
  } else if (imported.detectedFormat === "generic_json"
    || imported.detectedFormat === "generic_jsonl"
    || imported.detectedFormat === "generic_html") {
    resolved.source.product = `manual-archive:${imported.detectedFormat}`;
    resolved.source.capture_method = "manual_copy";
    resolved.source.fidelity = "C";
  } else {
    resolved.source.product = `official-export:${imported.detectedFormat}`;
  }
  const manifest = createManifest({
    source: resolved.source,
    accountType: resolved.accountType,
    rights: resolved.rights,
    consentReceipt: consentReceipt(host, path),
    consentPurposes: [...new Set(["archive", "research", "import", ...(options.consentPurpose ?? [])])],
    terms: resolved.terms,
    ...(resolved.permissionEvidence === undefined ? {} : { permissionEvidence: resolved.permissionEvidence }),
    ...(options.writtenPermission === undefined ? {} : { writtenPermissionRef: options.writtenPermission }),
    ...(options.targetModelOwner === undefined ? {} : { targetModelOwner: options.targetModelOwner }),
    ...(options.targetProduct === undefined ? {} : { targetProduct: options.targetProduct }),
    ...(options.competitive === undefined ? {} : { competitive: options.competitive }),
    ...(options.region === undefined ? {} : { contractingRegion: options.region }),
  });
  const preflight = evaluateGate({ manifest, raw: [], events: [] }, "archive");
  if (!preflight.allowed) throw new Error(`Import blocked by policy: ${preflight.reasonCodes.join(", ")}`);
  const passphrase = await readPassphrase();
  const session = await CaptureSession.create(host, manifest, passphrase, undefined, importCaptureLimits());
  try {
    for (const envelope of imported.envelopes) await session.ingest(envelope);
    const bundle = await session.finalize();
    process.stderr.write(`trajpack: imported ${imported.detectedFormat} as encrypted trace ${bundle.manifest.trace_id}\n`);
    for (const warning of imported.sourceMetadata?.warnings as string[] ?? []) process.stderr.write(`trajpack: warning: ${warning}\n`);
    return bundle.manifest.trace_id;
  } catch (error) {
    await session.abort();
    throw error;
  }
}
