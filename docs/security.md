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

The wrapper capability is inherited by the explicitly launched host so its
native plugin can post events. A host may in turn pass environment variables to
repository commands or tools. Consequently, the bearer proves membership in
that local capture process tree; it does **not** prove that an event came from a
provider or that untrusted repository code could not forge an event. Use a
clean, trusted execution environment for provenance-sensitive collection and
retain provider request/response artifacts when available. Source provider,
model, and license claims remain reviewer-verifiable evidence, not cryptographic
attestation by trajpack.

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

Wrapper-mode authoritative JSON stdout and provider stderr are consumed without
being echoed. Only sanitized byte counts, trace IDs, and check status are logged;
redirecting `trajpack capture` therefore does not create a plaintext event log.

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

Report security issues privately to the repository maintainers. Do not attach
real prompts, credentials, vault files, or exported datasets to a public issue.
