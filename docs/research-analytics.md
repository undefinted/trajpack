# Research analytics derived view

`research-analytics/0.1` is a deterministic, content-free view over selected
canonical events. It borrows the useful workload-analysis shape from
[TraceLab](https://github.com/uw-syfi/TraceLab), while keeping
`trajectory/0.1` as the only internal source of truth.

This module is an analytics pass, not another capture format and not a policy
bypass. Raw and canonical records stay in the encrypted vault. The derived
output never contains content values, reasoning text, tool arguments, tool
results, source session/turn IDs, filesystem paths, or provider payloads.

## Accepted inputs

`deriveResearchAnalytics()` and `toTraceLabWorkloadRows()` accept one of two
explicit input modes:

- `approved_bundles`: parsed canonical bundles whose automated checks passed,
  human review is approved, approval fingerprint is current, and lineage is not
  tombstoned. A stale or merely pending bundle is rejected.
- `selected_events`: canonical events that a policy-enforcing caller has
  already selected. Because manifests are absent, training-gate status is
  reported as `unavailable`; the function never infers authorization.

Both modes honor event and content `review_disposition`. Bundle mode reports
the recorded noncompetitive and competitive-distillation gate statuses, but
those counts are descriptive. A concrete dataset export still needs the exact
target-scoped policy gate and approval.

## Stable workload definitions

- A turn is keyed by trace, source session, and source turn. Missing source IDs
  use a trace-local fallback and are never emitted.
- An LLM round is grouped by `source_step_id` when available. Without a step ID,
  an inference/usage event is a conservative round anchor. The summary reports
  both grouping-evidence counts so downstream experiments can filter weaker
  rows.
- A round's token, cache, latency, and cost fields use the last non-null
  canonical usage observation per field. Values are then summed across rounds.
  This avoids summing repeated cumulative usage reports inside one step.
- Cache and reasoning ratios are integer basis points. A missing/zero
  denominator produces `null`, not a fabricated zero.
- Tool calls pair only with a later result in the same trace and call ID.
  Wall latency exists only when both canonical timestamps parse and the result
  is not earlier than the call. Percentiles use deterministic nearest-rank.
- Parallelism is observed from calls that remain open before a later call is
  emitted. The pass reports group count, additional concurrent calls, and peak
  observed concurrency.
- Recovery requires a later successful evaluation, a successfully paired tool
  result, or explicit `recovered`/`recovery`/`retry_success` metadata. A merely
  later message is not treated as recovery.
- Reasoning/action ratio counts observable reasoning events versus tool calls,
  artifact writes, and patches. It does not score the quality of reasoning and
  does not claim access to hidden chain of thought.

## Structural training yield

The summary separates:

- candidate, selected, and privacy-ready content parts;
- assistant/agent parts that could structurally carry loss;
- reasoning parts explicitly marked `include_in_loss` and not opaque;
- exclusions caused by event/content review, unscanned or quarantined content,
  opaque reasoning, and disabled reasoning loss;
- the recorded training-gate status when manifests are available.

This is a yield diagnostic, not an SFT or RL label generator. It does not create
success labels, rewards, DPO pairs, or authorization that is absent from the
canonical evidence.

## TraceLab-shaped workload rows

`toTraceLabWorkloadRows()` emits the common normalized-round fields used by
TraceLab, including token/cache counts, timing-event metadata, tool timing,
error state, and character counts. Every row carries:

```json
{
  "_trajpack": {
    "mapping_version": "tracelab-workload-derived/0.1",
    "mapping_kind": "lossy_derived",
    "canonical_source_of_truth": false,
    "content_values_emitted": false,
    "tool_payloads_emitted": false
  }
}
```

Important differences are fail-visible:

- trace, session, round, event, and call identities are deterministic hashes;
- custom tool names are deterministic pseudonyms and payloads are omitted;
- prompt-snapshot counters, home/user/store provenance, provider-specific cache
  creation counts, and internal tool latency are `null` or listed as
  unavailable;
- tool input/result character counts may be present, but their values are not;
- rows are suitable for workload experiments and DuckDB materialization, not
  canonical round trips or training reconstruction.

The mapping is versioned independently because TraceLab's schema and trajpack's
canonical schema have different goals. Any future mapping change must increment
`TRACELAB_WORKLOAD_MAPPING_VERSION` and update golden fixtures.
