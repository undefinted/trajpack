# Design references

`trajpack` does not depend on these projects at runtime. The design borrows the
following ideas while keeping raw evidence, normalization, policy, and training
views independently rerunnable:

- [claude-tap](https://github.com/liaohch3/claude-tap): capture-coverage baseline.
- [Agent Data Protocol](https://github.com/neulab/agent-data-protocol),
  [ATIF](https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md),
  and [AgentIR](https://github.com/WhitzardAgent/agentir): raw → normalized →
  training-view separation.
- [AgentLens](https://github.com/dreadnode/agent-lens) and
  [reproducible-trajectories](https://github.com/ASSERT-KTH/reproducible-trajectories):
  git state, patches, replayability, and user confirmation.
- [SERA](https://github.com/allenai/SERA),
  [Open-R1](https://github.com/huggingface/open-r1), and
  [DeepSeek-R1](https://github.com/deepseek-ai/DeepSeek-R1): verification,
  deduplication, assistant-only loss masks, and teacher provenance.
- [ReAct](https://arxiv.org/abs/2210.03629),
  [FireAct](https://github.com/anchen1011/FireAct),
  [Agent-FLAN](https://github.com/InternLM/Agent-FLAN), and
  [Agent-R](https://github.com/ByteDance-Seed/Agent-R): retain action,
  observation, rejection, failure, and recovery instead of success-only answers.
- [Agent Lightning](https://github.com/microsoft/agent-lightning): capture once,
  derive multiple span-based training views. v1 does not implement RL.
- [Interaction Trajectories](https://arxiv.org/abs/2606.03461): report
  environment-grounded supervision and trajectory outcome-reliability signals
  without treating long rationales as a proxy for quality.

The quality report emphasizes environment observation → action → result →
verification completeness. Teacher identity or rationale length is never a
standalone quality score.
