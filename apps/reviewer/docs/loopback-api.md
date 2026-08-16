# Reviewer loopback API contract (`review/0.1`)

The reviewer is a static, CSP-compatible UI served by `trajpack review`. It never opens vault files itself and must be hosted on `http://127.0.0.1:<random-port>` (or the IPv6 loopback equivalent). Canonical fields in responses conform to `@trajpack/schema` `trajectory/0.1`; review records are an immutable overlay and never rewrite raw provider events.

## Security requirements

- Bind only to a loopback address and choose a random available port. Do not expose a wildcard listener.
- Generate a high-entropy session nonce and require it in the launch URL. Exchange it once for `csrf_token` through `GET /api/v1/review/bootstrap`, then remove it from browser history.
- Require `X-Trajpack-CSRF` and `X-Requested-With: trajpack-reviewer` on every state-changing request. Reject missing, reused-after-lock, or expired tokens.
- Require `Origin` and `Host` to exactly match the active loopback listener. Reject `Origin: null`, non-loopback origins, CORS preflights, and cross-site cookies.
- Use `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, and `Cross-Origin-Opener-Policy: same-origin` on all responses.
- Serve production assets with CSP `default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; font-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'`.
- Return provider-controlled data only as JSON. Never return pre-rendered HTML or executable links. The UI renders every content field as a React text node.
- Locking the vault invalidates the CSRF token and makes all content endpoints return `423 vault_locked`.

All responses use `Content-Type: application/json`. Errors use:

```json
{
  "error": {
    "code": "revision_conflict",
    "message": "Trace changed; refresh before saving"
  }
}
```

## Endpoints

### `GET /api/v1/review/bootstrap`

Returns the API version, per-launch CSRF token, server version, and vault lock state:

```json
{
  "api_version": "review/0.1",
  "csrf_token": "opaque-high-entropy-token",
  "server_version": "0.1.0",
  "vault": {
    "state": "unlocked",
    "idle_lock_at": "2026-08-16T05:00:00.000Z"
  }
}
```

### `GET /api/v1/review/traces`

Returns `{ "traces": TraceSummary[] }`. A summary includes `trace_id`, `created_at`, canonical `source`, automated/human review states, event/disposition/check counts, duration, and `updated_at`. The endpoint returns metadata only and no provider content.

### `GET /api/v1/review/traces/:traceId`

Returns `TraceDetail`:

- `manifest`: canonical `TraceManifest`.
- `events[]`: `{ event: TrajectoryEvent, review: EventReviewState }`.
- `checks[]`: automated structure/privacy/rights/quality results with affected event IDs.
- `metrics`: token, tool, failure, verifier, EGS, and TOR-derived metrics.
- `revision`: monotonically increasing integer used for optimistic concurrency.

`EventReviewState.disposition` is `include | exclude | redact`. `rights_override` is canonical `Rights | null`; `null` inherits manifest rights.

### `PATCH /api/v1/review/traces/:traceId/events/:eventId`

Updates only the review overlay. Body:

```json
{
  "expected_revision": 4,
  "disposition": "redact",
  "note": "Customer identifier is unnecessary",
  "redaction_replacement": "[REDACTED BY REVIEWER]"
}
```

Omitted fields are unchanged; explicit `null` clears a note or replacement. Returns the updated `TraceDetail`. Return `409 revision_conflict` when `expected_revision` is stale.

### `PATCH /api/v1/review/traces/:traceId/events/:eventId/rights`

Body is `{ "expected_revision": number, "rights_override": Rights | null }`. A null override restores inheritance. Returns the updated `TraceDetail`.

### `POST /api/v1/review/traces/:traceId/decision`

Body:

```json
{
  "expected_revision": 6,
  "decision": "approved",
  "reviewer": "reviewer-local-01",
  "notes": "Verified patch, test result, consent, rights, and selected purposes",
  "approved_modes": ["archive", "training_competitive_distillation"]
}
```

`decision` is `approved | rejected`. An approval requires one or more explicit
`approved_modes` and is bound to the canonical content fingerprint, current
eligibility decision IDs, and target model/product. Any content, rights, policy,
target, or decision change invalidates it. Approval must fail closed if any
automated check is failed, a selected eligibility decision is not `allow`, any
included content part is quarantined/unknown-rights, or the vault was re-locked.
Rejection remains available even when checks fail. Returns updated `TraceDetail`.

### `POST /api/v1/review/traces/:traceId/export-preview`

Body is `{ "expected_revision": number, "format": "canonical" | "atif" | "hf-trl" | "otlp" }`. This performs policy evaluation but does not expose content or write a file. It returns counts, estimated plaintext size, license summary, destination hint, warnings, block reasons, and the exact confirmation phrase `EXPORT PLAINTEXT`.

### `POST /api/v1/review/traces/:traceId/exports`

Body includes the preview fields plus `"confirmation_phrase": "EXPORT PLAINTEXT"`. Re-run every gate atomically; never trust the earlier preview. On success return:

```json
{
  "export_id": "export-01",
  "trace_id": "0123456789abcdef0123456789abcdef",
  "format": "hf-trl",
  "created_at": "2026-08-16T05:02:00.000Z",
  "destination": "C:/selected/path/dataset.jsonl",
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

The server, not the browser, owns the destination chooser and file write. It must never return raw decryption keys or vault paths.

## Development mock

`pnpm --filter @trajpack/reviewer dev` uses the in-memory mock by default. Set `VITE_REVIEW_USE_MOCKS=false` to exercise a real loopback server. Production builds always select the real API and tree-shake the development mock.
