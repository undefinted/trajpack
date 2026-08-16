# trajpack

`trajpack` is a local-first observable trajectory ETL and compliance router for
Codex, Claude Code, DeepSeek Harness, official account exports, and websites the
user owns or is explicitly authorized to collect.

It does **not** claim to recover hidden chain-of-thought. Every reasoning part is
classified as provider-exposed reasoning, a provider summary, a generated
rationale, an opaque state, or unavailable. Opaque states never enter a training
view.

## What v1 contains

- TypeScript adapters for Codex JSON events/hooks, Claude Code stream-json/hooks,
  and DeepSeek Harness `session/event`.
- Argon2id + XChaCha20-Poly1305 secretstream `.trajpack` vault files.
- Deterministic `trajectory/0.1` normalization with W3C trace/span topology.
- Independent archive, automatic-capture, noncompetitive-training,
  competitive-distillation, and redistribution decisions.
- A loopback-only React review workbench with per-event selection, redaction,
  rights overrides, approval, and plaintext export confirmation.
- Canonical, ATIF, HF/TRL JSONL + Parquet, and OTLP/OpenInference-oriented
  exports, each with checksums, lineage, a dataset card, a redaction report, and
  an independent data-license summary.
- Content-bound multi-trace dataset plans with deterministic group splits,
  cross-split contamination checks, per-trace gate revalidation, and atomic
  plaintext publication.
- An intentionally narrow Chromium MV3 extension for authorized sites. It has no
  ChatGPT, Claude, or DeepSeek selectors and does not intercept network traffic.

Training code is deliberately out of scope.

## Build

Requirements: Node.js 24 and pnpm 11.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm audit --prod
pnpm test:pack
pnpm trajpack --help
```

The first vault command asks for a passphrase of at least 12 characters. For
non-interactive tests, `TRAJPACK_PASSPHRASE` is supported; do not put it in shell
history or source control.

## First supported distillation path

The shortest path that does not depend on a commercial provider permission is
an exact, locally licensed model running through the pinned DeepSeek Harness.
Point trajpack at the actual local weight file or snapshot directory so it can
compute the provenance digest itself; also record the real model identifier,
actual SPDX model license, and the license for your input data. Placeholders and
caller-supplied digest strings do not pass the default training gate:

```bash
pnpm trajpack capture dsh \
  --provider self_hosted --account-type self_hosted \
  --model deepseek-r1-distill-qwen-7b \
  --model-artifact /models/deepseek-r1-distill-qwen-7b \
  --model-license ${MODEL_WEIGHTS_SPDX_LICENSE} \
  --input-rights owned --third-party none \
  --source-license Apache-2.0 --rights-holder my-lab \
  --consent-purpose distillation \
  --target-model-owner me --target-product my-open-model --competitive yes \
  -- dsh
```

Use the real license expression from the model card or distribution; `MIT` and
`Apache-2.0` above are examples, not a claim about arbitrary weights or data.
Custom `LicenseRef-*` strings remain archive-only in v1 because they do not by
themselves prove training rights.

The local artifact digest proves what trajpack hashed, but v1 cannot prove that
the spawned Harness process actually loaded those exact bytes. Before training,
bind the lab's retained run configuration, container attestation, or model-load
receipt to a trace-scoped decision, then approve that exact mode/target in the
reviewer:

```bash
pnpm trajpack policy override <captured-trace-id> \
  --dimension training_competitive_distillation --status allow \
  --reviewer runtime-provenance-reviewer \
  --evidence-kind model-load-receipt \
  --evidence-file ./evidence/dsh-model-load-receipt.json \
  --expires 2027-08-16T00:00:00Z \
  --reason "reviewed model artifact, dsh configuration, and target use" \
  --target-model-owner me --target-product my-open-model \
  --competitive yes --yes
```

The offline DeepSeek API-artifact path is also first-class and never performs a
network request. Save the exact official Chat Completions JSON (or streaming
JSONL), then import it with conservative shape validation. Shape recognition is
not provider authentication: offline responses are recorded as
`user_supplied`, so they cannot receive default training eligibility merely by
containing a DeepSeek model name. A terms snapshot and scoped permission are
useful rights evidence; training additionally needs a trace-scoped manual
decision whose evidence identifies the request receipt or other teacher-source
provenance reviewed by the operator:

```bash
pnpm trajpack import ./deepseek-response.json \
  --source-hint deepseek-api \
  --permission-evidence ./evidence/deepseek-api-permission.json \
  --permission-document ./evidence/deepseek-api-order-form.pdf \
  --permission-evidence-kind contract \
  --input-rights owned --third-party none \
  --source-license Apache-2.0 --rights-holder my-lab \
  --consent-purpose distillation \
  --target-model-owner me --target-product my-open-model --competitive yes

pnpm trajpack policy override <imported-trace-id> \
  --dimension training_competitive_distillation --status allow \
  --reviewer provenance-reviewer \
  --evidence-kind request-receipt \
  --evidence-file ./evidence/deepseek-request-receipt.json \
  --expires 2027-08-16T00:00:00Z \
  --reason "teacher source and intended use reviewed" \
  --target-model-owner me --target-product my-open-model \
  --competitive yes --yes
```

`reasoning_content` is labeled `provider_exposed_reasoning`; trajpack never
renames it to hidden or raw chain-of-thought. DeepSeek Harness capture is pinned
to the exact `0.1.0-rc.6` compatibility profile; the wrapper checks
`dsh --version` before opening the vault. This is a trajpack interface pin, not
a claim that the upstream repository published a stable GitHub release. For a
provider-backed DeepSeek capture, the adapter must also emit a durable
`request/header`: trajpack binds its hashes and reconciles the observed
provider/model with the manifest. Written permission establishes legal scope;
it does not replace this teacher-source binding.

Then run `pnpm trajpack review`. A trace is invisible to training exporters
until automated checks pass, every included content part has known rights, and a
human approves it. Finally:

```bash
pnpm trajpack policy explain <trace-id>
pnpm trajpack export <trace-id> --format hf-trl \
  --mode training_competitive_distillation \
  --output ./exports/my-dataset --plaintext
```

For a research dataset, first define private repo/task-family aliases in a
local group map, then freeze the exact reviewed inputs:

```bash
pnpm trajpack dataset plan <trace-id> <trace-id> \
  --name paper-ablation-1 \
  --mode training_competitive_distillation \
  --target-model-owner my-lab --target-product student-v1 \
  --seed paper-ablation-1 --group-map ./private-groups.json \
  --quality-profile research_strict --output ./paper-ablation-1.build.json

pnpm trajpack export ./paper-ablation-1.build.json --format hf-trl \
  --output ./exports/paper-ablation-1 --plaintext
pnpm trajpack validate ./exports/paper-ablation-1
```

`dataset plan` creates a fresh in-memory 256-bit key and stores only HMAC-SHA-256
group identifiers, never the aliases or key. Re-exporting one build is stable;
planning again deliberately produces new privacy hashes and therefore may
produce a new split assignment. The build also freezes source, approval,
decision, compiler, target, quality, and split-policy versions. HF JSONL is
paired with native nested conversational Parquet, and dataset exports include
structured source/license/redaction statistics. See [the research
workflow](docs/research-workflow.md).

Apply any required `policy override` **before** the final reviewer approval,
because an override resets approval to pending. `policy explain` reports current
managed-trace gates; `validate` on an exported dataset reports reproducible
self-consistency and intentionally does not claim that a copied directory is a
live training authorization. The research workflow also includes ready-to-run
Hugging Face Datasets and TRL loader examples.

The code license is Apache-2.0. Exported data never inherits that license; the
export writes a separate `license-summary.json`.

## Other capture paths

```text
trajpack capture codex -- <codex command>
trajpack capture claude -- <claude command>
trajpack capture dsh -- <dsh command>
trajpack arm <codex|claude> --next-session --cwd <path> --ttl 10m
trajpack import <official-export-or-trajpack>
trajpack review
trajpack validate <trace-or-dataset>
trajpack dataset plan <trace-ids...> --output <build.json> ...
trajpack policy explain <trace>
trajpack export <selection> --format canonical|atif|hf-trl|otlp
trajpack delete <trace-id>
```

`trajpack import ./export.zip --source-hint chatgpt` (or `claude`) accepts a
user-downloaded official export without extracting it. ChatGPT single-file and
contiguous numbered conversation JSON layouts and Claude `conversations.json`
are shape-validated; the encrypted raw record keeps the archive and selected
entry hashes. Ambiguous or unsafe archives are rejected.

The Codex App Server mapper is an offline, exact-version adapter for typed v2
JSON-RPC records. `trajpack capture codex` deliberately requires the official
`codex exec --json` surface and suppresses provider JSON stdout so shell
redirection cannot become an accidental plaintext spool. Rich interactive
clients use the one-shot `arm` hook path; trajpack does not proxy App Server
stdio in v1.

All capture/import commands also require the source/account/terms/rights options
appropriate to the trace. Unknown fields fail closed. `policy override` exists
only for one trace and one decision dimension, and requires reviewer identity,
evidence, purpose/target scope, expiry, and explicit confirmation.
Self-hosted model traces additionally require the ordered weights/model license
chain through `--model-license <expression...>` before a training gate can pass.

See [architecture](docs/architecture.md), [security model](docs/security.md),
[policy semantics](docs/policy.md), [adapters](docs/adapters.md), and
[export mappings](docs/formats.md), plus the [research dataset workflow](docs/research-workflow.md).
Release packaging and the installed-package
smoke test are documented in [release verification](docs/release.md); the v1
dependency, encryption, and permission review is recorded in
[the security audit](docs/security-audit-2026-08-16.md). The research lineage is summarized in
[design references](docs/references.md).

This registry is an engineering safeguard, not legal advice. Confirm the terms,
account type, jurisdiction, order form, source licenses, and intended target for
each dataset.
