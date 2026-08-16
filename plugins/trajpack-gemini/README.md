# Trajpack for Gemini CLI

This is an official-format Gemini CLI extension. It forwards only documented
hook stdin records to an authenticated loopback collector while a
`trajpack capture gemini` wrapper or unexpired `trajpack arm gemini` descriptor
is active. Otherwise it emits the required inert JSON hook response and does
not read or write trajectory content.

Install or link it with the Gemini CLI extension manager:

```text
gemini extensions link <path-to-trajpack>/plugins/trajpack-gemini
gemini extensions list
```

Restart Gemini CLI after linking. Gemini sanitizes extension environments, so
`trajpack capture gemini` and `trajpack arm gemini` place an expiring,
cwd-bound descriptor at `~/.trajpack/runtime/arm-gemini_cli.json`; the
forwarder rejects unsafe permissions, expired
descriptors, and cwd mismatches. The adapter is pinned to
`gemini-cli-hook/1`. It observes visible prompts, the stable model projection,
tool I/O, permission notifications, and session/compression boundaries. The
hook API does not expose hidden reasoning, approval decisions, stable tool-call
IDs, or a stable subagent topology; Trajpack does not invent them.
