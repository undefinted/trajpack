# Trajectory utility smoke experiment

This is a deliberately small, auditable experiment for one question:

> Under an equal optimizer-update budget, does teaching a small model the
> complete calculator action → observation → answer trajectory improve held-out
> tool use over the untouched base model and answer-only SFT?

It is **narrow-domain smoke evidence, not proof that trajectories are generally
useful**. A positive result supports this calculator protocol, model revision,
seed, split, and LoRA configuration only. A negative or tied result is retained
as-is; the runner never fabricates or silently substitutes metrics.

## Real reference run

The committed [v5 result card](results/reference-v5.md) reports a real offline
RTX 4060 run. Complete-trajectory SFT reached 32/32 executable outcomes, final
answers, and tool-using end-to-end successes; answer-only reached 2/32 final
answers and 0/32 tool successes; base reached 0/32 accuracy. Read the result
card's limits before citing it: this is a single-seed synthetic smoke test, and
the complete arm saw 64.4% more target tokens than answer-only.

An independent [H100 cluster replication](results/cluster-h100-20260820.md)
reached 31/32 tool-using end-to-end successes for complete-trajectory SFT,
versus 0/32 for answer-only and base. It used the same pinned model, inputs,
seed, and optimizer-step budget under a different PyTorch/CUDA stack. This is a
useful engineering replication, but it retains the same single-seed and
target-token-mismatch limitations.

## Three controlled arms

| Arm | Training view | Assistant loss targets |
| --- | --- | --- |
| `base` | No fine-tuning | None |
| `answer_only_sft` | User → final answer | Final answer only |
| `complete_trajectory_sft` | User → tool call → observation → final answer | Tool call and final answer |

Both SFT arms use 60 optimizer steps, the same batch size, gradient accumulation,
optimizer, LoRA shape, learning rate, held-out tasks, and randomization policy.
The report also records target-token exposure and wall time so the remaining
compute difference is visible rather than hidden.

The committed model identity is immutable:

```text
Qwen/Qwen2-0.5B-Instruct
c540970f9e29518b1d8f06ab8b24cba66ad77b6d
```

The loader disables remote code and rejects a resolved model commit that differs
from that revision.

## Data and licensing

`generate_data.py` creates deterministic, project-authored arithmetic tasks. It
does not call a teacher model and does not contain provider output or copied
benchmark text. Generated data is Apache-2.0 and carries its license, generator
version, seed, per-file SHA-256, and disjoint train/eval split hashes in
`data-manifest.json`.

Both SFT files and the held-out file use trajpack's `DatasetExample` shape:

- native `tool_calls` and `tool` role observations;
- one loss-mask entry per message;
- loss enabled only for assistant completions;
- explicit target components and source event IDs;
- no invented reward, preference pair, or verifier label.

## Quick structural test (no model or network)

From the repository root:

```powershell
python -m unittest discover experiments/trajectory-utility/tests -v
python experiments/trajectory-utility/generate_data.py `
  --out work/ignored/trajectory-utility/data --train 96 --eval 32 --seed 20260817
python experiments/trajectory-utility/validate_data.py `
  --answer-only work/ignored/trajectory-utility/data/answer-only.train.jsonl `
  --complete work/ignored/trajectory-utility/data/complete-trajectory.train.jsonl `
  --eval work/ignored/trajectory-utility/data/held-out.eval.jsonl
pnpm --filter @trajpack/schema build
node experiments/trajectory-utility/validate_with_trajpack.mjs `
  work/ignored/trajectory-utility/data/answer-only.train.jsonl `
  work/ignored/trajectory-utility/data/complete-trajectory.train.jsonl `
  work/ignored/trajectory-utility/data/held-out.eval.jsonl
```

Linux/macOS use the same commands without PowerShell backticks.

## Reproducible GPU run

The smoke configuration fits an 8 GB CUDA GPU. Keep the environment, model
cache, adapters, predictions, and results outside Git in `work/ignored`:

```powershell
uv venv work/ignored/trajectory-utility/.venv --python 3.12
uv pip install --python work/ignored/trajectory-utility/.venv/Scripts/python.exe `
  -r experiments/trajectory-utility/requirements.cuda121.txt
uv pip install --python work/ignored/trajectory-utility/.venv/Scripts/python.exe `
  -r experiments/trajectory-utility/requirements.txt
work/ignored/trajectory-utility/.venv/Scripts/python.exe `
  experiments/trajectory-utility/run_experiment.py `
  --config experiments/trajectory-utility/config/smoke.json `
  --output work/ignored/trajectory-utility/runs/qwen2-05b-seed3407
```

After the pinned snapshot has been downloaded once, add `--local-files-only`
to eliminate runtime network access and fail closed on an incomplete cache.

On Linux, use `.venv/bin/python`. The CUDA 12.1 file pins the stack used for the
reference run; install a platform-appropriate pinned PyTorch build when CUDA
12.1 is unavailable. `requirements.txt` intentionally does not select a second
PyTorch build. The run manifest records the actual PyTorch/CUDA versions and
GPU, and the runner refuses to emit a CPU result for this committed config.

The run produces:

```text
run-state.json                 status, seed, config/input/source hashes, environment
results.json                   all three arms and paired rate deltas
arms/<arm>/result.json         per-example predictions, counts, rates, timing
adapters/<sft-arm>/            LoRA adapters (ignored; never commit model artifacts)
```

The output directory must not already exist. A failed run is preserved for
diagnosis, and a retry must use a fresh path; v0.1 never mixes or silently
resumes partial artifacts.

Primary held-out metrics are strict tool-call JSON validity, exact expression,
sandboxed execution, executable outcome correctness, direct-answer accuracy,
strict final-answer JSON, final accuracy by either valid route, and tool-using
end-to-end success. This prevents answer-only SFT from being called wholly
incorrect merely because it answers directly; only the tool/e2e metrics require
the action → observation route. Greedy decoding makes evaluation
deterministic for a fixed stack; CUDA library details remain recorded because
bitwise reproducibility across hardware is not promised.

## Replacing synthetic training input with real trajpack exports

`run_experiment.py` accepts JSONL whose records validate as `DatasetExample`
**and this experiment's stricter paired-evaluation contract**:

```powershell
python experiments/trajectory-utility/run_experiment.py `
  --answer-only work/ignored/my-export/answer-sft.jsonl `
  --complete work/ignored/my-export/deepseek-epoch-sft.jsonl `
  --eval work/ignored/my-owned-calculator-heldout.jsonl `
  --output work/ignored/trajectory-utility/runs/my-export-seed3407
```

For trajpack data, use policy-approved `answer_sft` for the answer arm and
`deepseek_epoch_sft` (or another action/observation-preserving recipe) for the
complete arm. The current evaluator remains intentionally calculator-specific:
held-out examples must include
`metadata.evaluation.expected_expression` and `gold_answer`. Other domains need
a separately versioned, executable evaluator; do not reinterpret this smoke
test's calculator metrics as coding or general-agent evidence.

The validator additionally rejects duplicate or unpaired task signatures,
different prompt/gold payloads under one signature, train/eval overlap, and any
held-out assistant/tool message or loss target. This prevents answer or tool
observation leakage into evaluation prompts.

## Interpretation guardrails

- Report counts and denominators, not only percentages.
- Compare the complete arm with **both** base and answer-only.
- Keep failed parsing and failed execution as failures.
- Do not tune on the held-out file after observing it.
- Do not call opaque provider signatures “reasoning” or attempt to recover
  hidden model state. This experiment learns only explicitly visible,
  authorized action/observation records.
- A useful next stage is a pre-registered multi-seed study on owned coding tasks
  with repository-level isolation and executable tests.
