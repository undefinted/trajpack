# Performance and scale / 性能与规模

`trajpack` is a single-machine, local-first security pipeline. Its throughput
comes from bounded streaming and ciphertext batching, not unbounded parallelism.
`trajpack` 是单机、local-first 的安全流水线；性能来自有界流式处理和密文批写，
而不是无限并发。

## Reproducible 100k benchmark / 可复现 10 万事件基准

Run from the repository root with Node.js 24. Each scenario runs in a fresh
process, one worker, using 100,000 synthetic records with a 256-byte text
payload. The values below were measured on the Windows development workstation;
disk, CPU, Argon2 implementation, and OS cache will change absolute numbers.

在仓库根目录、Node.js 24 下运行。每个场景使用独立进程、单 worker，处理
100,000 条带 256 字节文本的合成记录。下列数字来自 Windows 开发机；磁盘、
CPU、Argon2 实现和系统缓存会影响绝对数值。

```sh
pnpm bench:scale
```

To change the bounded sample size / 调整样本量：

```powershell
$env:TRAJPACK_BENCH_EVENTS='50000'
pnpm bench:scale
```

```sh
TRAJPACK_BENCH_EVENTS=50000 pnpm bench:scale
```

| Path / 路径 | events/s | MiB/s | peak RSS delta |
|---|---:|---:|---:|
| Legacy JSONL `map().join()` | 741,510 | 213.4 | 108.5 MiB |
| Current 1 MiB streaming JSONL | 691,817 | 199.1 | 7.6 MiB |
| Legacy whole-array lineage hash | 845,260 | 243.3 | 85.6 MiB |
| Current incremental lineage hash | 949,705 | 273.3 | 0.6 MiB |
| Legacy vault, one write per frame | 30,543 | 18.8 | 265.4 MiB |
| Current vault, 1 MiB ciphertext batches | 85,887 | 53.0 | 325.2 MiB |

The old and incremental lineage hashes were identical:
`94fcc0dfcd4f68e3b3e6ff335b8ad0ffab75ae33df8ba5fc5589e6c9ae71896b`.
Streaming JSONL produced the same byte count. Vault RSS includes Argon2id memory;
the ciphertext batch itself is bounded to 1 MiB. This run measured comparable
JSONL throughput and roughly 93% lower RSS overhead; the implementation treats
bounded memory, rather than a throughput increase, as the portable guarantee.

新旧 lineage hash 完全一致；流式 JSONL 的字节数也一致。Vault RSS 包含
Argon2id 内存，密文批缓冲本身限制为 1 MiB。本次 JSONL 吞吐接近且实测 RSS
开销降低约 93%；跨机器可承诺的是有界内存，而不是一定提高吞吐。

## Hard bounds and degradation / 硬上限与退化策略

- Collector: 4 concurrent parsed requests by default (configurable to 64),
  100,000 accepted events, 128 MiB raw payload, and 64 invalid attempts.
  Configurable ceilings are 1,000,000 events, 192 MiB raw, and 1,024 invalid
  attempts. Hook/browser bodies are capped at 8/20 MiB.
- CaptureSession: at most 1,024 pending direct ingests by default, configurable
  to 65,536. DeepSeek sequence state is O(sessions), while dedupe remains
  content-bound and bounded by the event limit.
- DeepSeek Harness plugin pre-collector queue: 1,024 events/16 MiB per session,
  4,096 events/64 MiB process-wide, and at most 1,024 live session states. A
  quota, serialization, or delivery failure latches the capture and makes both
  session-scoped and global `session/flush` fail instead of growing an
  unbounded promise chain.
- Vault: 512 MiB file, 1,000,000 records, 96 MiB per authenticated frame.
  Ciphertext flush batches default to 1 MiB and cannot exceed 8 MiB.
- Reviewer: 2 active Argon2/decrypted requests and 16 FIFO waiters by default;
  CLI ceilings are 8 active and 128 queued. Disconnected waiters are cancelled
  and cannot retain a lease.
- Dataset JSONL: fixed 64 KiB read buffer and 64 MiB row limit. Whole split
  size is streamed up to Node's exact file-size range; callers may tighten the
  bound. Dataset planning and standalone validation use a 256 MiB estimated
  resident budget covering selected bundles, per-trace examples, recipe
  reports, authenticated compilations, and aggregate Parquet-comparison rows.
  Directory hashing additionally has a 4 GiB aggregate inspection budget.
  Split larger experiments or raise explicit future compiler/validator budgets
  rather than bypassing them.

- Collector 默认同时解析 4 个请求（最高 64），接受事件 100,000 条、raw
  128 MiB、无效尝试 64 次；可配置上限分别为 1,000,000、192 MiB、1,024。
  hook/browser 请求体上限为 8/20 MiB。
- CaptureSession 默认最多积压 1,024 个直接 ingest（最高 65,536）。
- DeepSeek Harness 插件在 collector 之前限制为单 session 1,024 条/16 MiB、
  全进程 4,096 条/64 MiB，且最多保留 1,024 个活跃 session 状态；超限或传输
  失败会 latch，并使 session 级与全局 flush 都失败。
- Vault 上限为 512 MiB、1,000,000 条记录、单认证 frame 96 MiB；密文批写
  默认 1 MiB，最高 8 MiB。
- Reviewer 默认 2 个活跃解密任务和 16 个 FIFO 等待者（最高 8/128）；断连
  等待者会取消，不会泄漏并发槽。
- Dataset JSONL 使用固定 64 KiB 缓冲和 64 MiB 单行上限，整个 split 流式读取。
  planning/validation 的 256 MiB 常驻估算同时覆盖 bundle、per-trace
  example、recipe report、compilation 和 Parquet 对照行；目录哈希另有 4 GiB
  总检查预算。

HTTP degradation is explicit:

- `collector_busy` (429): transient; retry with backoff. A browser one-time
  pairing nonce is restored when this is the failure.
- `reviewer_busy` (429 + `Retry-After: 1`): bounded reviewer queue is full;
  retry later.
- `capture_limit_exceeded` (429): terminal for that capture. The collector
  remains fail-closed and the incomplete vault is not published.
- Duplicate/idempotent retries and transient backpressure release their quota
  reservation; malformed authenticated requests use the separate invalid budget.

HTTP 退化语义明确：`collector_busy` 可退避重试（浏览器一次性 nonce 会恢复）；
`reviewer_busy` 表示本地审阅队列已满；`capture_limit_exceeded` 是本次采集的
终止性失败，不会发布不完整 vault。幂等重试与瞬时背压不会消耗正式配额。

Higher concurrency is not automatically faster: Argon2id, redaction, Parquet,
and verifier work are memory intensive. Increase reviewer/collector limits only
after measuring the target workstation. For multi-node ingestion or distributed
training-data compilation, v0.1 should be sharded into independent encrypted
traces and merged only through approved dataset views; it is not a distributed
collector.

更高并发并不必然更快：Argon2id、去敏、Parquet 和 verifier 都消耗内存。应先
测量目标工作站再提高上限。v0.1 不是分布式 collector；多机任务应按独立加密
trace 分片，并只通过已批准的数据集视图汇总。
