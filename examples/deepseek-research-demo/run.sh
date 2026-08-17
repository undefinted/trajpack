#!/usr/bin/env sh
set -eu

DEMO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$DEMO_ROOT"
pnpm build
node scripts/demo-trajectory.mjs --clean
node --test examples/deepseek-research-demo/demo.test.mjs
