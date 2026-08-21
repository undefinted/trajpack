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
       frozen dataset selection + split/dedup audit
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
  deterministic dataset splitting/auditing, and transactional exporters.
- `packages/adapters`: source event classifiers and normalizers.
- `packages/importers`: conservative official/manual JSON, JSONL, and inert HTML
  import.
- `apps/cli`: capture wrappers, one-shot arm descriptors, collectors, commands,
  and the reviewer server.
- `apps/reviewer`: local React workbench.
- `plugins/*`: Codex, Claude Code, Gemini CLI, and DeepSeek Harness integration bundles.
- `extensions/chromium`: authorized-site MV3 capture.

## Determinism and versioning

Canonical JSON recursively sorts object keys. IDs and hashes are derived from
canonical content rather than wall-clock iteration order. Raw envelopes retain
adapter and interface versions; DeepSeek Harness compatibility is pinned to
the `0.1.0-rc.6` interface profile and persistence format 0. Unknown
persistence versions fail closed.

`dataset-build/0.2` is an immutable recipe rather than a list of mutable paths.
It binds exact managed trace IDs, source/approval/decision hashes, target model,
quality profile, group hashes, split ratios, and seed. Split assignment is
`uint64_be(SHA256(domain || seed || group_id)) mod 10000`; adding an unrelated
group does not move existing groups. It freezes a versioned view recipe and its
compiler. `dataset/0.2` binds the derived view hashes and artifact checksums
without putting wall-clock time or output paths into the dataset identity;
`dataset-audit/0.3` fingerprints every compiled `(trace_id, view_id)` example,
including each `trace_full` session/branch.

Schema upgrades require an explicit migration. A normalizer must never silently
rewrite an existing `trajectory/0.1` vault.
