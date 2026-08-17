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

## Gemini CLI

The extension in `plugins/trajpack-gemini` uses Gemini CLI's documented
`gemini-extension.json` plus `hooks/hooks.json` layout. Install it with
`gemini extensions link <absolute-path>/plugins/trajpack-gemini`, confirm it
with `gemini extensions list`, and restart Gemini CLI. It is pinned to the
Trajpack contract `gemini-cli-hook/1`; other declared interfaces fail closed.

The hook adapter consumes the documented common fields (`session_id`,
`transcript_path`, `cwd`, `hook_event_name`, and `timestamp`) plus these
event-specific projections:

- `BeforeAgent.prompt` and `AfterAgent.prompt_response` become visible user and
  assistant messages.
- `BeforeModel.llm_request` / `BeforeToolSelection.llm_request` and
  `AfterModel.llm_response` retain the stable model projection and usage.
- `BeforeTool.tool_name` + `tool_input` and `AfterTool.tool_response` retain
  tool I/O. The stable hook schema has no tool-call ID, so the adapter uses a
  deterministic synthetic correlation ID and marks it as synthetic.
- `Notification` with `notification_type: ToolPermission` is an approval
  request, never an invented decision. Other documented notification variants
  remain non-training environment markers. `PreCompress` is a compaction
  boundary. `SessionStart` and best-effort `SessionEnd` retain session lifecycle.

Gemini sanitizes extension environments. `trajpack capture gemini` and
`trajpack arm gemini` therefore place an expiring, cwd-bound capability at
`~/.trajpack/runtime/arm-gemini_cli.json`; direct `TRAJPACK_*` variables remain
supported for controlled tests and compatible launches. The forwarder accepts
only authenticated loopback HTTP, rejects unsafe file permissions, expiry and
cwd mismatch, emits only Gemini's inert JSON hook response, and never creates a
plaintext spool. Hooks expose neither hidden reasoning nor a stable subagent
topology, so this adapter emits no reasoning or fabricated child-agent events.

## DeepSeek Harness

The native plugin is pinned to the official Developer Preview package
`@deepseek-ai/dsh@0.1.0-rc.6`, session format `0`, and interface
`deepseek-harness@0.1.0-rc.6/session-event/0`. Its `dsh.bundle` manifest and
`cordis.patch.yml` make it an installable profile layer:

```text
pnpm --filter @trajpack/deepseek-harness-plugin build
dsh plugin --profile web add <absolute-path>/plugins/deepseek-harness
dsh --profile web --dump-config
```

The plugin subscribes with the real callback signature
`session/event(session, event)`. It deliberately does not serialize the live
`Session` object, which may be cyclic and contains more state than the durable
record. It forwards this bounded capsule instead:

```text
session_id + minimal session_header (including Session.firstLiveSeq)
+ resolved provider/model route
+ event { type, seq, time, data, ignorable? }
```

The adapter requires the exact interface pin, header version `0`, matching
session IDs, valid non-negative sequence/time fields, and contiguous per-session
sequence numbers beginning at the official live-process boundary. This allows a
resumed session to start above zero while still detecting a plugin loaded after
part of the live event stream was already missed. Exact duplicate delivery is
idempotent; a conflicting payload for the same session/sequence, or any gap,
quarantines the temporary vault before canonical resequencing. Unknown required
records and incompatible descriptor versions
produce no canonical projection and make live capture publication fail closed;
they are not coerced into plausible training events or partial training traces.
The rc.6 golden fixtures use the actual durable names (`approval/asked`,
`approval/decided`, `llm/retry`, `llm/retry-started`, and
`subagent/descriptor`) rather than synthetic lifecycle names.

Turn/step boundaries, request route, text/reasoning chunks, calls/results,
retry attempts, compaction brackets, approvals, and child-session topology are
retained when the official event carries them. A child edge comes from its
session header's `parentSession` plus descriptor version 2; no nonexistent
subagent-stop or handoff event is invented.

Harness is provider-neutral. A durable `reasoning` block is classified as
`provider_exposed_reasoning` only when the resolved provider route is DeepSeek;
the same block from another or unknown provider is
`opaque_reasoning_state`. Both remain excluded from loss by default. The plugin
is inert without the short-lived collector variables supplied by
`trajpack capture dsh`; it writes no local log or plaintext fallback.

Harness rc.6 defines `session/event` as observe-only and `session/flush` as its
awaited durability checkpoint. Trajpack registers both surfaces and an async
Cordis dispose effect: normal flush waits for the session's collector queue,
profile teardown drains all admitted tail events, and network or non-2xx HTTP
failures reject the checkpoint. The durable `request/header.data.header.config`
provider/model pair is reconciled with the capsule route and the declared
teacher; the evidence digest is recorded in the manifest without claiming a
provider signature.

## Native compatibility and validation status

| Surface | Pinned interface | Implemented path | Current validation boundary |
| --- | --- | --- | --- |
| Codex CLI / hooks | JSONL + hook pins; App Server v2 JSON-RPC pin | `plugins/trajpack` and offline adapters | Codex plugin structure passes the bundled plugin validator; golden fixtures cover exec, hooks and App Server messages. The adapter does not launch or proxy App Server. |
| Claude Code | stream-json and hook pins | `plugins/claude-code` | Golden fixtures cover stream, hooks, subagents and opaque transcript retention. Private transcript JSONL is never parsed. |
| Gemini CLI | `gemini-cli-hook/1` | `plugins/trajpack-gemini` | Official-format manifest/hook vocabulary and armed/unarmed descriptor forwarding are fixture-tested. A live Gemini binary is not required by the test suite. |
| DeepSeek Harness | `@deepseek-ai/dsh@0.1.0-rc.6`, session format 0 | `plugins/deepseek-harness` | Plugin callback and bundle metadata are tested against rc.6's published types and event catalog; every Harness upgrade requires new golden fixtures before changing the pin. |

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
