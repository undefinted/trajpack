# Policy and rights gates

Five decisions are stored independently as `allow | deny | unknown`:

1. `local_archive`
2. `automatic_capture`
3. `training_noncompetitive`
4. `training_competitive_distillation`
5. `redistribution`

An allow decision is not enough by itself. A gate also checks active consent,
known provider/account classification, current non-conflicting terms snapshots,
input and third-party rights, source license, target owner/product,
competitiveness, redaction state, quality checks, tombstones, and human approval.
Any unknown or expired prerequisite blocks.

Host and model provider are separate. A DeepSeek Harness trace using an OpenAI
or Anthropic model receives the provider policy, not the Harness policy. Final
eligibility is the intersection of host access, provider/account terms, model
license, inputs/repository, tool outputs, participant consent, and target use.

The built-in registry records engineering defaults and official authority URLs:

- OpenAI consumer: manual/official archive only by default; competitive general
  model training denied.
- OpenAI API/business: official interfaces only; competitive training denied
  unless a scoped contract, OpenAI-hosted customization, or applicable Permitted
  Exception is evidenced.
- Anthropic consumer/Pro/Max: automated access and competing general model
  training denied by default.
- Anthropic API/Team/Enterprise: official capture can be reviewed;
  noncompetitive narrow tasks require scope evidence; competing general models
  require written approval.
- DeepSeek API or a legitimately sourced model in Harness: distillation may be
  reviewed when all other gates pass. That permission never legitimizes webpage
  scraping.
- Self-hosted models: model/weights license, input rights, and tool/repository
  rights must still be known.

`trajpack policy snapshot` hashes a locally downloaded terms document. The tool
does not download or interpret it. `trajpack policy override` is intentionally
trace- and dimension-scoped, expiring, evidence-backed, and resets human
approval. There is no global bypass.

`--written-permission <reference>` records a lineage reference only. It never
changes a decision or substitutes for a pinned terms snapshot by itself. To use
a contract or written authorization as a hard-gate input, pass a local JSON
document with `--permission-evidence <json>`. The evidence is stored in the
encrypted manifest and must match the provider, account class, capture method,
origin, requested purpose, reviewer, validity window, and—for training—the exact
target model owner and product. A mismatch or expired scope fails closed.

```json
{
  "evidence_ref": "contract:order-form-2026-17",
  "provider": "deepseek",
  "account_type": "api",
  "capture_methods": ["instrumented_harness"],
  "origins": [],
  "permitted_purposes": [
    "automatic_capture",
    "training_competitive_distillation"
  ],
  "target_model_owner": "example-lab",
  "target_product": "example-general-model-v1",
  "reviewer": "contracts-team",
  "effective_at": "2026-08-01T00:00:00.000Z",
  "expires_at": "2027-08-01T00:00:00.000Z"
}
```

For an origin-scoped authorized site, list canonical origins such as
`https://research.example`; a permission carrying origins cannot authorize a
source that has no matching `source.origin`. The Chromium authorized-DOM path
also requires its independent raw-envelope authorization attestation. That raw
proof remains the authority for its one clicked capture and is not replaced by
this CLI evidence file.

This policy registry is not legal advice and does not replace an applicable
order form or counsel review.
