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

Every format also writes `DATASET_CARD.md`, `lineage.json`,
`quality-report.json`, `redaction-report.json`, `license-summary.json`, and
`checksums.txt`. Excluded
events and content parts are removed before any plaintext serializer runs.
Opaque reasoning states are excluded from training views. Exporters do not
invent preference pairs, rewards, verifier success, or task labels.

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
