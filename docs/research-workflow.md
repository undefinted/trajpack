# Research dataset workflow

`trajpack` treats a publishable research dataset as a reproducible derivation
from individually reviewed encrypted traces. A directory scan or mutable query
is not a dataset selection.

## Minimal execution order

Use one immutable experiment directory for the build file, evidence receipts,
training configuration, and the final `validate` output. The safe order is:

```text
capture or import
  -> policy explain
  -> evidence-backed policy override, only when required
  -> review and target-scoped approval
  -> dataset plan
  -> plaintext export to a new directory
  -> validate the complete export directory
  -> load the validated split files
```

The order matters: `policy override` resets human approval to `pending`, so an
override applied after review must be reviewed again. Neither a schema-valid
build file nor a copied export directory is a live authorization token.

## 1. Capture and review traces

Capture only provider-visible trajectory data that you own or are allowed to
use, then run `trajpack review`. Each trace needs passing automated checks and a
human approval scoped to the exact training mode and target. Imported response
shape is not provider authentication: inspect the manifest `authenticity` tier
and attach trace-scoped evidence before relying on a teacher identity.

For provider-backed DeepSeek Harness capture, keep the exact model ID on the
command line and verify that the pinned adapter emitted a durable
`request/header` event. Trajpack reconciles its provider/model with the manifest
and binds the observed raw envelope hashes as `native-request-header:sha256:...`.
A missing header, conflicting header, or a legal permission document cannot be
treated as teacher-source proof. This local observation detects configuration
drift but is not a provider signature.

For self-hosted weights, use `--model-artifact` so trajpack hashes the actual
file or snapshot directory. That proves which local bytes were observed, not
which bytes the Harness process loaded. Retain a run configuration, container
attestation, or model-load receipt and bind it with a trace-scoped manual
override before final review.

`--permission-document` is never a standalone switch. Pair it with
`--permission-evidence`, whose JSON must describe the provider, account class,
capture method, permitted purposes, validity window, reviewer, and exact target.
The CLI replaces (or checks) `evidence_ref` with a digest of the retained
document. For an offline DeepSeek API response, the capture method is
`manual_copy`; for native Harness it is `instrumented_harness`:

```json
{
  "provider": "deepseek",
  "account_type": "api",
  "capture_methods": ["manual_copy"],
  "origins": [],
  "permitted_purposes": ["training_competitive_distillation"],
  "target_model_owner": "my-lab",
  "target_product": "student-v1",
  "reviewer": "contracts-team",
  "effective_at": "2026-08-01T00:00:00.000Z",
  "expires_at": "2027-08-01T00:00:00.000Z"
}
```

This metadata establishes only the reviewed permission scope. An offline API
response remains `user_supplied` and separately needs teacher-source evidence
in the manual training decision. For Harness collection, permission metadata
must also include `automatic_capture` if it is the authority for capture.

## 2. Define leakage groups

Create a private JSON object that maps every selected trace ID to a stable
repo/task/problem-family alias:

```json
{
  "0123456789abcdef0123456789abcdef": "repo-A/task-family-17",
  "fedcba9876543210fedcba9876543210": "repo-A/task-family-17"
}
```

The alias file stays outside the exported dataset. Each `dataset plan` run
creates a fresh random 256-bit secret, derives domain-separated HMAC-SHA-256
group IDs, and clears the secret from its working buffer after use. Neither the
aliases nor the secret are written to the build or logs. All traces with one
alias land in one split. Re-exporting an existing build is deterministic;
running `plan` again creates different privacy hashes and may assign different
splits, so preserve the build file with the experiment. Without a map trajpack
can fall back to per-trace groups, but `research_strict` rejects that fallback
for a multi-trace dataset because it cannot prove repo/task isolation.

## 3. Freeze a build

```bash
trajpack dataset plan <trace-id> <trace-id> \
  --name paper-ablation-1 \
  --mode training_competitive_distillation \
  --target-model-owner my-lab --target-product student-v1 \
  --seed paper-ablation-1 \
  --train 8000 --validation 1000 --test 1000 \
  --group-map ./private-groups.json \
  --quality-profile research_strict \
  --output ./paper-ablation-1.build.json
```

Ratios are basis points and must total 10000. The build freezes, per trace:

- trace ID and privacy-safe group hash;
- source bundle and approval-scope hashes;
- eligibility decision ID and exact target;
- view, quality, and dedupe compiler versions;
- view recipe, quality profile, split algorithm, ratios, and seed.

Planning runs the same per-trace quality warning gates as export. A strict plan
therefore fails immediately on missing repo/test/verifier evidence rather than
creating a build that can never be exported.

`trace_full` is the only v0.1 view recipe. The HF compiler still separates
source sessions and parent-linked message branches within that recipe. Other
recipes (turn-level, recovery-only, tool-policy) are intentionally not exposed
until they have versioned topology fixtures.

## 4. Export transactionally

```bash
trajpack export ./paper-ablation-1.build.json \
  --format hf-trl \
  --output ./exports/paper-ablation-1 \
  --plaintext
```

Every trace is reopened from the managed vault and rechecked. A changed source,
approval, decision, expired permission, unknown right, wrong target, or failed
quality profile aborts the entire build. Exact dedupe fingerprints the complete
canonical training view—including short prompts, patches, tool arguments and
tool results—while shared individual parts are reported separately and do not
become a boilerplate false-positive gate. A frozen second pass normalizes
natural-language tokens, code/patch tokens, and canonical tool arguments and
results into one-way shingles. A bounded inverted index proposes candidates;
only an exact set-Jaccard score of at least 80% is reported. The audit records
trace IDs, splits, similarity basis points, and signature hashes, never prompt
or tool content. `research_strict` blocks candidates both within and across
splits; other profiles emit explicit warnings. Any source-byte, shingle,
posting-list, candidate-pair, or comparison limit makes the scan incomplete
and blocks every profile rather than silently accepting an unchecked dataset.
Direct and transitive lineage
components are kept in one split. The final directory appears only after all
split files, lineage, statistics, checksums, manifest, and completion marker
exist.

HF output contains `splits/{train,validation,test}/dataset.jsonl` and native
nested conversational Parquet. Hugging Face Datasets reads `messages`, tool
calls, loss masks, and training targets as lists/structs rather than JSON string
columns; only open-ended tool JSON Schema and metadata use explicitly named
JSON sidecars. `dataset-stats.json` aggregates provider, model, authenticity,
capture, license, rights, redaction, quality, reward, and verifier counts.
ATIF contains per-split `ATIF-v1.7` JSONL. Canonical retains per-trace files in
their assigned split, and OTLP aggregates resource spans per split.

## 5. Validate and record the experiment

```bash
trajpack validate ./exports/paper-ablation-1
```

Directory validation checks safe and exact artifact membership, streaming
SHA-256 and byte counts, every manifest/build/split/completion/audit binding,
the selected canonical bundle hashes, and HF Parquet-to-JSONL row equality. It
also reruns the frozen view/dedupe/quality compilers over each canonical
selected view and canonical-compares the resulting audit and complete source,
rights, redaction, quality, reward, and verifier statistics. Rewriting
`dataset-stats.json` or a training-view fingerprint together with the manifest,
completion marker, and every checksum therefore still fails validation. An
unsupported historical compiler version fails closed instead of being silently
reinterpreted by the current compiler.
The result is named `self_consistent`: it does not pretend that a copied archive
is training-authorized. `training_eligibility_attestation_present` is false for
archive exports, `current_policy_rechecked` remains false, and current
authorization requires reopening the managed vault. `checksum_self_consistent`
only means the public checksum inventory matches the files; checksums are not a
signature and do not establish provider or teacher authenticity.

Record the dataset ID, build file hash, target model revision, tokenizer and
chat-template revision, and training configuration in the paper artifact. The
current HF `assistant_loss_mask` is message-level audit metadata, not a token
mask. TRL assistant-only loss requires generation markers in the selected chat
template; component-level `training_targets` are pre-tokenization intent.

Before training, archive the complete JSON output of validation. A successful
dataset-directory validation reports `self_consistent: true`, not
`training_ready: true`: it checks public artifacts without reopening the
encrypted managed traces. For a fresh authorization check, inspect each managed
trace with `trajpack policy explain`, then export the frozen build again to a
new directory; export rechecks every current gate and frozen binding.

## 6. Load HF Datasets and TRL

Validate the complete directory first, then load only non-empty splits. JSONL
preserves the direct TRL conversational/tool schema; Parquet is a native nested
analytics representation whose deliberately open-ended JSON leaves are named
`parameters_json` and `metadata_json`.

```python
from pathlib import Path
from datasets import load_dataset

root = Path("exports/paper-ablation-1")
json_files = {
    split: str(root / "splits" / split / "dataset.jsonl")
    for split in ("train", "validation", "test")
    if (root / "splits" / split / "dataset.jsonl").stat().st_size > 0
}
dataset = load_dataset("json", data_files=json_files)

# Native nested Parquet is useful for independent inspection/evaluation.
parquet_files = {
    split: str(root / "splits" / split / "dataset.parquet")
    for split in json_files
}
audit_dataset = load_dataset("parquet", data_files=parquet_files)
```

TRL can consume the JSONL `messages`/`tools` columns as a conversational
dataset. Select only training-consumed columns so lineage metadata remains an
audit sidecar, and pin the TRL, Transformers, tokenizer, model revision, and
chat-template hash in the experiment:

```python
from trl import SFTConfig, SFTTrainer

train = dataset["train"].select_columns(["messages", "tools"])
trainer = SFTTrainer(
    model="path-or-pinned-model-revision",
    train_dataset=train,
    args=SFTConfig(
        output_dir="runs/paper-ablation-1",
        assistant_only_loss=True,
    ),
)
```

Set `assistant_only_loss=True` only after verifying that the selected chat
template emits TRL generation markers. TRL does not consume trajpack's
message-level `assistant_loss_mask` or component-level `training_targets` as
token masks. If a template lacks markers, stop and define a versioned
tokenization/masking pass rather than silently changing the supervision target.

## Failure-oriented checklist

| Symptom or reason | What to inspect | Safe action |
| --- | --- | --- |
| `SELF_HOSTED_RUNTIME_BINDING_REQUIRED` | exact weights digest and retained model-load/run evidence | apply a trace-scoped, expiring override, then review again |
| teacher authenticity is unverified | capture surface, `request/header`, offline request receipt | exclude the trace or bind independently reviewed source evidence |
| terms/permission is missing, stale, or mismatched | provider, account, capture method, target, dates, document digest | create corrected scoped evidence; never reuse a broader label |
| target, rights, or consent is unknown | `policy explain` decisions and per-content rights in reviewer | resolve or exclude unknown material |
| strict dataset planning is blocked | repo/task group map, quality report, verifier/test evidence | repair evidence or choose a documented weaker profile; do not bypass silently |
| directory validation is self-consistent but not training-ready | `current_policy_rechecked` and `training_ready` fields | re-open managed traces by exporting the frozen build again |

## Current research limits

- Exact and canonical-shingle/Jaccard cross-trace deduplication are implemented.
  Embedding-semantic, code-AST, and behavioral equivalence checks are not yet
  included; the current detector intentionally favors reproducibility and
  privacy-safe audit output over semantic recall.
- Tokenizer-aware truncation, packing, and context-window recipes are not in v1.
- Reviewer/verifier evidence is hash-bound but not yet signed with an
  independent laboratory key.
- A single-user consent receipt cannot model every multi-participant or
  workspace-contributor case; those datasets require external scoped evidence
  and conservative exclusion.
