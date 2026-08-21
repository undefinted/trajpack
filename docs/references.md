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

## Opaque reasoning state and reconstructed rationales

These references inform a security boundary, not an extraction feature:

- [Anthropic extended thinking](https://platform.claude.com/docs/en/build-with-claude/thinking),
  [OpenAI reasoning models](https://developers.openai.com/api/docs/guides/reasoning),
  and [Gemini thinking](https://ai.google.dev/gemini-api/docs/thinking): first-party
  descriptions of summaries and opaque/encrypted state used for conversation
  continuity. They do not expose a client-side raw-CoT decoding interface.
- [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode):
  first-party documentation for plaintext `reasoning_content`. trajpack may
  classify eligible, complete content from this documented field as
  `provider_exposed_reasoning`; it is still not called cryptographically
  authenticated raw CoT.
- [Stealing Reasoning Traces from Proprietary LLM APIs](https://arxiv.org/abs/2608.09867):
  an August 2026 responsible-disclosure study that empirically demonstrated
  historical opaque-state replay/transcription paths, including cross-model
  cases. Its token-length, determinism, marker, and behavioral evidence does
  not authenticate every plaintext token, and its reproducibility statement
  says the reported attacks no longer worked after provider mitigations.
- [Trace Inversion Attack](https://arxiv.org/abs/2603.07267) and its
  [official implementation](https://github.com/Tingwei-Zhang/Trace_Inversion_Attack):
  generate synthetic rationales from a problem, answer, and optional summary.
  These may be evaluated as `generated_rationale`, never represented as a
  recovered teacher trace.
- [Awesome-Black-Box-CoT](https://github.com/Liuziyu77/Awesome-Black-Box-CoT):
  a discovery index for this emerging literature, not independent validation
  or a runtime dependency.
- [Anthropic Commercial Terms](https://www.anthropic.com/legal/commercial-terms),
  [OpenAI Services Agreement](https://openai.com/policies/services-agreement/),
  [Gemini API Terms](https://ai.google.dev/gemini-api/terms), and
  [DeepSeek Terms of Use](https://cdn.deepseek.com/policies/en-US/deepseek-terms-of-use.html):
  first-party terms used by the policy registry. Archive permission, interface
  authorization, training purpose, target model, and redistribution remain
  separate gates; a research paper or technical possibility grants none of
  them.

trajpack deliberately includes no replay, decoding, cross-model routing, or
bypass implementation. An opaque provider value remains potential secret data
inside the encrypted vault; proxy evidence and generated rationale remain
distinct from authenticated raw CoT.

The quality report emphasizes environment observation → action → result →
verification completeness. Teacher identity or rationale length is never a
standalone quality score.
