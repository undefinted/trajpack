# Performance and scale / 性能与规模

`trajpack` is a single-machine, local-first security pipeline. Its throughput
comes from bounded streaming and ciphertext batching, not unbounded parallelism.
`trajpack` 是单机、local-first 的安全流水线；性能来自有界流式处理和密文批写，
而不是无限并发。

## End-to-end collector benchmark / Collector 端到端压测

The collector benchmark sends concurrently generated, rights-owned synthetic
DeepSeek Harness capsules through the real loopback HTTP server, admission
control, `CaptureSession`, normalizer, sanitization passes, and encrypted vault
publication. It does not prebuild an event array. Source sessions are processed
sequentially within each session and concurrently across sessions, preserving
the Harness sequence contract while applying real HTTP pressure.

Collector 压测会把运行时生成、权利明确的合成 DeepSeek Harness capsule 送入真实
loopback HTTP server，并经过 admission control、`CaptureSession`、normalizer、
清洗 pass 和加密 vault 发布。它不会预先构造完整事件数组；单个 source session
内部顺序发送，不同 session 并发发送，既遵守 Harness sequence contract，也施加
真实 HTTP 压力。

```sh
pnpm bench:collector
pnpm bench:collector:smoke
```

The JSON report is content-free. It includes session/event/byte counts, total
and ingest duration, events/s, logical MiB/s, accepted-request p50/p95/p99,
HTTP 202/429/error counts, peak RSS, encrypted vault size, and only SHA-256
lineage evidence. Before succeeding, the benchmark verifies zero event loss,
contiguous per-session raw and normalized topology, and scans the vault as a
byte stream to prove that neither its random event sentinel nor its in-memory
passphrase appears statically in the published file.

JSON 报告不含事件内容，只包含 session/event/byte 数量、总耗时与写入耗时、
events/s、逻辑 MiB/s、已接受请求的 p50/p95/p99、HTTP 202/429/error 计数、
峰值 RSS、加密 vault 大小和 SHA-256 lineage 证据。成功退出前会验证零事件丢失、
每个 session 的 raw/normalized 拓扑连续，并流式扫描 vault，确认随机明文哨兵和
仅驻留内存的口令都没有静态出现在文件中。

Parameters are bounded and can be combined. Client concurrency cannot exceed
the number of source sessions; total configured logical data is capped at
96 MiB, independently of the collector and vault's own fail-closed limits.

参数都有硬上限且可组合。client concurrency 不能超过 source session 数量；配置
的逻辑数据总量额外限制在 96 MiB，collector 与 vault 自身仍保留独立的 fail-closed
上限。

```sh
node --expose-gc scripts/benchmark-collector.mjs \
  --events 20000 --sessions 32 --concurrency 16 \
  --collector-concurrency 4 --payload-bytes 1024
```

`429` is not silently treated as loss: only `collector_busy` is retried with a
bounded delay and counted. Any terminal limit, integrity failure, unexpected
status, count mismatch, topology mismatch, or plaintext hit makes the command
fail without printing the passphrase, sentinel, event content, or temporary
path.

`429` 不会被静默当作成功：只有 `collector_busy` 会进行有界重试并计数。任何
终止性限额、完整性失败、异常状态、数量/拓扑不一致或明文命中都会让命令失败，
且不会打印口令、哨兵、事件内容或临时路径。

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
