# Evaluating whether trajectory data is useful

A successful export or a polished demo proves operability, not training value.
trajpack treats usefulness as an empirical claim that needs a frozen dataset,
matched ablations, held-out executable tasks, and uncertainty estimates.

## Evidence hierarchy

1. **Pipeline smoke:** the same encrypted raw evidence deterministically
   normalizes, passes review, compiles, exports, reloads, and validates.
2. **Narrow learning smoke:** a small open model improves on held-out synthetic
   tasks after training on trajpack views. This catches masking, chat-template,
   tool-call, and loader bugs, but does not establish broad agent capability.
3. **Matched benchmark ablation:** fixed tasks, teacher, student, harness,
   compute, and target-token budget; only the compiled trajectory view changes.
4. **External replication:** a second environment family and independently run
   evaluation reproduce the direction and practical size of the effect.

Video belongs to level 1. The local small-model experiment belongs to level 2.
Only levels 3–4 support a general research claim.

## Primary ablation

Derive every arm from the same approved raw traces so collection, rights,
consent, and teacher quality cannot move between arms:

| Arm | View | Question |
| --- | --- | --- |
| A0 | Base model, no SFT | What can the student already do? |
| A1 | Final answer or patch only | Is outcome imitation sufficient? |
| A2 | Naively flattened transcript | Does merely adding tokens help? |
| A3 | Exact request epoch, Action + Observation, no reasoning | Does model-visible environment grounding add value? |
| A4 | A3 + eligible DeepSeek `provider_exposed_reasoning` | What is the marginal value of exposed reasoning? |
| A5 | A3 with targeted observation masking | Is the observation actually carrying the gain? |

For A1–A5, match both the task set and the number of assistant target tokens.
Report an example-matched sensitivity analysis separately. Privacy, rights,
consent, provenance, and train/eval leakage gates are never ablated.

`deepseek_epoch_sft` is the A3/A4 source compiler. `reasoning_sft` is not a
shortcut for A4 because it lacks the exact request surface on its own. Claude
signatures, redacted thinking, provider summaries, and opaque states are not
eligible reasoning targets.

## Dataset and split controls

- Pin the DeepSeek Harness, adapter, recipe, tokenizer, model, tool schemas,
  container, repository revisions, and verifier versions.
- Split by repository/task family and time before selecting rollouts. Keep all
  parent/child traces and near duplicates in the same split.
- Use multiple rollouts per task and freeze failed, cancelled, and partial
  attempts before looking at evaluation results.
- Run N = 500, 2k, 8k, and 15k trajectory scaling points when budget permits.
- Use at least three training seeds. For stochastic agent evaluation, use five
  rollouts per task/configuration or justify a different power calculation.

## Endpoints

Primary endpoint:

- executable task success or pass@1 on a preregistered held-out benchmark.

Secondary endpoints:

- valid tool-call rate and call/result completion;
- success per generated token, environment step, wall time, and inference cost;
- first-error recovery rate and verify-after-action rate;
- patch/test consistency and reward-hacking gap on verifier holdout tasks;
- pointwise reward AUROC, AUPRC, Brier score, and calibration error where the
  `pointwise_reward_rl_ready` view is used.

Use task-cluster paired bootstrap confidence intervals and report absolute
percentage-point effects. A hierarchical logistic model with task/repository
and training seed as random effects is a useful secondary analysis. Correct
multiple secondary comparisons, for example with Holm's method.

## SFT to RL comparison

With a real executable verifier, compare under the same environment-step and
GPU budget:

- base model to online RL;
- final-answer SFT to RL;
- exact Action–Observation SFT to RL;
- exact Action–Observation plus eligible DeepSeek reasoning SFT to RL.

Plot success against environment steps and compare area under the learning
curve. A terminal outcome reward does not authorize trajpack to invent step
rewards. DPO requires genuine, same-task paired rollouts with an independently
verified ordering.

## Related primary evidence

- [Interaction Trajectories / Terminal-Lego](https://arxiv.org/abs/2606.03461)
  reports matched trajectory, observation-masking, and trajectory-observation
  ratio ablations that motivate environment-grounded supervision.
- [FireAct](https://arxiv.org/abs/2310.05915) studies trajectory-SFT scaling,
  noisy observations, and cross-task generalization.
- [Agent-FLAN](https://arxiv.org/abs/2403.12881) studies balanced agent data,
  reasoning/retrieval/understanding decomposition, and real negative examples.
- [SERA](https://arxiv.org/abs/2601.20789) uses soft-verified repository
  trajectories for coding-agent SFT.
- [Agent Lightning](https://arxiv.org/abs/2508.03680) motivates deriving
  training transitions from agent spans while retaining real reward semantics.
- [Anthropic's CoT faithfulness study](https://www-cdn.anthropic.com/b9ca6db27f02a9ddf0d4fdb51b26432c99a27be0.pdf)
  is a reminder that a written rationale is not itself proof of the model's
  causal reasoning process.

## Claim language

Acceptable after a level-2 smoke:

> The exported trajectory view is learnable and the tool-use/masking pipeline
> functions end to end on this controlled task family.

Acceptable only after matched held-out benchmark evidence:

> Exact environment-grounded trajectory compilation improves task success over
> answer-only and flattened-transcript controls under a fixed training budget.

Do not claim that a demo, lower training loss, a plausible rationale, or a
teacher's reputation proves general usefulness.
