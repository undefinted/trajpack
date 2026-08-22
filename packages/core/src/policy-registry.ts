import type { AccountType, DecisionStatus, Provider, Source } from "@trajpack/schema";

export interface PolicyRegistryEntry {
  id: string;
  provider: Provider;
  account_types: AccountType[];
  authority_url: string;
  reviewed_at: string;
  /**
   * Byte hashes that were independently reviewed for this exact registry
   * entry. An empty list deliberately means URL matching may identify the
   * authority, but cannot activate an allow default for training.
   */
  accepted_snapshot_sha256: readonly string[];
  /**
   * Optional observable-source scope for an agreement that is narrower than
   * the provider/account pair. All listed dimensions must match. This keeps a
   * file that merely resembles an API response from asserting that an API
   * agreement governed its creation.
   */
  source_scope?: {
    surfaces?: readonly Source["surface"][];
    capture_methods?: readonly Source["capture_method"][];
  };
  defaults: {
    automatic_capture: DecisionStatus;
    training_noncompetitive: DecisionStatus;
    training_competitive_distillation: DecisionStatus;
  };
  note: string;
}

/**
 * Engineering defaults only. A trace still needs a byte-level terms snapshot,
 * account classification, input/content rights, consent, and human review.
 */
export const POLICY_REGISTRY: readonly PolicyRegistryEntry[] = [
  {
    id: "openai-consumer-row-2026-08",
    provider: "openai",
    account_types: ["consumer"],
    authority_url: "https://openai.com/policies/row-terms-of-use/",
    reviewed_at: "2026-08-16T00:00:00.000Z",
    accepted_snapshot_sha256: [],
    defaults: {
      automatic_capture: "deny",
      training_noncompetitive: "unknown",
      training_competitive_distillation: "deny",
    },
    note: "Official/manual archive only by default; programmatic extraction and competitive-model development remain blocked without scoped written permission.",
  },
  {
    id: "openai-services-agreement-2026-01",
    provider: "openai",
    account_types: ["api", "business", "enterprise", "managed_workspace"],
    authority_url: "https://openai.com/policies/services-agreement/",
    reviewed_at: "2026-08-16T00:00:00.000Z",
    accepted_snapshot_sha256: [],
    defaults: {
      automatic_capture: "allow",
      training_noncompetitive: "unknown",
      training_competitive_distillation: "deny",
    },
    note: "Use only service-provided interfaces. Permitted Exceptions and OpenAI-hosted fine-tuning require evidence specific to the intended target and use.",
  },
  {
    id: "anthropic-output-training-guidance-2026-03",
    provider: "anthropic",
    account_types: ["consumer", "api", "business", "enterprise", "managed_workspace"],
    authority_url: "https://support.claude.com/en/articles/12326764-can-i-use-my-outputs-to-train-an-ai-model",
    reviewed_at: "2026-08-16T00:00:00.000Z",
    accepted_snapshot_sha256: [],
    defaults: {
      automatic_capture: "unknown",
      training_noncompetitive: "unknown",
      training_competitive_distillation: "deny",
    },
    note: "Noncompetitive classifiers and similar narrow systems may be eligible after scope review; general-purpose competing model training requires written approval.",
  },
  {
    id: "google-consumer-terms-2026-08",
    provider: "google",
    account_types: ["consumer"],
    authority_url: "https://policies.google.com/terms",
    reviewed_at: "2026-08-17T00:00:00.000Z",
    accepted_snapshot_sha256: [],
    defaults: {
      automatic_capture: "unknown",
      training_noncompetitive: "unknown",
      training_competitive_distillation: "unknown",
    },
    note: "Enables a current Google Terms snapshot to identify the authority for a user-requested Gemini Takeout archive. It grants no default automatic-capture or training permission; Workspace and API contracts require their own scoped evidence.",
  },
  {
    id: "deepseek-terms-2026-03",
    provider: "deepseek",
    account_types: ["consumer", "api", "business", "enterprise"],
    authority_url: "https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html",
    reviewed_at: "2026-08-16T00:00:00.000Z",
    accepted_snapshot_sha256: [],
    defaults: {
      automatic_capture: "allow",
      training_noncompetitive: "allow",
      training_competitive_distillation: "allow",
    },
    note: "The authority match also permits a user-requested local archive under the archive gate. Only official API/harness outputs may enter default distillation review when every other gate passes; this never authorizes automated capture of the DeepSeek website.",
  },
  {
    id: "deepseek-open-platform-2026-04",
    provider: "deepseek",
    account_types: ["api", "business", "enterprise"],
    authority_url: "https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html",
    reviewed_at: "2026-08-22T00:00:00.000Z",
    accepted_snapshot_sha256: [],
    source_scope: {
      surfaces: ["api", "harness"],
      capture_methods: ["official_stream", "official_hook", "instrumented_harness"],
    },
    defaults: {
      automatic_capture: "allow",
      training_noncompetitive: "allow",
      training_competitive_distillation: "allow",
    },
    note: "Specific agreement effective 2026-04-29 for API/developer tools. It applies alongside the general DeepSeek Terms to observable live API or instrumented Harness capture; an offline/manual copy cannot establish that applicability from response shape alone. Every applicable authority must be present, current, and independently hash-pinned (or replaced by scoped evidence).",
  },
  {
    id: "self-hosted-open-weights",
    provider: "self_hosted",
    account_types: ["self_hosted"],
    authority_url: "https://github.com/deepseek-ai/DeepSeek-R1",
    reviewed_at: "2026-08-16T00:00:00.000Z",
    accepted_snapshot_sha256: [],
    defaults: {
      automatic_capture: "allow",
      training_noncompetitive: "allow",
      training_competitive_distillation: "allow",
    },
    note: "Eligibility remains the intersection of weights/model license, host, inputs, repository, tools, participant consent, and target use.",
  },
] as const;
