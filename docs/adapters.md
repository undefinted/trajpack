# Capture adapters

## Codex

For new non-interactive runs, pass the official JSON event mode to the wrapped
command. The adapter also understands official hook lifecycle events and the
visible JSON-RPC messages from the documented Codex App Server v2 event stream.
The App Server contract is pinned as `codex-app-server-v2-jsonrpc/1`; any other
declared interface fails closed. This adapter is an offline JSONL mapper: it
does not start, connect to, or proxy an App Server.

For a client that supports a custom App Server command, configure
its documented App Server stream for offline import through the pinned adapter.
`trajpack capture codex` itself intentionally consumes JSON events without
echoing them to stdout, because shell redirection must not become an accidental
plaintext trajectory spool. Codex hooks supplement approval and host lifecycle
evidence that is not present in the outbound stream.

App Server thread, turn, and item IDs become stable logical spans. Item deltas
remain partial observations, while `item/completed` is marked as the
authoritative final state. Command, MCP, dynamic-tool, approval, compaction,
plan, diff, usage, error/retry evidence, and `collabToolCall` child-agent events
retain their typed IDs and lifecycle metadata. Server requests and client
decision records are normalized only when those visible wire records were
actually captured; `serverRequest/resolved` is explicitly marked as a
resolution without an observed decision.

Reasoning summary fields are `provider_summary`. App Server raw-reasoning
blocks and `textDelta` records are retained as `opaque_reasoning_state` with no
provider Chain-of-Thought claim and remain excluded from loss by default.
Messages are deduplicated by a provider event ID when present, otherwise by a
deterministic content hash. Local transcript files are never parsed.

The Codex plugin is `plugins/trajpack`; it contains `.codex-plugin/plugin.json`,
official `hooks/hooks.json`, and the `export-agent-trajectory` skill.

## Claude Code

Use a command that emits `--output-format stream-json --verbose` for the highest
fidelity wrapper stream. The plugin hooks preserve session, tool, stop, and
subagent lifecycle events. For an authenticated, session-bound `SessionEnd`, a
regular `.jsonl` below `~/.claude/projects` may be copied byte-for-byte into an
encrypted `claude-transcript-opaque/1` raw artifact. The artifact stores Base64
bytes, content hash, size, and a keyed path digest—not the plaintext path. The
internal JSONL schema is never parsed and the artifact produces no canonical
events. Symlinks, traversal, mismatched session filenames, and oversized files
fail closed without a plaintext fallback. The v1 opaque artifact limit is 64
MiB; its Base64 representation stays within a separately bounded authenticated
vault frame.

Visible Claude thinking is classified as `provider_summary` or an opaque state,
not raw chain-of-thought.

## DeepSeek Harness

The native plugin subscribes directly to `session/event` and forwards the typed
append-only stream. It retains turn/step boundaries, request context, text and
reasoning chunks, calls/results, retries, compaction, approval, and agent links
when present. Compatibility is pinned and covered by golden fixtures; unknown
session persistence versions are refused.

Provider `reasoning_content` is `provider_exposed_reasoning` only when the
provider interface returns it. Harness narration and provider reasoning remain
different content kinds.

## Official/manual import

`trajpack import` conservatively detects validated ChatGPT and Claude official
JSON shapes, including current contiguous ChatGPT `conversations-000.json`
shards. It reads official ZIPs without extracting to disk and records both the
archive and selected-entry SHA-256 values. ZIP member count, per-entry size, and
aggregate uncompressed size are bounded before decoding; traversal, encryption,
ZIP64, symlink/special-file attributes, metadata disagreement, format drift,
and ambiguous candidates fail closed.

When no structured conversation entry exists, a uniquely named `chat.html`
with the conservative ChatGPT Data Export marker may be retained as inert text.
It is never executed or treated as DOM visibility evidence. Other
JSON/JSONL/HTML remains generic and unverified when imported directly.
Commercial websites do not have built-in DOM selectors.
