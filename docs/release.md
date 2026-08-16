# Release verification

Release checks run entirely from the workspace after the normal dependency
install:

```bash
pnpm audit --prod
pnpm audit:static
pnpm test:pack
```

`pnpm test:pack` performs a clean production build, creates tarballs with
`pnpm pack` for the CLI, its four internal runtime packages, and the pinned
DeepSeek Harness plugin, installs those
tarballs into a temporary project (preferring the local pnpm store), and runs
the installed CLI's `--help`. It also starts the installed review server, verifies
that its package-local `reviewer/index.html` and hashed assets are served, and
checks every tarball for `engines.node >=24`, `THIRD_PARTY_NOTICES.md`, and the
Apache-2.0 `LICENSE`, plus the absence of test/source-map artifacts. The
unpacked Chromium release directory is separately checked for its required
Manifest V3 files, `LICENSE`, `THIRD_PARTY_NOTICES.md`, and the same artifact
hygiene.

The published `@trajpack/cli` package must contain `dist/`, `reviewer/`, and the
third-party notice in both the CLI runtime and packaged reviewer directories.
Reviewer source remains a private workspace package; it is a build-time input,
not a runtime dependency. The Chromium extension is released independently as
the contents of `extensions/chromium/build/` after the same smoke test passes.

Every publishable TypeScript package deletes its previous `dist/` before
compilation. Production compilation excludes `*.test.*` and `*.spec.*` and does
not emit JavaScript or declaration sourcemaps, preventing stale development
files from entering a later pack.

Code artifacts are Apache-2.0. Exported datasets always carry their own dataset
card and license summary and do not inherit the code license.
