# Claude thinking signatures: supported boundary

Anthropic's current protocol gives a `thinking` block an opaque `signature`.
The provider documentation says the visible `thinking` text is a summary rather
than raw chain of thought, while the complete reasoning state is encrypted in
the signature for provider-side verification and multi-turn continuity. A
client must pass `thinking` and `redacted_thinking` blocks back unchanged when
the protocol requires them; it must not interpret, parse, reorder, or modify
the signature.

Primary references:

- [Anthropic thinking documentation](https://platform.claude.com/docs/en/build-with-claude/thinking)
- [Anthropic streaming documentation](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Anthropic API errors for modified thinking blocks](https://platform.claude.com/docs/en/api/errors)

## Disclosed replay evidence and its limits

The August 2026 paper
[Stealing Reasoning Traces from Proprietary LLM APIs](https://arxiv.org/abs/2608.09867)
reported empirical replay/transcription paths for opaque reasoning state,
including same-provider cross-model experiments involving Anthropic models.
This is meaningful historical security evidence; trajpack does not dismiss it
as mere rationale generation.

It is not, however, a supported API capability or a general proof of exact raw
CoT recovery. The paper describes the decoder as fuzzy, and for traces without
known plaintext it relies on proxy evidence such as billed thinking-token
lengths, determinism, planted signals, and qualitative correspondence. Those
signals can support an extraction hypothesis but cannot authenticate every
recovered token against the original plaintext. Most importantly, the paper's
reproducibility statement says that, after responsible disclosure and provider
mitigations, its reported attacks were no longer reproducible as of August
2026. Later third-party claims do not override that first-party status without
independent, authorized reproduction.

trajpack uses the following evidence vocabulary:

| Label | Required evidence | What it does not establish |
| --- | --- | --- |
| Authenticated raw CoT | Exact plaintext ground truth bound to the original provider state by a documented, independently verifiable mechanism | Similar length, deterministic output, behavioral agreement, or a plausible explanation is insufficient. Claude's public API does not provide this evidence. |
| Proxy signal | Token-count agreement, determinism, planted-marker recovery, behavioral agreement, or qualitative similarity | It may support a security finding but does not prove token-exact plaintext recovery. |
| `generated_rationale` | A new explanation inferred from the problem, answer, summary, model behavior, or another artifact | It is synthetic supervision, not the teacher's original reasoning, even when useful. |

Documented plaintext reasoning returned by a provider is separately classified
as `provider_exposed_reasoning`; it is not silently promoted to
"authenticated raw CoT," and it remains subject to provenance, rights, and
policy review.

## trajpack behavior

- The provider event, including a signature or `redacted_thinking.data`, may be
  retained only in the encrypted raw vault when capture and archive policy
  permit it.
- Opaque reasoning state is treated as potentially secret-bearing data. It is
  vault-only: no plaintext preview, log body, canonical content projection,
  training target, dataset sidecar value, or redistribution export is allowed.
  An allowed lineage record may retain only non-reversible metadata such as a
  digest, byte count, source field name, and deletion tombstone.
- Signature bytes and redacted payloads never become canonical content,
  messages, rationales, HF/TRL targets, rewards, or verifier labels.
- Visible Claude thinking is conservatively classified as `provider_summary`
  with `include_in_loss=false`. A redacted block becomes
  `opaque_reasoning_state`; a streaming `signature_delta` has no canonical
  projection.
- The internal Claude Code transcript remains an encrypted opaque artifact and
  is not parsed as another route to thinking content.
- Claude-derived material remains subject to the independent provider/account,
  capture, training-purpose, rights, consent, and target-model policy gates.

The raw vault preserves protocol evidence; it does not grant a decryption
capability. trajpack will not implement signature replay, cross-model routing,
decoding prompts, plaintext probes, or bypass tooling. It does not send an
opaque provider state to any model or claim that generated text is the
original reasoning.

## Interpreting new claims

A model emitting plausible reasoning after receiving an opaque value may be
evidence of a replay vulnerability when controlled proxy tests support that
conclusion. It still is not authenticated raw CoT unless exact plaintext can be
verified. If the output is instead reconstructed from a question, answer,
summary, or observed behavior, trajpack classifies it as `generated_rationale`,
not `provider_exposed_reasoning`, and it does not become training-eligible merely
because it resembles a reasoning trace.

For post-training research, use evidence that can be independently checked:
the request context, action, tool/environment observation, patch, test result,
failure recovery, and a versioned verifier bound to an explicit target event.
The DeepSeek Harness exact request-epoch recipe is the lead trajpack path for
that experiment design.
