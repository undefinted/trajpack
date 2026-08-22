# Feasibility validation / 可行性验证

This document records what the repository demonstrates today, what remains a
fixture-level result, and what trajpack deliberately does not claim.

本文记录仓库目前真正证明了什么、哪些结果仍停留在 fixture 层，以及 trajpack
明确不声称具备的能力。

## Evidence matrix / 证据矩阵

| Question | Current evidence | Status |
| --- | --- | --- |
| Can observable agent events be captured without a plaintext spool? | Encrypted-vault, unarmed/offline no-op, hook-forwarder, collector, sequence-gap, bounded-ingest, and recovery tests. | Validated in automated tests |
| Is DeepSeek Harness a real first-class path? | Installable rc.6 plugin, typed `session/event`, route/header reconciliation, exact two-epoch fixture, bounded plugin queue, flush/dispose failure propagation, and a child-process credential non-inheritance test. | Validated against pinned rc.6 types and fixtures; evidence is `locally_observed`, and live upstream remains Developer Preview |
| Do Codex, Claude Code, and Gemini CLI have native routes? | Wrapper/hook fixtures and pinned interface adapters. Gemini ambiguous `AfterModel` text/thought chunks are excluded; `AfterAgent` is authoritative. | Implemented and fixture-tested; host installation must still be verified locally |
| Can GPT/Claude/Gemini/DeepSeek web pages be scraped automatically? | No commercial selector presets exist; origins are blocked in the generic extension. Official exports/manual archives are accepted conservatively. | Deliberately unsupported |
| Can authorized websites be captured? | Click-driven MV3 extension, recipe hash/origin authorization, preview, localhost pairing, CSRF/origin and malicious-DOM tests. | Implemented for owned/authorized origins |
| Can evidence become SFT data without flattening tools? | Seven versioned recipes, native tool calls/results/schema, component targets, message masks, JSONL/Parquet, report-to-example binding, strict ChatML bridge. | Structurally validated |
| Can data become RL-ready? | `pointwise_reward_rl_ready` requires an observed scalar reward, versioned verifier evidence, and reviewer confirmation. | Pointwise evidence export only; no RL trainer or fabricated preference pairs |
| Are multi-trace splits protected from leakage? | HMAC group split, lineage/repo gates, exact and bounded near-dedupe per compiled `(trace_id, view_id)`, including every `trace_full` branch/session. | Validated with cross-split regressions |
| Can offline validation prove a DeepSeek epoch came from raw capsules? | It binds report rows, checksums, canonical references, JSONL/Parquet, and rederived audit. Raw capsules stay encrypted and are absent from plaintext exports. | Internal consistency validated; raw epoch replay requires reopening the managed source |
| Do trajectories improve a model? | RTX 4060 and H100 single-seed calculator ablations favor complete action→observation supervision over answer-only under equal optimizer steps. | Narrow utility evidence, not a general causal result |

## TraceLab: borrowed ideas and product boundary

The comparison was audited against TraceLab commit
[`4ccd9169b559eaa998396b30580ef81966c07afc`](https://github.com/uw-syfi/TraceLab/tree/4ccd9169b559eaa998396b30580ef81966c07afc).
TraceLab is strong evidence that detailed local agent telemetry can support
systems research: its public project reports 357,161 LLM rounds, 432,510 tool
records, and 43 users. trajpack adopts deterministic extraction, reproducible
metrics, validation, and content-free workload projections.

The projects answer different questions:

| TraceLab | trajpack |
| --- | --- |
| Agent-serving workload analytics | Governed post-training data ETL |
| Public rows intentionally omit prompt/response/tool bodies | Encrypted raw evidence plus approved plaintext training views |
| Claude/Codex collection; DeepSeek is currently marked coming soon in its comparison UI | DeepSeek Harness is the lead pinned typed integration |
| Viewer/query metrics | Rights, consent, privacy, review, loss targets, verifier provenance, dataset splits and lineage |
| No HF/TRL, ATIF, OTLP, assistant-only target, or training-policy contract | Canonical + ATIF + HF/TRL + OTLP with hard gates |

trajpack therefore does not copy TraceLab into another viewer. It exposes a
content-free TraceLab-shaped analytics projection while keeping the governed
canonical/training pipeline as the differentiator.

## Hidden reasoning boundary / 隐藏推理边界

Opaque signatures and encrypted reasoning state are protocol data, not a
documented plaintext Chain-of-Thought API. trajpack inventories recognized
opaque fields inside encrypted raw storage and excludes them from training.
It does not replay signatures across models, probe for plaintext, or implement
provider-protection bypasses.

Research that generates an explanation from a question, answer, summary, or
behavior is represented as `generated_rationale`. A plausible reconstruction,
matching length, or matching behavior does not authenticate it as the original
teacher trace. See [the Claude signature boundary](claude-thinking-signatures.md)
and [design references](references.md).

## Reproduce the current claims / 复现当前结论

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm test:demo
pnpm test:pack
pnpm audit:static
pnpm bench:scale
python -m unittest discover -s experiments/trajectory-utility/tests -p "test_*.py" -v
```

The Windows validation run on 2026-08-22 completed with 377 TypeScript tests
passing and 5 platform/optional-capability skips, 17 Python bridge tests
passing, no known production dependency vulnerabilities, and a successful
release-pack smoke test. The same run processed 100,000 events at about 692k
events/s for bounded JSONL and 85.9k events/s for the encrypted vault; these are
single-machine measurements, not distributed-load claims.

2026-08-22 的 Windows 验证结果为：377 项 TypeScript 测试通过、5 项因平台或
可选能力跳过，17 项 Python bridge 测试通过，生产依赖未发现已知漏洞，release
pack smoke test 通过。同次 10 万事件实测中，有界 JSONL 约为 69.2 万 events/s，
加密 vault 约为 8.59 万 events/s；这些仅是单机测量，不代表分布式负载能力。

`pnpm test:demo` exercises a synthetic complete DeepSeek Harness trace and two
exact request epochs. The Python bridge test consumes the committed HF/TRL
artifact and verifies native tools, action/observation context, exposed
reasoning, answer targets, and fail-closed corruption cases.

The GPU ablations are intentionally separate: their DatasetExamples are
created directly by `generate_data.py`, not by a live-provider vault export.
This proves narrow downstream usefulness and the committed demo proves the
exporter/trainer structural boundary; it does not yet prove one continuous
real-provider raw-vault-to-GPU experiment.

## Next decisive experiment / 下一项决定性实验

For publication-grade evidence, collect owned or explicitly licensed
sequence-zero DeepSeek Harness sessions from a pinned self-hosted model, then:

1. capture → encrypt → normalize → review → approve;
2. freeze repo/task-family splits with `deepseek_epoch_sft`;
3. export and validate JSONL/Parquet plus reports;
4. compare answer-only, action/observation, exposed-reasoning, and full-epoch
   arms with matched target tokens and optimizer compute;
5. run multiple seeds and held-out repositories/tasks; and
6. publish hashes, exclusions, failures, confidence intervals, and an
   independently reproducible dataset card.

Until that experiment is complete, trajpack should be described as a robust
research-preview ETL with narrow positive utility evidence—not as proof that
all agent trajectories or reasoning traces improve all student models.
