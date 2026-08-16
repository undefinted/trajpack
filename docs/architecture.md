# Architecture

`trajpack` separates acquisition, durable raw evidence, deterministic
normalization, review, and plaintext export.

```text
official typed events / manual import / authorized visible DOM
                         |
                  encrypted raw vault
                         |
              deterministic normalizers
                         |
           privacy + rights + quality gates
                         |
                 local human review
                         |
       canonical / ATIF / HF-TRL / OTLP plaintext
```

The encrypted raw layer is append-only during capture. Normalized events are a
rebuildable derived layer and keep source event/session/turn/step identifiers,
strict sequence numbers, trace/span links, adapter/interface versions, content
hashes, and provenance. Review edits replace only the encrypted derived bundle;
the original raw envelopes remain present in the rewritten vault.

## Packages

- `packages/schema`: public `trajectory/0.1` Zod schemas.
- `packages/core`: canonical hashing, vault, policy, scanning, quality, store,
  and exporters.
- `packages/adapters`: source event classifiers and normalizers.
- `packages/importers`: conservative official/manual JSON, JSONL, and inert HTML
  import.
- `apps/cli`: capture wrappers, one-shot arm descriptors, collectors, commands,
  and the reviewer server.
- `apps/reviewer`: local React workbench.
- `plugins/*`: Codex, Claude Code, and DeepSeek Harness integration bundles.
- `extensions/chromium`: authorized-site MV3 capture.

## Determinism and versioning

Canonical JSON recursively sorts object keys. IDs and hashes are derived from
canonical content rather than wall-clock iteration order. Raw envelopes retain
adapter and interface versions; DeepSeek Harness compatibility is pinned to
`0.1.0-rc.5` and persistence format 0. Unknown persistence versions fail closed.

Schema upgrades require an explicit migration. A normalizer must never silently
rewrite an existing `trajectory/0.1` vault.
