# Security model

## Trust boundaries

Provider events, imported archives, DOM text, tool output, repository content,
and reviewer-visible strings are untrusted data. They are never executed or
rendered as HTML. The reviewer binds only `127.0.0.1`, uses a one-time launch
nonce, HttpOnly SameSite cookie, strict Host/Origin/Sec-Fetch checks, a separate
CSRF token, no-store responses, and a restrictive CSP.

Official ZIP imports never extract members to the filesystem. All entries are
validated before selected conversation data is decoded, with hard entry-count,
per-entry, and total-uncompressed limits. Path traversal, duplicate/confusable
paths, encryption, ZIP64, symlink/special-file attributes, overlapping records,
checksum mismatch, unsupported methods, and local/central metadata disagreement
are rejected. Only known conversation filenames plus validated ChatGPT/Claude
shapes are selectable; ambiguity and format drift fail closed.

The hook collector accepts only a high-entropy bearer token. Hook forwarding is
no-op unless an explicit wrapper token or unexpired one-shot arm descriptor is
present. It does not write a plaintext fallback spool. The browser collector
requires an exact extension origin, one-time pairing nonce, and a recipe digest
that is recomputed against the submitted selectors and authorization evidence.
Collectors enforce bounded request bodies plus configurable hard limits on
captured events and cumulative raw bytes. Wrapper stdout additionally has a
20 MiB single-line limit. Exceeding any limit aborts the capture rather than
finalizing a partial vault. Hook authentication and a four-request admission
limit run before JSON body parsing; hook bodies are capped at 8 MiB, browser
captures at 20 MiB, and malformed authenticated traffic has its own bounded
attempt budget instead of consuming the valid-event quota.

Claude Code's opaque JSONL artifact is never selected from a `SessionEnd` path
alone. The collector first requires the session's cwd-matching `SessionStart`
hook and its documented common `transcript_path`, then binds the session ID,
resolved path, real parent directory, and file identity. `SessionEnd` must name
that exact bound file, which must retain the same identity and pass the existing
root-containment, no-link, fstat, and size checks. A missing/invalid
`SessionStart` path, another session/cwd/project path, or a file replaced after
binding produces no opaque artifact. This follows Claude Code's documented
[SessionStart input](https://code.claude.com/docs/en/hooks#sessionstart-input);
trajpack does not depend on the private JSONL field schema.

The wrapper capability is inherited by the explicitly launched host so its
native plugin can post events. A host may in turn pass environment variables to
repository commands or tools. Consequently, the bearer proves membership in
that local capture process tree; it does **not** prove that an event came from a
provider or that untrusted repository code could not forge an event. Use a
clean, trusted execution environment for provenance-sensitive collection and
retain provider request/response artifacts when available. Source provider,
model, and license claims remain reviewer-verifiable evidence, not cryptographic
attestation by trajpack. In particular, a token-bearing child could race a
forged `SessionStart`; the transcript binding prevents later cross-project path
switching but cannot cryptographically identify the genuine Claude process.

Source manifests therefore carry an independent authenticity tier:
`cryptographically_verified`, `request_receipt_verified`, `locally_observed`,
`user_supplied`, `user_authorized_observation`, or `unknown`. Import format
detection never upgrades this tier. A user-supplied offline API response needs
an evidence-backed, trace-scoped manual training decision; legal permission and
teacher-source authenticity are separate questions.

For the default native DeepSeek Harness path, the pinned adapter also requires
a durable `request/header` event and reconciles its provider/model against the
manifest. The resulting evidence reference is bound to those raw header
envelopes. This detects configuration/label drift; because the local capture
process tree can forge events, it still is not a provider signature. Self-hosted
weights remain stricter and need an evidence-backed manual runtime-binding
decision before training.

## Vault

`.trajpack` uses Argon2id13 with libsodium moderate parameters and a random salt,
then XChaCha20-Poly1305 secretstream with an authenticated final frame. Each raw
event is an encrypted frame with a sequence and SHA-256. The passphrase/key stays
in process memory only; v1 intentionally has no keychain persistence. The review
process clears its passphrase reference on idle lock.

Vault headers are public metadata. Prompt, response, tool result, code, and
normalized content must not occur in plaintext vault bytes or logs. A plaintext
export is always explicit, goes to a new directory, and cannot be recalled after
the user copies it elsewhere.

Plaintext serializers write only inside a random 0700 staging directory with
0600 files. They publish through a same-parent rename after checksums and a
`COMPLETE` marker exist. A failed serializer leaves no final destination;
verified staging paths are removed on failure.

Wrapper-mode authoritative JSON stdout and provider stderr are consumed without
being echoed. Only sanitized byte counts, trace IDs, and check status are logged;
redirecting `trajpack capture` therefore does not create a plaintext event log.

## Opaque provider reasoning state

Claude thinking signatures and `redacted_thinking.data`, OpenAI reasoning
`encrypted_content`, and Gemini thought signatures are provider protocol state,
not training text. Official provider documentation requires clients to preserve
or replay these values only as specified for the originating conversation; it
does not document them as a plaintext reasoning interface:

- [Anthropic extended thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)
- [OpenAI reasoning models](https://developers.openai.com/api/docs/guides/reasoning)
- [Gemini thinking](https://ai.google.dev/gemini-api/docs/thinking)

The responsibly disclosed study
[Stealing Reasoning Traces from Proprietary LLM APIs](https://arxiv.org/abs/2608.09867)
reported historical replay/transcription attacks against opaque reasoning
state. The result is security-relevant, but its token-count, determinism,
marker, and behavioral checks are proxy signals rather than authenticated raw
plaintext for every trace. The paper also states that the reported attacks were
no longer reproducible after provider mitigations as of August 2026.

Because an opaque protocol ciphertext/signature field may encode reasoning
derived from prompts, private files, credentials, or tool results—and because
its contents cannot be scanned before provider-side decryption—trajpack treats
recognized fields such as `signature`, `redacted_thinking.data`,
`encrypted_content`, and `thoughtSignature` as potential secrets:

- it may exist only inside an encrypted raw vault under an allowed archive
  decision;
- the protocol value is never rendered as content, written to logs, projected into canonical
  events, used as a loss target, copied into an export sidecar, or redistributed;
- diagnostics and lineage may retain only a digest, byte count, source field,
  adapter version, and tombstone;
- the bounded raw inventory blocks export if its scan cannot finish; pinned
  adapter/interface drift also blocks publication rather than guessing a new
  projection.

The taxonomy label `opaque_reasoning_state` is broader than a ciphertext key.
For example, a visible but unverifiable Codex App Server reasoning delta may be
kept in the encrypted canonical review layer under that label. Reviewers can
inspect that visible text locally, but `include_in_loss=false` and export
selection remove it from training content. This does not weaken the stricter
vault-only rule for actual protocol signatures/ciphertexts.

trajpack does not implement or facilitate signature replay, cross-model
routing, decoding prompts, plaintext probing, or protection bypasses. Text
reconstructed from answers, summaries, or observable behavior is
`generated_rationale`; length agreement or behavioral similarity does not
upgrade it to authenticated raw CoT. See the
[Claude signature boundary](claude-thinking-signatures.md) for the evidence
taxonomy. This technical boundary is independent of the provider/account,
interface-authorization, training-purpose, target-model, and redistribution
policy gates; a published security result supplies no permission to reproduce
it against a service.

## Browser restrictions

The extension requests only `activeTab`, `scripting`, local extension storage,
and `http://127.0.0.1/*`. It runs after a click, in an isolated world, and reads
visible accessible text selected by a content-addressed, self-attested recipe.
The digest proves recipe integrity, not third-party signature authority. It has no web-origin host
permission, background service worker, network interception, debugger, cookie,
localStorage, token, incognito, or MAIN-world access. ChatGPT, Claude, and
DeepSeek origins are explicitly blocked.

## Known v1 limits

- JavaScript strings cannot be reliably zeroized; avoid environment-variable
  passphrases for routine use.
- Secret/PII detection is conservative pattern matching, not a proof that data
  is anonymous or license-clean.
- Deleting a managed vault writes a tombstone but cannot delete external
  plaintext copies.
- Terms and authorization references are evidence records, not legal opinions.
- Native capture credentials authenticate a local process tree, not an
  adversarial host/tool subprocess or the upstream model provider.
- Dataset planning/export currently uses a bounded in-process compiler. A
  selection whose conservative decrypted-object estimate exceeds 256 MiB must
  be split into smaller builds; a future streaming compiler can lift this cap.
- Dataset export performs stable group splitting, complete-view exact checks,
  and a versioned, bounded token-shingle Jaccard pass over text, code, patches,
  and structured tool traffic. It does not claim embedding-level semantic
  deduplication, tokenizer-aware packing, or cryptographic signatures over
  reviewer identity; research-strict builds fail closed if the bounded scan
  cannot complete.

Report security issues privately to the repository maintainers. Do not attach
real prompts, credentials, vault files, or exported datasets to a public issue.
