# @trajpack/reviewer

Local-only React UI for reviewing normalized trajectories before plaintext training export.

```bash
pnpm --filter @trajpack/reviewer dev
pnpm --filter @trajpack/reviewer typecheck
pnpm --filter @trajpack/reviewer test
pnpm --filter @trajpack/reviewer build
```

Production output is copied into `@trajpack/cli/reviewer` by the CLI build and
ships inside the CLI tarball. The reviewer package itself stays private and is
not required by an installed CLI at runtime.

Development mode supplies two in-memory traces: an export-eligible DeepSeek Harness trajectory and a policy/PII-blocked Claude Code trajectory. Set `VITE_REVIEW_USE_MOCKS=false` to connect to the loopback API documented in [`docs/loopback-api.md`](docs/loopback-api.md). Mock code is removed from production builds.

Provider text and JSON are always rendered through normal React text nodes. The app does not use `dangerouslySetInnerHTML`, remote resources, Markdown rendering, executable links, or browser storage for trajectory content.
