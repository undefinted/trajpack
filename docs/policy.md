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

Provider/product shape and source authenticity are independent. Native typed
streams are `locally_observed`; official/manual exports and offline API JSON are
`user_supplied`. The `request_receipt_verified` and
`cryptographically_verified` enum values are reserved for a future trusted
verifier result; v1 has no such verifier, so an arbitrary evidence-reference
string never upgrades a source or creates a default training allow. In
particular, an OpenAI-compatible JSON object with a DeepSeek model name is not a
trusted DeepSeek teacher. It remains archiveable, but training requires a
trace-scoped reviewer decision with evidence for the teacher-source claim as
well as the separate rights/terms decision.

Importing an encrypted `.trajpack` is also a new trust boundary: knowledge of
its passphrase proves only frame integrity. Re-import keeps the recorded source
labels and the original consent/withdrawal state, but downgrades source
authenticity to `user_supplied` (or leaves it `unknown`), clears authenticity
evidence, and does not inherit unsigned scoped-permission assertions. Provider,
account, model, origin, interface, and model-digest labels cannot be changed by
the re-import command.

For a self-hosted Harness source, a model name or user-entered digest alone is
not sufficient. The default path requires a native `locally_observed` capture,
a `sha256:<digest>` weights snapshot, and a locally generated evidence binding
of the exact form `local-model-artifact:sha256:<digest>`. This records local
artifact observation; it is not a model-vendor signature.
It also does not prove that the captured process loaded that artifact. As a
result, self-hosted training remains `unknown` until a trace-scoped manual
decision binds a retained run configuration, model-load receipt, container
attestation, or equivalent evidence file to the exact target and use.

`trajpack policy snapshot` hashes a locally downloaded terms document. The tool
does not download or interpret it. `trajpack policy override` is intentionally
trace- and dimension-scoped, expiring, evidence-backed, and resets human
approval. There is no global bypass.

A manual override's evidence is content-bound, not a free-form label. Its
`evidence_ref` must have the canonical form
`<kind>:sha256:<64-lowercase-hex>`, where `kind` is a lowercase safe token such
as `contract`, `teacher-receipt`, or `ethics-approval.v1`. The CLI computes this
reference by streaming a regular local evidence file with a 64 MiB limit and
rejecting symbolic links or files that change while being read. Keep the exact
external file under the research project's evidence-retention controls: v1
records its digest but deliberately does not embed the file in the vault or
claim that the file or digest is cryptographically signed. Supply it with
`--evidence-kind <kind> --evidence-file <path>`; the CLI does not accept a
caller-authored digest in place of reading the file.

`--written-permission <reference>` records a lineage reference only. It never
changes a decision or substitutes for a pinned terms snapshot by itself. To use
a contract or written authorization as a hard-gate input, pass a local JSON
metadata file with `--permission-evidence <json>` and the actual retained order
form or permission document with `--permission-document <path>`. The CLI hashes
the latter with the same bounded, symlink-safe reader used for manual overrides;
the resulting canonical artifact reference is stored in the encrypted manifest.
The metadata must match the provider, account class, capture method, origin,
requested purpose, reviewer, validity window, and—for training—the exact target
model owner and product. A caller-authored label, missing document, mismatch, or
expired scope fails closed. The digest proves which bytes were reviewed, not who
issued them; validating the issuer and legal effect remains the named reviewer's
responsibility.

```json
{
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
