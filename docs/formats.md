# Canonical and export formats

`trajectory/0.1` is the internal truth source. It uses 32-hex W3C trace IDs,
16-hex span IDs, parent/link topology, strict sequence numbers, source IDs,
typed content parts, usage/cost, reasoning representation, per-part rights and
redaction, and review dispositions.

- **Canonical** writes `manifest.json` and selected `events.jsonl`.
- **ATIF** writes an `ATIF-v1.7` trajectory with the required `agent` and
  `steps` roots. Step IDs start at 1 and are contiguous; canonical actors map
  to ATIF's `system | user | agent` sources. Adjacent tool calls are grouped
  only when a complete source session/turn/step boundary proves that they came
  from the same step, and matched results become `observation.results` linked
  by `source_call_id`. Missing boundaries remain separate steps rather than
  inventing parallelism. Tool arguments that are not JSON objects are wrapped
  explicitly so the ATIF object requirement is preserved without data loss.
  Fields the target cannot express remain in `provenance.json`. ATIF is also an
  archival interchange target; HF/TRL alone requires an explicit training gate.
- **HF/TRL** writes conversational JSONL and native nested Parquet with `messages[]`, native
  tool calls and `tool` roles, tool metadata, an aligned message-level audit
  mask, and component-level pre-tokenization `training_targets`. Parallel calls
  share one assistant message only when full source boundaries prove they were
  generated together. Multiple source sessions are separate examples; pure
  parent-linked imported message trees compile one example per leaf path, so
  mutually exclusive ChatGPT branches are never concatenated.
- **OTLP** writes resource spans using a pinned development mapping and content
  hashes rather than prompt bodies.

## Versioned HF/TRL training-view recipes

An approved single managed trace can be compiled into one of seven narrower HF/TRL views
with `trajpack export <trace-id> --format hf-trl --recipe <recipe> ...`. The raw
vault and canonical bundle are not rewritten. The exporter records the recipe,
recipe version, compiler version, source/target/evidence event IDs, component
loss targets, exclusions, and compilation hash in the dataset and
`training-view-report.json`.

| Recipe | Objective | Inclusion contract |
| --- | --- | --- |
| `answer_sft` (`answer-sft/0.1`) | SFT | Completed assistant/agent text; the answer component alone is a loss target. |
| `reasoning_sft` (`provider-exposed-reasoning-sft/0.1`) | SFT | Complete canonical reasoning explicitly classified as `provider_exposed_reasoning`, with a visible source field and provider `chain_of_thought` claim. Partial deltas remain lineage evidence; provider summaries and opaque/unavailable states are excluded. |
| `tool_use_sft` (`native-tool-use-sft/0.1`) | SFT | Native tool name/arguments with stable call IDs and an observed result for every call, including parallel groups. The result is evidence, not a target or inferred reward. |
| `deepseek_epoch_sft` (`deepseek-exact-request-epoch-sft/0.1`) | Exact Harness SFT | A complete sequence-zero `0.1.0-rc.6` raw durable log is replayed into request epochs. Provider/model, request header, system prompt, native tools, compaction-aware surface, and completed output must align with the review-included, privacy-passed canonical projection. The target can contain supported answer, explicit DeepSeek reasoning, and native tool-call components. |
| `failure_recovery` (`evidenced-failure-recovery-sft/0.1`) | SFT | A failed tool outcome, explicit retry evidence, an observable recovery action, and an observed successful outcome. It targets the recovery action and does not create a success label. |
| `subagent_handoff` (`subagent-handoff-sft/0.1`) | SFT | A correlated `agent.invoke`/`handoff` pair with privacy-cleared delegated context and a completed handoff response. |
| `pointwise_reward_rl_ready` (`verified-pointwise-reward/0.1`) | Pointwise reward evidence | A completed response plus a finite numeric reward bound to versioned verifier evidence and matching reviewer confirmation, ready for downstream reward-model/RL research. It is not a chosen/rejected preference pair, step reward, policy-optimization run, or RL trainer. |

Request-header system text and native tool JSON Schemas are carried into
conversation/tool fields when they are present and review-included. Every
recipe requires passing automated checks, target-scoped human training
approval, privacy-cleared selected content, and fresh approval fingerprints.
If no candidate satisfies the recipe, export fails rather than emitting an
empty or synthetically labelled training file. Recipe export is single-trace
in v0.1. Frozen multi-trace dataset builds may continue to use their audited
`trace_full` view for sources with an unambiguous projection. DeepSeek Harness
HF/TRL exports must name an explicit versioned recipe; `trace_full` is rejected
because it cannot safely represent request epochs, surface replacement,
multi-route subagents, and the three-layer tool lifecycle.

The generic recipes are cross-adapter projections; they do not replay Harness
surface state. For a DeepSeek Harness target, they require an included,
privacy-cleared `request/header` and a provider/model route matching the approved
manifest. A resumed trace (`firstLiveSeq > 0`) blocks every recipe because its
earlier model-visible context is absent. A `surfaceOp: replace` before a generic
target blocks that candidate with
`DEEPSEEK_SURFACE_REPLACEMENT_REQUIRES_EXACT_RECIPE`; use a complete
sequence-zero trace with `deepseek_epoch_sft`, which applies the surface
replacement during epoch replay. The exact recipe still rejects resumed partial
logs, missing headers, route mismatch, raw/canonical drift, unsupported required
records, invalid replacement ranges, and any incomplete epoch.

No recipe recovers hidden Chain of Thought. In particular, a long reasoning
string is not sufficient for `reasoning_sft`; its canonical provenance and
completeness must satisfy the explicit representation contract above.

Every format also writes `DATASET_CARD.md`, `lineage.json`,
`quality-report.json`, `redaction-report.json`, `license-summary.json`, and
`checksums.txt`. Excluded
events and content parts are removed before any plaintext serializer runs.
Opaque reasoning states are excluded from training views. Exporters do not
invent preference pairs, rewards, verifier success, or task labels.

## Research analytics and the TraceLab-shaped projection

`trajpack analyze <trace-ids...> --format summary` derives deterministic,
content-free workload and training-yield statistics from approved managed
traces. `--format tracelab-jsonl` emits a deliberately lossy, content-free row
projection for systems-workload analysis inspired by
[TraceLab](https://github.com/uw-syfi/TraceLab).

The projection is not a canonical format, a training view, or a substitute for
review. It omits prompt text, reasoning text, tool arguments/results, code,
patches, and file contents. Canonical content remains encrypted and governed by
trajpack, together with rights, redactions, topology, approval, and lineage.
TraceLab is an analytics inspiration rather than a runtime dependency:
TraceLab studies agent-serving workloads, while trajpack compiles governed
observable evidence into reproducible post-training views.

Single-trace and multi-trace exports are published through a private staging
directory and receive a `COMPLETE` marker before an atomic same-parent rename.
A multi-trace `dataset/0.1` export also writes its frozen `selection.json`,
`dataset-manifest.json`, `dataset-stats.json`, a dataset-level contamination
report, per-split files, and checksums. The manifest freezes view, quality, and
dedupe compiler versions. `dataset-audit/0.2` includes exact training-view
hashes, only the part hashes that actually collide, and a frozen
canonical-shingle near-duplicate pass. Near-duplicate entries
contain only trace IDs, assigned splits, integer Jaccard basis points, and a
pair signature hash; source shingles and content are not serialized. The audit
also binds the algorithm, 80% threshold, resource-limit digest, record/feature
counts, candidate/comparison counts, and complete/fail-closed status. HF split
files are directly loadable as `train`, `validation`, and `test`; the original per-trace canonical lineage remains
available under the export tree. Parquet stores messages, tool calls, tool
roles, loss masks, targets, rewards, and verifier identity as native lists and
structs. Only open-ended tool parameters and arbitrary metadata retain
explicitly named JSON sidecar leaves.

For a single-trace HF export, the files are `dataset.jsonl` and
`dataset.parquet` at the export root. A multi-trace build writes each under
`splits/<split>/`. Use `datasets.load_dataset("json", data_files=...)` for the
direct TRL conversational/tool view. Use
`datasets.load_dataset("parquet", data_files=...)` for native nested inspection
or evaluation; its open-ended leaves are intentionally named
`tools.function.parameters_json` and `metadata_json`, so decode those sidecars
before treating the Parquet `tools` column as a training API schema. The
complete loader example is in [the research workflow](research-workflow.md).

`assistant_loss_mask` is not a token mask and is not silently presented as one.
Current TRL assistant-only loss depends on generation markers in the selected
chat template. `dataset_info.json` records that contract, while
`training_targets` identifies intended answer/reasoning/tool components before
tokenization. A future tokenized exporter must bind tokenizer revision, chat
template hash, truncation, and packing configuration.

Run `trajpack validate <export-directory>` before loading a multi-trace dataset.
The result `self_consistent: true` means its checksums, frozen compilers,
canonical selected views, statistics, audit, splits, JSONL, and Parquet agree.
It deliberately does not mean `training_ready: true`: current authorization is
rechecked only while exporting from the managed encrypted traces.

ATIF `reasoning_content` contains only observable, non-opaque reasoning parts;
the original trajpack reasoning classification is retained in `step.extra` so
a provider summary is never silently relabeled as recovered hidden reasoning.
Token/cost usage maps to ATIF step and final metrics, with reasoning tokens and
latency kept in metrics `extra`. Compaction events become system steps with
`extra.context_management`; `boundary: replace` is emitted only when a summary
is present or the source explicitly declares it, otherwise the boundary is
`unknown`. A confirmed verifier label is metadata in root `extra.trajpack` and
the canonical sidecar—not a root-level ATIF reward.

ATIF and OpenTelemetry GenAI are mapping targets, not internal truth, because
their specifications are still evolving. Mapping version strings are fixed in
the output so changes are never silent.

The ATIF mapping targets the active [Harbor ATIF v1.7
RFC](https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md).
HF output follows the current [TRL conversational dataset
format](https://huggingface.co/docs/trl/en/dataset_formats) and documents the
[chat-template generation-marker requirement](https://huggingface.co/docs/trl/main/chat_templates).
OpenTelemetry GenAI remains a development mapping maintained in the separate
[semantic-conventions-genai repository](https://github.com/open-telemetry/semantic-conventions-genai).
