# 可复现科研 Demo / Reproducible research demo

[中文](#中文) · [English](#english)

## 中文

这个 demo 用一条**项目作者编写的合成 DeepSeek Harness rc.6 轨迹**走完整条本地流水线：

```text
versioned raw capsules
  -> deterministic canonical normalization
  -> privacy and quality checks
  -> purpose-scoped synthetic-data review approval
  -> exact deepseek_epoch_sft compilation
  -> HF JSONL + native Parquet
  -> validation + content-free analytics + checksums
```

它不访问网络，不调用 DeepSeek、Claude、GPT 或其他模型，不读取账号信息，也不包含密钥、商业模型输出或隐藏思维链。fixture 中的 provider/model 名称只是为了覆盖 DeepSeek Harness 路由和 schema；短 reasoning 文本是作者写的合成测试内容。

### 一键运行

要求 Node.js 24、pnpm，以及已经安装的 workspace dependencies：

```powershell
./examples/deepseek-research-demo/run.ps1
```

macOS/Linux 可运行：

```sh
sh examples/deepseek-research-demo/run.sh
```

验证同一输入重复运行会得到完全相同的主要 checksums，并确认缺失 durable sequence 时不会产生训练导出：

```powershell
pnpm build
node --test examples/deepseek-research-demo/demo.test.mjs
```

脚本的默认输出位于 `examples/deepseek-research-demo/artifacts/`：

- `normalized/review-ready.trace.json`：经过隐私和自动质量检查、等待人工批准的 canonical trace；
- `approved/approved.trace.json`：仅针对合成自有内容的、目标和用途限定的 review attestation；
- `hf-trl/dataset.jsonl`：两个精确 request epoch，一个监督 tool call，另一个监督合成 reasoning + answer；
- `hf-trl/dataset.parquet`：原生嵌套 Parquet，脚本逐行与 JSONL 比较；
- `hf-trl/training-view-report.json`：输入/输出事件、loss target、recipe/compiler version 与 epoch hashes；
- `analytics/research-metrics.json`：不含正文、工具参数、路径或原始轨迹 ID 的研究统计；
- `failure/failure-report.json`：缺少 sequence 5 的 fixture 被 `RAW_SEQUENCE_GAP` 和自动检查共同阻断；
- `utility-evidence.json`：机器可读的“已经证明/尚未证明”边界；
- `reproducibility.json` 与 `checksums.sha256`：fixture、canonical lineage 和输出文件的确定性摘要。

### 这能证明什么

这次真实运行能够证明：

1. 固定的 raw capsules 可以确定性重建成两个 exact model-visible request epochs；
2. tool schema、tool call/result、provider-exposed 字段、assistant-only loss mask 和来源事件绑定没有在 JSONL/Parquet 映射中丢失；
3. JSONL 通过公开 schema，Parquet 逐行回读结果与 JSONL 一致；
4. SFT 输出没有伪造 reward、verifier、DPO pair 或 step reward；
5. durable sequence 缺口会 fail closed，且失败路径不会留下训练导出目录。

它**不能**单独证明下游模型性能提升。真正的有效性研究需要固定 base checkpoint、训练 token budget、optimizer、随机种子和 evaluator，在 repo/time-disjoint held-out tasks 上比较 base、answer-only SFT 和 exact-epoch SFT。可直接填写的预注册模板在 `examples/deepseek-research-demo/utility-study.template.json`，建议至少报告 verified pass@1、task success、valid tool-call rate、environment-grounded completion、tokens/tools-to-success 和 paired bootstrap 95% CI。

### Demo 视频与回放

每次脚本实际运行后，还会在 git 忽略的 `work/demo-replay/` 写入两份无本地路径、无密钥、无正文 payload 的安全回放素材：`trajpack-deepseek-demo.json` 是 machine-readable frames/summary，`trajpack-deepseek-demo.txt` 可直接交给 `scripts/render-demo-video.mjs --transcript`。`examples/deepseek-research-demo/demo.tape` 是可选的 [VHS](https://github.com/charmbracelet/vhs) 录制脚本。

已安装 Chrome、Playwright workspace 依赖和 `ffmpeg` 时，可以把**实际运行产生的安全 transcript**渲染为 MP4：

```powershell
node scripts/render-demo-video.mjs `
  --transcript work/demo-replay/trajpack-deepseek-demo.json `
  --output work/demo-replay/trajpack-deepseek-demo.mp4 `
  --title "trajpack · DeepSeek Harness → exact SFT"
```

视频应明确标注：**这是实际 ETL/验证 run 的可复现回放，不是模型训练结果，也不是训练效果证据。** 仓库不提交预录制二进制视频，避免把剪辑过的画面误认为实验复现；任何发布的视频都应同时给出 commit 和 `checksums.sha256`。

### 关于 thinking signature

本 demo 不尝试逆向、诱导解码或“破解”任何厂商的 thinking signature。opaque/signature 字段只能作为不可训练的 `opaque_reasoning_state` 和 provenance 保存。只有来源明确返回、授权允许且通过审阅的可见 reasoning，才可能成为显式 loss target。合成 fixture 只验证这种字段的 ETL 语义，不构成真实 provider provenance。

## English

This demo runs an **author-authored synthetic DeepSeek Harness rc.6
trajectory** through the complete local pipeline:

```text
versioned raw capsules
  -> deterministic canonical normalization
  -> privacy and quality checks
  -> purpose-scoped synthetic-data review approval
  -> exact deepseek_epoch_sft compilation
  -> HF JSONL + native Parquet
  -> validation + content-free analytics + checksums
```

It makes no network or model call, reads no account data, and contains no
credential, commercial-model output, or hidden chain-of-thought. Provider and
model names are routing fixtures. The short reasoning field is authored test
text, not recovered model reasoning.

### Run and test

```powershell
./examples/deepseek-research-demo/run.ps1
```

On macOS/Linux:

```sh
sh examples/deepseek-research-demo/run.sh
```

Inspectable outputs are committed under
`examples/deepseek-research-demo/artifacts/`: review-ready and approved
canonical traces, exact-epoch JSONL, native Parquet, the training-view report,
content-free analytics, a fail-closed gap report, and deterministic checksums.

### What the run establishes

The run gives machine-checkable evidence that exact request epochs, native tool
semantics, loss masks, lineage, and explicit synthetic reasoning survive the
training-view mapping; JSONL and Parquet agree; no reward/preference label is
invented; and a missing durable sequence blocks export without leaving a
plaintext training directory.

It does **not** establish a downstream quality gain. Use
`examples/deepseek-research-demo/utility-study.template.json` to preregister a
controlled base vs answer-only vs exact-epoch SFT evaluation on repo/time
disjoint held-out tasks. Keep the base checkpoint, optimizer/update-token
budget, decoding, seeds, sandbox, and evaluator fixed, and report effect sizes
with paired confidence intervals as well as failures and exclusions.

### Replay video

Every actual run writes a path-free, secret-free JSON summary and safe text
transcript under the git-ignored `work/demo-replay/`. The text file can be
passed directly to `scripts/render-demo-video.mjs --transcript`. The optional
`examples/deepseek-research-demo/demo.tape` can render the same commands with
[VHS](https://github.com/charmbracelet/vhs).

With Chrome, the workspace Playwright dependency, and `ffmpeg` available, the
actual safe replay can be rendered as MP4:

```sh
node scripts/render-demo-video.mjs \
  --transcript work/demo-replay/trajpack-deepseek-demo.json \
  --output work/demo-replay/trajpack-deepseek-demo.mp4 \
  --title "trajpack · DeepSeek Harness → exact SFT"
```

Any resulting video must be described as a **reproducible replay of the actual
ETL/validation run, not model training and not evidence of training effect**.
Publish the commit and `checksums.sha256` alongside it.

The demo never attempts to reverse, decode, or bypass a provider thinking
signature. Opaque/signature data remains non-trainable provenance. Only
explicitly returned, authorized, reviewed reasoning may become a loss target.
