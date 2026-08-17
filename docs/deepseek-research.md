# DeepSeek Harness-first research path

DeepSeek Harness is trajpack's lead agent-data integration because its typed,
append-only durable event surface exposes a stronger research boundary than UI
scraping. The rest of trajpack remains adapter-open: Harness events are retained
as encrypted evidence and normalized into the same provider-neutral
`trajectory/0.1` topology used by Codex, Claude Code, Gemini CLI, official
exports, and authorized DOM archives.

This document describes engineering support, not blanket training permission.
The actual model provider, model license, account/contract, terms snapshot,
input/repository rights, tool-output rights, participant consent, target model,
and intended use are still intersected by the policy gates.

## Supported routes

| Route | Fidelity/authenticity | What is checked | What it does not prove |
| --- | --- | --- | --- |
| Native Harness plugin | Engineering grade A−; capture-process evidence | Pinned `0.1.0-rc.6` interface, source session, `firstLiveSeq`, contiguous sequences, exact duplicate identity, delivery, and observed request route | Provider signature, hidden model state, or legal eligibility |
| Harness persistence import | Fidelity B; `user_supplied` | Unpacked/uncompressed v0 session header, contiguous unpacked event rows, bounded input, and pinned shape | Who created or modified the file, runtime binding, or current authorization |
| Saved DeepSeek API response | Imported, `user_supplied` until separately evidenced | Supported JSON/streaming-JSONL response shape | Provider authentication or a Harness action/observation topology |

The native plugin and persistence importer intentionally use separate trust
labels. A valid file shape must never be upgraded into provider authenticity.

## Native capture integrity

The plugin in [`plugins/deepseek-harness`](../plugins/deepseek-harness) is pinned
to the official Developer Preview contract `0.1.0-rc.6`. Run it through the
capture wrapper after registering it with the Harness:

```bash
trajpack capture dsh -- dsh <arguments>
```

The wrapper creates a short-lived local collector capability for that process
tree. Without an active capability, the integration is silent. It does not
create a plaintext spool when the collector is unavailable.

For each observed session, the integration:

1. subscribes to typed durable `session/event` records;
2. preserves the raw event payload and source identifiers in an encrypted
   capsule;
3. records `firstLiveSeq` so a resumed session is not mistaken for a complete
   history beginning at sequence zero;
4. requires contiguous source sequences from the live boundary;
5. accepts an exact repeated event as idempotent, but rejects a conflicting
   same-sequence payload;
6. orders delivery per session and drains pending events on session flush and
   disposal;
7. surfaces non-2xx collector responses instead of silently declaring capture
   success; and
8. reconciles the durable `request/header` provider/model route with the trace
   manifest.

The durable event payload can include request configuration/system/tools,
surface messages, reasoning/text chunks, native tool calls/results, approvals,
retries, compaction, and subagent activity. “Lossless” means the subscribed raw
payload is preserved before normalization. It does not mean the Harness or
provider disclosed hidden Chain of Thought.

## Import an existing session

The v0.1 importer supports only the official, unpacked, uncompressed v0 JSONL
layout: one session header followed by individual contiguous event rows.

```bash
trajpack import ./sessions/session.jsonl \
  --source-hint dsh-session \
  --provider <actual-model-provider> \
  --account-type <account-class> \
  --terms ./evidence/provider-terms.snapshot.json
```

The explicit source hint prevents an arbitrary JSONL file from being guessed as
a Harness session. The importer retains the upstream session header and event
provenance, but records fidelity B and `user_supplied` authenticity. Attach
independently reviewed evidence before relying on a teacher identity.

The following inputs fail closed:

- packed/chunk persistence rows;
- zstd-compressed persistence;
- an unknown session/persistence version;
- a missing or malformed header;
- sequence gaps, reordering, or conflicting rows; and
- unrelated JSON, JSONL, or HTML passed with `--source-hint dsh-session`.

Use native capture or generate an explicitly unpacked, uncompressed artifact
with the pinned Harness version. Trajpack does not heuristically unpack or
decompress an evolving upstream storage layout.

## From durable events to canonical training evidence

Harness `request/header` carries the request configuration, system prompt, and
native tool schemas. Surface events preserve append/replace operations and
their `sourceEventSeqs`. The deterministic Harness epoch compiler replays those
operations, so each completed assistant response can be bound to the exact
model-visible surface and latest request header that preceded it. Sequence gaps,
unsupported required events, or invalid replacement ranges make the epoch
non-reconstructable instead of producing guessed context.

The `deepseek_epoch_sft` recipe makes this replay a training hard gate. It only
accepts a complete sequence-zero log on the pinned rc.6 interface, passes raw
integrity checks, and re-normalizes each required raw sequence to verify exact
alignment with the reviewed canonical event type, actor, status, tool fields,
content values/hashes, reasoning classification, inclusion decision, and
privacy-passed state. It then binds the request provider/model, system prompt,
native tool schemas, compaction-aware input surface, and completed assistant
output into one request-epoch example. Raw/canonical drift is an exclusion, not
a request to trust one layer over the other.

Normalization keeps raw and derived layers separate:

```text
encrypted durable capsules
  -> deterministic trajectory/0.1 events
  -> privacy, rights, policy, topology, and quality checks
  -> target-scoped human review
  -> versioned training view or content-free analytics projection
```

`request/header` system text and native JSON tool schemas become independently
reviewable content parts. Tool-call/result IDs, surface lineage, compaction,
retry, verifier, and subagent edges remain canonical evidence rather than being
flattened into XML or discarded.

## Choose a training view

After automated checks and target-scoped human approval, export one managed
trace to HF/TRL with an explicit recipe:

```bash
trajpack export <trace-id> \
  --format hf-trl \
  --recipe deepseek_epoch_sft \
  --mode training_competitive_distillation \
  --output ./exports/dsh-exact-epoch \
  --plaintext

trajpack validate ./exports/dsh-exact-epoch
```

The recipe is mandatory for DeepSeek Harness HF/TRL output. The exporter rejects
the generic `trace_full` view instead of flattening request epochs, surface
replacement, route changes, or duplicated stream/assembled/execution tool
records into ambiguous supervision. Versioned recipe export is single-trace in
v0.1; recipe-aware multi-trace builds are planned for a later schema version.

The seven v0.1 recipes are:

- `answer_sft`: completed assistant answer text;
- `reasoning_sft`: only complete `provider_exposed_reasoning` with explicit
  provenance and a provider `chain_of_thought` claim;
- `tool_use_sft`: native tool names/arguments with observed matching results;
- `deepseek_epoch_sft`: exact rc.6 request-epoch SFT reconstructed from the
  integrity-bound raw log and aligned to reviewed canonical provider/model,
  system, tools, compaction-aware surface, and output;
- `failure_recovery`: an observed retry/recovery action with failure and outcome
  evidence;
- `subagent_handoff`: a correlated delegated task and completed handoff; and
- `pointwise_reward_rl_ready`: a completed response with verified scalar-reward
  evidence, versioned verifier provenance, and matching reviewer confirmation,
  ready for downstream reward-model/RL research.

The last recipe is deliberately named “ready,” not “RL.” It does not create a
chosen/rejected DPO pair, infer a reward from exit status, manufacture step
rewards, run policy optimization, or ship a trainer. Likewise,
`reasoning_sft` never treats a provider summary, opaque state, unavailable
reasoning, or partial-only stream as raw CoT.

The generic recipes are useful cross-adapter views but do not replay Harness
surface history. For a Harness target they require a privacy-cleared request
header and an exact manifest/header/target provider-model route. If a prior
`surfaceOp: replace` changed the model-visible context, the generic candidate is
blocked and directs the researcher to `deepseek_epoch_sft`. If capture resumed
with `firstLiveSeq > 0`, every recipe—including the exact one—is blocked because
the earlier context is unavailable; recapture or import a complete sequence-zero
log. The exact recipe also fails closed on a missing header, route mismatch,
invalid replacement, incomplete epoch, raw/canonical drift, review exclusion,
or exact content whose redaction status is not `passed`.

Each export records recipe/compiler versions, source/target/evidence event IDs,
component loss targets, exclusions, verifier provenance when applicable, and a
compilation digest. No qualifying candidate means no export.

## Workload analytics without content export

```bash
trajpack analyze <trace-id> [<trace-id> ...] --format summary
trajpack analyze <trace-id> [<trace-id> ...] --format tracelab-jsonl
```

The first form reports deterministic workload and training-yield aggregates.
The second emits a content-free, lossy TraceLab-shaped JSONL projection. It
contains no prompt/reasoning bodies, tool arguments/results, code, patches, or
file contents and cannot reconstruct the canonical trajectory.

[TraceLab](https://github.com/uw-syfi/TraceLab) inspires this systems-analysis
view but is not a runtime dependency. The projects address different primary
questions: TraceLab characterizes agent-serving workloads; trajpack governs
observable evidence and compiles it into auditable SFT or verifier-backed
pointwise-reward data. The encrypted canonical layer—not the analytics
projection—remains the source of truth.

## Research checklist

- Pin the Harness interface and actual model/provider route.
- Retain terms/permission evidence for the exact account, capture method,
  purpose, target, and validity window.
- Hash self-hosted model artifacts and retain separate runtime-binding evidence.
- Review system/tool content as well as messages and tool outputs for secrets,
  PII, third-party code, and rights.
- Keep repository/task families in one split and run strict deduplication.
- Select a recipe because its evidence contract matches the experiment, not
  because it yields the most rows.
- For compaction or surface replacement, prefer `deepseek_epoch_sft`; never use
  a generic view to approximate the model-visible prefix. A resumed partial log
  must be recollected from sequence zero before any training recipe is eligible.
- Validate the completed plaintext export and pin tokenizer, chat template,
  trainer/library, student model, and experiment configuration separately.

See [Research dataset workflow](research-workflow.md),
[Canonical and export formats](formats.md), [Adapter details](adapters.md), and
[Policy semantics](policy.md).
