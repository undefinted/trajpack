import { lstat, open } from "node:fs/promises";
import type {
  AccountType,
  Host,
  PermissionEvidence,
  Provider,
  Rights,
  Source,
  TermsSnapshot,
} from "@trajpack/schema";
import {
  accountTypeSchema,
  permissionEvidenceSchema,
  providerSchema,
  rightsSchema,
  termsSnapshotSchema,
} from "@trajpack/schema";
import { defaultSource } from "@trajpack/core";

const MAX_SOURCE_METADATA_BYTES = 1024 * 1024;

async function readBoundedJson(path: string, label: string): Promise<unknown> {
  const pathDetails = await lstat(path);
  if (!pathDetails.isFile() || pathDetails.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file`);
  }
  if (pathDetails.size > MAX_SOURCE_METADATA_BYTES) {
    throw new Error(`${label} exceeds the 1 MiB limit`);
  }
  const handle = await open(path, "r");
  try {
    const openedDetails = await handle.stat();
    if (!openedDetails.isFile() || openedDetails.size > MAX_SOURCE_METADATA_BYTES) {
      throw new Error(`${label} must be a regular file no larger than 1 MiB`);
    }
    const buffer = Buffer.allocUnsafe(MAX_SOURCE_METADATA_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_SOURCE_METADATA_BYTES) throw new Error(`${label} exceeds the 1 MiB limit`);
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as unknown;
  } finally {
    await handle.close();
  }
}

export interface SourceCliOptions {
  provider?: string;
  accountType?: string;
  model?: string;
  modelDigest?: string;
  interfaceVersion?: string;
  origin?: string;
  terms?: string;
  writtenPermission?: string;
  permissionEvidence?: string;
  inputRights?: Rights["input_rights_basis"];
  thirdParty?: Rights["third_party_content"];
  sourceLicense?: string;
  modelLicense?: string[];
  rightsHolder?: string;
  targetModelOwner?: string;
  targetProduct?: string;
  competitive?: "yes" | "no" | "unknown";
  region?: string;
  consentPurpose?: string[];
}

export interface ResolvedSourceOptions {
  source: Source;
  provider: Provider;
  accountType: AccountType;
  rights: Rights;
  terms: TermsSnapshot[];
  permissionEvidence?: PermissionEvidence;
}

export async function resolveSourceOptions(host: Host, options: SourceCliOptions): Promise<ResolvedSourceOptions> {
  const provider = providerSchema.parse(options.provider ?? "unknown");
  const accountType = accountTypeSchema.parse(options.accountType ?? "unknown");
  const source = defaultSource(host, provider);
  source.model_id = options.model ?? null;
  source.model_snapshot_or_weights_digest = options.modelDigest ?? null;
  source.interface_version = options.interfaceVersion ?? source.interface_version;
  source.origin = options.origin ?? null;
  const rights: Rights = rightsSchema.parse({
    source_license_expression: options.sourceLicense ?? "NOASSERTION",
    model_license_chain: options.modelLicense ?? [],
    input_rights_basis: options.inputRights ?? "unknown",
    third_party_content: options.thirdParty ?? "unknown",
    rights_holder: options.rightsHolder ?? null,
  });
  let terms: TermsSnapshot[] = [];
  if (options.terms) {
    const parsed = await readBoundedJson(options.terms, "--terms JSON");
    terms = Array.isArray(parsed)
      ? termsSnapshotSchema.array().parse(parsed)
      : [termsSnapshotSchema.parse(parsed)];
  }
  let permissionEvidence: PermissionEvidence | undefined;
  if (options.permissionEvidence) {
    const parsed = await readBoundedJson(options.permissionEvidence, "--permission-evidence JSON");
    permissionEvidence = permissionEvidenceSchema.parse(parsed);
    if (options.writtenPermission !== undefined
      && options.writtenPermission !== permissionEvidence.evidence_ref) {
      throw new Error("--written-permission must match permission evidence_ref");
    }
  }
  return {
    source,
    provider,
    accountType,
    rights,
    terms,
    ...(permissionEvidence === undefined ? {} : { permissionEvidence }),
  };
}
