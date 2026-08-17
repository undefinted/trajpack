# Trajpack DeepSeek Harness plugin

This plugin subscribes only to Harness's durable `session/event` channel and forwards events directly to an explicitly armed loopback Trajpack collector. It does not inspect the Web UI, read session transcript files, or create a plaintext spool.

Build and install the plugin as a Harness profile bundle:

```text
pnpm --filter @trajpack/deepseek-harness-plugin build
dsh plugin --profile web add <absolute-path>/plugins/deepseek-harness
dsh --profile web --dump-config
```

The package declares `dsh.bundle.patch`, so `dsh plugin` adds its
`cordis.patch.yml` to the selected profile. Run Harness through
`trajpack capture dsh -- <dsh command>`; the wrapper supplies
`TRAJPACK_COLLECTOR_URL` and a one-time `TRAJPACK_CAPTURE_TOKEN`. Without both,
the listener is a silent no-op.

This release is pinned and fixture-tested against DeepSeek Harness
`0.1.0-rc.6`, with the durable interface identified as
`deepseek-harness@0.1.0-rc.6/session-event/0`. The callback is the official
`session/event(session, event)` signature. Only a minimal session header,
provider/model route, and the lossless `{ type, seq, time, data, ignorable? }`
record are forwarded; the potentially cyclic live Session object is never
serialized. The `trajpack capture dsh` wrapper verifies `dsh --version` before
opening a vault. Run the adapter golden fixtures before upgrading Harness
because format version 0 has no compatibility guarantee.
