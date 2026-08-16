# Security audit — 2026-08-16

Scope: dependency graph, encrypted vault format, capture capabilities, browser
permissions, loopback collector/reviewer boundaries, redaction, policy gates,
and plaintext exporters. This was a separate review pass from the feature
implementation and used adversarial tests for the findings below.

## Result

- `pnpm audit --prod`: no known production dependency vulnerabilities.
- Static permission/rendering audit: passed.
- Argon2id + XChaCha20-Poly1305 secretstream round-trip, wrong-key rejection,
  authenticated final-frame validation, and plaintext-at-rest assertion: passed.
- Chrome and Edge unpacked-extension tests: passed with only `activeTab`,
  `scripting`, local extension storage, and loopback host permission.
- Installed-tarball smoke test: passed for the CLI and loopback reviewer assets.
- Codex plugin and explicit-export skill validators: passed.
- Real unpacked-extension runs in locally installed Chrome and Edge: passed.
- Official ZIP adversarial fixtures: traversal, encryption, symlink/special
  files, duplicate-confusable paths, size deception, checksum corruption,
  excessive counts/sizes, format drift, and ambiguous layouts were rejected.

## Findings closed before release

1. The non-interactive vault passphrase and stale collector capabilities could
   reach a captured subprocess. Child and version-probe environments now remove
   them before injecting only a new session-scoped collector capability.
2. Structured tool arguments/results could bypass text-only secret scanning.
   Structured payloads, metadata, and links are now scanned and redacted; edited
   values receive new hashes and unresolved blob references block export.
3. HF/TRL could be requested with the archive decision. Training formats now
   require an explicit training decision, per-part rights, privacy checks, human
   approval, and a managed-vault trace.
4. A plaintext external bundle could self-assert approval. Export now accepts
   only an exact trace ID loaded from the managed encrypted vault.
5. Terms-registry records were informational. Provider/account decisions now
   require matching registry authority evidence or a scoped contractual
   override, and registry defaults cap evaluator decisions.
6. Browser commercial-origin blocking existed only in extension code. The
   collector independently rejects ChatGPT, Claude, and DeepSeek origins and
   recomputes the submitted selector-recipe digest.
7. One-shot arm credentials could mix sessions. The collector atomically binds
   the first valid session ID and rejects later mismatches.
8. DeepSeek Harness compatibility metadata was not enforced. Both the wrapper
   and normalizer now fail closed unless the exact pinned runtime/interface is
   present.
9. Claude's opaque internal transcript needed a constrained acquisition path.
   Only an authenticated, already-bound `SessionEnd` can read a regular,
   session-named JSONL below the configured root; links, traversal, races, and
   oversized files fail closed, and the bytes are never parsed.
10. Official export archives needed a non-extracting ingestion boundary. The
    importer now validates every central/local record before using a chunked
    pure-JavaScript ZIP reader, caps both declared and actual output, selects
    only known shape-validated conversation files, and records container plus
    selected-entry hashes in encrypted raw provenance.
11. Generic human approval could be reused for a different purpose or changed
    content. Approval is now bound to the reviewed bundle, reviewer/time/notes,
    exact decision IDs, target, and an explicitly clicked set of purposes;
    edits reset it and exports verify it again.
12. Consent, provider labels, model/license claims, and event-level rights could
    be relabeled or asserted without enough evidence. Withdrawal and explicit
    purposes are now enforced, detected imports cannot be cross-provider
    relabeled, teacher model/digest and supported SPDX expressions are required
    on automatic training paths, and structured tool payloads require a current
    purpose/target-scoped rights attestation.
13. Provider metadata could self-assert rewards. Reward/verifier export now
    requires a versioned verifier artifact/result digest plus a separate local
    reviewer confirmation bound to the unchanged event.
14. Hook bodies could spoof outer session metadata or terminate another armed
    capture. Hook endpoints now always classify authenticated provider payloads
    server-side, reconcile the bound session/cwd/interface, and reject direct or
    wrapped raw envelopes. Hook forwarding and Harness delivery are serialized.
15. Vault reads, managed directories, and plaintext outputs needed stricter
    filesystem limits. Vault input is bounded before allocation, managed
    directories reject links and use private permissions, stale replacement
    files are cleaned, and exports are atomically created in a new 0700
    directory with 0600 files (including Parquet from its first open).
16. Release artifacts were missing complete license/hygiene checks. Every npm
    tarball and the unpacked Chromium build now contain Apache `LICENSE` and
    exact-version third-party notices, require Node 24 where applicable, and
    reject tests, specs, and source maps in pack smoke.

## Residual constraints

- JavaScript strings cannot be reliably zeroized. Interactive passphrase entry
  is preferred over environment variables.
- Pattern-based privacy scanning is defense in depth, not proof of anonymity or
  license ownership; human review remains mandatory.
- Selector authorization evidence is self-attested and content-addressed, not a
  third-party signature.
- No commercial-provider terms digest is silently trusted by URL. The built-in
  accepted-digest lists intentionally start empty, so those automatic/training
  paths require current, source/use/target-scoped evidence or a trace-scoped
  reviewed decision until a specific snapshot is independently reviewed.
- Source provider/model/license records are provenance claims, not remote
  cryptographic attestations. The local collector capability authenticates the
  capture process tree, so untrusted repository/tool subprocesses remain an
  integrity boundary.
- The reviewer defends against browser-origin attacks but treats other
  same-user loopback processes as part of the local-machine trust boundary; its
  per-launch fragment capability is still required for all API calls.
- Terms records and this audit are engineering safeguards, not legal advice.
- External plaintext exports and copies cannot be recalled by vault deletion.
