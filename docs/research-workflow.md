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

DeepSeek Harness is the lead research integration, while the canonical schema
remains adapter-neutral. The native plugin is pinned to upstream
`0.1.0-rc.6` and subscribes to typed durable events rather than a web or terminal
UI. It preserves the raw `session/event` payload in an encrypted capsule,
including `request/header`, turn/step events, reasoning/text chunks, native tool
calls/results, retry/compaction records, approvals, and subagent activity when
the Harness exposes them. This is lossless with respect to the subscribed
durable event payload, not a claim that unexposed model state or hidden Chain of
Thought was captured.

The live capture integrity contract is deliberately strict:

- the plugin records the upstream `firstLiveSeq` boundary and source session;
- source sequence numbers must be contiguous from that boundary;
- an exact repeated event is idempotent, but a same-sequence content conflict
  aborts/quarantines capture;
- the observed `request/header` route must reconcile with declared
  provider/model provenance;
- per-session forwarding is ordered, non-2xx delivery is an error, and
  flush/session disposal drains queued delivery;
- the collector encrypts immediately and no plaintext fallback spool is used.

Run the plugin through the wrapper so the short-lived collector capability is
scoped to the process tree:

```bash
trajpack capture dsh -- dsh <arguments>
```

For an existing Harness artifact, the separate persistence importer accepts
only the official **unpacked, uncompressed v0 session JSONL** layout: one session
header followed by contiguous unpacked event rows.

```bash
trajpack import ./sessions/session.jsonl \
  --source-hint dsh-session \
  --provider <actual-model-provider> \
  --account-type <account-class> \
  --terms ./evidence/provider-terms.snapshot.json
```

That import has fidelity B and `user_supplied` authenticity. It validates the
shape and event sequence but does not cryptographically authenticate the
producer. Packed/chunk rows, zstd-compressed persistence, unknown versions, and
sequence gaps fail closed. Use native capture or create an explicitly unpacked,
uncompressed artifact with the pinned Harness version; trajpack does not guess
how to decode unknown storage layouts. See the focused
[DeepSeek Harness research path](deepseek-research.md).

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

`trace_full` remains the frozen multi-trace build recipe in v0.1 for sources
whose topology can be projected unambiguously. The HF compiler separates source
sessions and parent-linked message branches within that view. DeepSeek Harness
is intentionally excluded from `trace_full` HF/TRL export: its request epochs,
surface replacement, route changes, and three-layer tool lifecycle require an
explicit versioned recipe. Approved **single traces** can use one of seven
versioned training-view recipes; those recipes are not yet accepted by
`dataset plan`, so they cannot be silently mixed into a multi-trace build.

| Single-trace recipe | Training semantics | Required evidence |
| --- | --- | --- |
| `answer_sft` | Supervise completed assistant answer text. | Completed, privacy-cleared assistant/agent message. |
| `reasoning_sft` | Supervise observable reasoning explicitly opted into this view. | Complete `provider_exposed_reasoning`, visible source field, and provider `chain_of_thought` claim. Partial-only streams, summaries, opaque and unavailable states are excluded. |
| `tool_use_sft` | Supervise native function name and arguments, preserving proven parallel calls. | Stable call IDs and an observed result for every call. Results are evidence, not inferred rewards. |
| `deepseek_epoch_sft` | Supervise a completed Harness assistant output against its exact request epoch. | Complete sequence-zero rc.6 raw log; raw integrity; exact reviewed canonical alignment; matching provider/model; request header, system, native tools, and compaction-aware model-visible surface; reconstructable output. |
| `failure_recovery` | Supervise an observed recovery action after failure. | Failed tool result, explicit retry marker, recovery action, and observed successful result; no synthetic success label. |
| `subagent_handoff` | Supervise a completed delegated response. | Correlated `agent.invoke`/`handoff` events and privacy-cleared delegated context. |
| `pointwise_reward_rl_ready` | Export a response with verified scalar-reward evidence for downstream reward-model/RL research. | Finite numeric reward, versioned verifier evidence, matching reviewer confirmation, and a preceding completed response. This is not a DPO pair or step reward. |

Example:

```bash
trajpack export <trace-id> \
  --format hf-trl \
  --recipe deepseek_epoch_sft \
  --mode training_competitive_distillation \
  --output ./exports/dsh-exact-epoch-ablation \
  --plaintext

trajpack validate ./exports/dsh-exact-epoch-ablation
```

The exporter writes the recipe/compiler versions, source/target/evidence event
IDs, component-level loss targets, exclusions, and compilation digest to
`training-view-report.json`. If no candidate passes the recipe contract, export
fails instead of producing an empty or weakly labelled dataset. The public core
entry point does not expose the recipe compiler as a policy bypass; managed
export rechecks training eligibility and approval scope first.

For DeepSeek Harness, distinguish the cross-adapter recipes from the exact
recipe. The generic views validate the approved teacher route but do not replay
the Harness surface. They block a target if an earlier `surfaceOp: replace`
means the model-visible prefix cannot be obtained by simple canonical ordering,
and direct the researcher to `deepseek_epoch_sft`. That exact recipe runs the
pinned `dsh-epoch/0.1` replay over integrity-bound rc.6 raw capsules, applies
append/replace surface operations, selects the latest request header, and binds
provider, model, system, native tools, input surface, and output back to the
reviewed canonical events and content hashes.

Resumed partial capture is not repairable by selecting the exact recipe:
`firstLiveSeq > 0` blocks every training view because the pre-existing context
is absent. Recapture or import a complete sequence-zero log. The exact recipe
also rejects missing request headers, provider/model route mismatch,
raw/canonical drift or review exclusion, non-`passed` exact content, unsupported
required records, invalid surface replacements, and incomplete request epochs.

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

## 7. Derive content-free research analytics

After approval, derive workload and training-yield statistics without exporting
prompt, reasoning, tool, file, code, or patch content:

```bash
trajpack analyze <trace-id> [<trace-id> ...] --format summary
trajpack analyze <trace-id> [<trace-id> ...] --format tracelab-jsonl
```

`summary` emits deterministic aggregate research metrics. `tracelab-jsonl`
emits a deliberately lossy, content-free row projection for workload-analysis
tools. It is inspired by [TraceLab](https://github.com/uw-syfi/TraceLab), but
TraceLab is not a runtime dependency and the projection is never a training
source. It cannot reconstruct the canonical trajectory.

The product boundary is intentional: TraceLab studies agent-serving workload
behavior, whereas trajpack retains the governed canonical evidence needed to
derive auditable SFT and verifier-backed pointwise-reward views. Rights,
redactions, content, topology, review state, and lineage stay in trajpack's
encrypted/canonical layers; the TraceLab-shaped output is analytics-only.

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
- DeepSeek Harness persistence import supports only unpacked, uncompressed v0
  JSONL. Packed/chunked and zstd persistence are rejected rather than decoded
  heuristically.
- Generic DeepSeek Harness recipes block resumed context and targets after a
  surface replacement rather than guessing the model-visible input. Use a
  complete sequence-zero trace with `deepseek_epoch_sft` for exact request-epoch
  reconstruction; a resumed partial trace is rejected by that recipe as well.
- `reasoning_sft` cannot recover hidden reasoning and accepts only complete
  provider-exposed reasoning. `pointwise_reward_rl_ready` is verified scalar-reward
  evidence for downstream reward-model/RL research; pair construction, RL
  optimization, and trainers remain out of scope.
- Reviewer/verifier evidence is hash-bound but not yet signed with an
  independent laboratory key.
- A single-user consent receipt cannot model every multi-participant or
  workspace-contributor case; those datasets require external scoped evidence
  and conservative exclusion.
