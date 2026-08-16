# Canonical and export formats

`trajectory/0.1` is the internal truth source. It uses 32-hex W3C trace IDs,
16-hex span IDs, parent/link topology, strict sequence numbers, source IDs,
typed content parts, usage/cost, reasoning representation, per-part rights and
redaction, and review dispositions.

- **Canonical** writes `manifest.json` and selected `events.jsonl`.
- **ATIF** writes a pinned RFC-0001-shaped training trajectory with reasoning,
  observations, calls, and topology. Fields the target cannot express remain in
  `provenance.json`. ATIF and HF/TRL require an explicit training gate; archive
  eligibility alone is never sufficient.
- **HF/TRL** writes JSONL and Parquet with `messages[]`, native tool calls and
  `tool` roles, tool metadata, and an aligned assistant loss mask.
- **OTLP** writes resource spans using a pinned development mapping and content
  hashes rather than prompt bodies.

Every format also writes `DATASET_CARD.md`, `lineage.json`,
`quality-report.json`, `redaction-report.json`, `license-summary.json`, and
`checksums.txt`. Excluded
events and content parts are removed before any plaintext serializer runs.
Opaque reasoning states are excluded from training views. Exporters do not
invent preference pairs, rewards, verifier success, or task labels.

ATIF and OpenTelemetry GenAI are mapping targets, not internal truth, because
their specifications are still evolving. Mapping version strings are fixed in
the output so changes are never silent.
