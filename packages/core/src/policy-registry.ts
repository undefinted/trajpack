import type { AccountType, DecisionStatus, Provider } from "@trajpack/schema";

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
    id: "deepseek-terms-2026-03",
    provider: "deepseek",
    account_types: ["api", "business", "enterprise"],
    authority_url: "https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html",
    reviewed_at: "2026-08-16T00:00:00.000Z",
    accepted_snapshot_sha256: [],
    defaults: {
      automatic_capture: "allow",
      training_noncompetitive: "allow",
      training_competitive_distillation: "allow",
    },
    note: "Official API/harness outputs may enter distillation review when all other rights gates pass; this does not authorize automated capture of the DeepSeek website.",
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
