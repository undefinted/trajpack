import { canonicalJson, sha256Hex } from "./hash.js";

export const SELECTOR_RECIPE_VERSION = "selector-recipe/0.1" as const;

export type CapturedRole = "user" | "assistant" | "system" | "tool";
export type AuthorizationBasis = "site_owner" | "written_permission" | "contract";

export interface AuthorizedSelectorRecipe {
  schema_version: typeof SELECTOR_RECIPE_VERSION;
  recipe_id: string;
  name: string;
  origin: string;
  version: string;
  authorization: {
    basis: AuthorizationBasis;
    evidence_ref: string;
    attested_by: string;
    attested_at: string;
    expires_at: string;
  };
  selectors: {
    root: string;
    item: string;
    content: string;
    role_attribute: string;
  };
  role_map: Record<string, CapturedRole>;
  expectations: {
    root_count: 1;
    min_items: number;
    max_items: number;
    content_nodes_per_item: 1;
    max_text_characters_per_item: number;
  };
  fingerprint_probes: Array<{
    selector: string;
    min_matches: number;
    max_matches: number;
  }>;
  recipe_sha256: string;
}

const BLOCKED_COMMERCIAL_HOSTS = ["chat.openai.com", "chatgpt.com", "claude.ai", "deepseek.com"] as const;
const ID_PATTERN = /^[A-Za-z0-9._-]+$/u;
const ATTRIBUTE_PATTERN = /^[A-Za-z_:][A-Za-z0-9_.:-]*$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const CAPTURED_ROLES = new Set<CapturedRole>(["user", "assistant", "system", "tool"]);
const AUTHORIZATION_BASES = new Set<AuthorizationBasis>(["site_owner", "written_permission", "contract"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unexpected.length > 0) throw new Error(`${label} contains unsupported field: ${unexpected[0]}`);
}

function stringField(record: Record<string, unknown>, key: string, maxLength: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new Error(`${key} must be a non-empty string no longer than ${maxLength} characters`);
  }
  return value;
}

function integerField(record: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = record[key];
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${key} must be an integer from ${min} through ${max}`);
  }
  return value as number;
}

function isoDatetime(record: Record<string, unknown>, key: string): string {
  const value = stringField(record, key, 64);
  if (!Number.isFinite(Date.parse(value)) || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) {
    throw new Error(`${key} must be an ISO-8601 datetime`);
  }
  return value;
}

function assertExactOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("origin must be a valid absolute HTTP(S) origin");
  }
  if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password) {
    throw new Error("origin must be an HTTP(S) origin without credentials");
  }
  if (url.origin !== value || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("origin must contain only scheme, host, and optional port (no trailing slash, path, query, or fragment)");
  }
  if (isBlockedCommercialOrigin(url.origin)) {
    throw new Error("Commercial ChatGPT, Claude, and DeepSeek web origins require official/manual export import");
  }
  return url.origin;
}

export function isBlockedCommercialOrigin(origin: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname.toLowerCase();
  } catch {
    return true;
  }
  return BLOCKED_COMMERCIAL_HOSTS.some((blocked) => hostname === blocked || hostname.endsWith(`.${blocked}`));
}

export function recipeWithoutHash(recipe: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(recipe).filter(([key]) => key !== "recipe_sha256");
  return Object.fromEntries(entries);
}

export async function computeRecipeSha256(recipe: Record<string, unknown>): Promise<string> {
  return sha256Hex(canonicalJson(recipeWithoutHash(recipe)));
}

export async function validateAuthorizedSelectorRecipe(input: unknown, now = new Date()): Promise<AuthorizedSelectorRecipe> {
  if (!isRecord(input)) throw new Error("Selector recipe must be a JSON object");
  assertOnlyKeys(input, [
    "schema_version",
    "recipe_id",
    "name",
    "origin",
    "version",
    "authorization",
    "selectors",
    "role_map",
    "expectations",
    "fingerprint_probes",
    "recipe_sha256",
  ], "recipe");
  if (input.schema_version !== SELECTOR_RECIPE_VERSION) throw new Error(`schema_version must be ${SELECTOR_RECIPE_VERSION}`);

  const recipeId = stringField(input, "recipe_id", 128);
  const name = stringField(input, "name", 200);
  const version = stringField(input, "version", 64);
  if (!ID_PATTERN.test(recipeId) || !ID_PATTERN.test(version)) {
    throw new Error("recipe_id and version may contain only letters, digits, period, underscore, and dash");
  }
  const origin = assertExactOrigin(stringField(input, "origin", 2048));

  if (!isRecord(input.authorization)) throw new Error("authorization must be an object");
  assertOnlyKeys(input.authorization, ["basis", "evidence_ref", "attested_by", "attested_at", "expires_at"], "authorization");
  const basis = input.authorization.basis;
  if (typeof basis !== "string" || !AUTHORIZATION_BASES.has(basis as AuthorizationBasis)) {
    throw new Error("authorization.basis must be site_owner, written_permission, or contract");
  }
  const attestedAt = isoDatetime(input.authorization, "attested_at");
  const expiresAt = isoDatetime(input.authorization, "expires_at");
  if (Date.parse(expiresAt) <= now.getTime()) throw new Error("authorization evidence has expired");
  if (Date.parse(attestedAt) > now.getTime() + 5 * 60_000) throw new Error("authorization attestation is in the future");

  if (!isRecord(input.selectors)) throw new Error("selectors must be an object");
  assertOnlyKeys(input.selectors, ["root", "item", "content", "role_attribute"], "selectors");
  const selectors = {
    root: stringField(input.selectors, "root", 500),
    item: stringField(input.selectors, "item", 500),
    content: stringField(input.selectors, "content", 500),
    role_attribute: stringField(input.selectors, "role_attribute", 128),
  };
  if (!ATTRIBUTE_PATTERN.test(selectors.role_attribute)) throw new Error("selectors.role_attribute is not a valid attribute name");

  if (!isRecord(input.role_map) || Object.keys(input.role_map).length === 0) throw new Error("role_map must not be empty");
  const roleMap = Object.create(null) as Record<string, CapturedRole>;
  for (const [sourceRole, targetRole] of Object.entries(input.role_map)) {
    if (["__proto__", "constructor", "prototype"].includes(sourceRole) || sourceRole.length === 0 || sourceRole.length > 128 ||
      typeof targetRole !== "string" || !CAPTURED_ROLES.has(targetRole as CapturedRole)) {
      throw new Error("role_map must map non-empty source roles to user, assistant, system, or tool");
    }
    roleMap[sourceRole] = targetRole as CapturedRole;
  }

  if (!isRecord(input.expectations)) throw new Error("expectations must be an object");
  assertOnlyKeys(input.expectations, [
    "root_count",
    "min_items",
    "max_items",
    "content_nodes_per_item",
    "max_text_characters_per_item",
  ], "expectations");
  if (input.expectations.root_count !== 1 || input.expectations.content_nodes_per_item !== 1) {
    throw new Error("root_count and content_nodes_per_item must both be exactly 1");
  }
  const minItems = integerField(input.expectations, "min_items", 1, 5000);
  const maxItems = integerField(input.expectations, "max_items", 1, 5000);
  if (minItems > maxItems) throw new Error("expectations.min_items must not exceed max_items");
  const maxText = integerField(input.expectations, "max_text_characters_per_item", 1, 250_000);

  if (!Array.isArray(input.fingerprint_probes) || input.fingerprint_probes.length < 1 || input.fingerprint_probes.length > 16) {
    throw new Error("fingerprint_probes must contain 1 through 16 probes");
  }
  const probes = input.fingerprint_probes.map((probe, index) => {
    if (!isRecord(probe)) throw new Error(`fingerprint_probes[${index}] must be an object`);
    assertOnlyKeys(probe, ["selector", "min_matches", "max_matches"], `fingerprint_probes[${index}]`);
    const minMatches = integerField(probe, "min_matches", 0, 10_000);
    const maxMatches = integerField(probe, "max_matches", 0, 10_000);
    if (minMatches > maxMatches) throw new Error(`fingerprint_probes[${index}] has min_matches greater than max_matches`);
    return {
      selector: stringField(probe, "selector", 500),
      min_matches: minMatches,
      max_matches: maxMatches,
    };
  });

  const recipeSha256 = stringField(input, "recipe_sha256", 64);
  if (!SHA256_PATTERN.test(recipeSha256)) throw new Error("recipe_sha256 must be a lowercase SHA-256 digest");
  const expectedHash = await computeRecipeSha256(input);
  if (recipeSha256 !== expectedHash) throw new Error("recipe_sha256 does not match the recipe contents");

  return {
    schema_version: SELECTOR_RECIPE_VERSION,
    recipe_id: recipeId,
    name,
    origin,
    version,
    authorization: {
      basis: basis as AuthorizationBasis,
      evidence_ref: stringField(input.authorization, "evidence_ref", 500),
      attested_by: stringField(input.authorization, "attested_by", 200),
      attested_at: attestedAt,
      expires_at: expiresAt,
    },
    selectors,
    role_map: roleMap,
    expectations: {
      root_count: 1,
      min_items: minItems,
      max_items: maxItems,
      content_nodes_per_item: 1,
      max_text_characters_per_item: maxText,
    },
    fingerprint_probes: probes,
    recipe_sha256: recipeSha256,
  };
}

export function assertAuthorizedCaptureContext(
  tab: { url?: string; incognito: boolean },
  recipe: AuthorizedSelectorRecipe,
): URL {
  if (tab.incognito) throw new Error("Incognito capture is disabled");
  if (!tab.url) throw new Error("The active tab has no capturable URL");
  const activeUrl = new URL(tab.url);
  if (!(["http:", "https:"] as string[]).includes(activeUrl.protocol)) throw new Error("Only HTTP(S) pages can be captured");
  if (isBlockedCommercialOrigin(activeUrl.origin)) {
    throw new Error("Use the service's official export instead of capturing this commercial AI web origin");
  }
  if (activeUrl.origin !== recipe.origin) throw new Error("The active tab origin does not match the authorized recipe origin");
  if (Date.parse(recipe.authorization.expires_at) <= Date.now()) throw new Error("Authorization evidence has expired");
  return activeUrl;
}
