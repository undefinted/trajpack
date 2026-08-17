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

## trajpack behavior

- The provider event, including a signature or `redacted_thinking.data`, may be
  retained only in the encrypted raw vault when capture and archive policy
  permit it.
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
capability. trajpack does not send a strong-model signature to another model,
probe for plaintext, or claim that generated text is the original reasoning.

## Why apparent "decoding" is not evidence

A model can emit a plausible rationale after seeing any opaque string. Without
authenticated plaintext ground truth and a documented cryptographic verifier,
that output demonstrates generation, not decryption. It must be classified as
`generated_rationale`, not `provider_exposed_reasoning` or raw CoT, and it does
not become training-eligible merely because it resembles a reasoning trace.

For post-training research, use evidence that can be independently checked:
the request context, action, tool/environment observation, patch, test result,
failure recovery, and a versioned verifier bound to an explicit target event.
The DeepSeek Harness exact request-epoch recipe is the lead trajpack path for
that experiment design.
