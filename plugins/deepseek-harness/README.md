# Trajpack DeepSeek Harness plugin

This plugin subscribes only to Harness's durable `session/event` channel and forwards events directly to an explicitly armed loopback Trajpack collector. It does not inspect the Web UI, read session transcript files, or create a plaintext spool.

Set both `TRAJPACK_COLLECTOR_URL` and the one-time `TRAJPACK_CAPTURE_TOKEN`, then register the built `dist/index.js` (or `src/index.ts` in a Harness source checkout) in the applicable `cordis.yml` overlay. Without both variables, the listener is a silent no-op.

This release is pinned and fixture-tested against DeepSeek Harness `0.1.0-rc.6`, with the durable interface identified as `deepseek-harness@0.1.0-rc.6/session-event/0`. The `trajpack capture dsh` wrapper verifies `dsh --version` before opening a vault; the plugin intentionally does not install or runtime-depend on Harness itself. Run the adapter golden fixtures before upgrading Harness because format version 0 has no compatibility guarantee.
