import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runDemo } from "../../scripts/demo-trajectory.mjs";

const DEMO_ROOT = dirname(fileURLToPath(import.meta.url));
// demo-trajectory.mjs writes replay artifacts under the repository root, not
// the process cwd; derive the root from this file so the test is cwd-independent.
// The test file lives at <root>/examples/deepseek-research-demo/, two levels down.
const REPOSITORY_ROOT = dirname(dirname(DEMO_ROOT));
const OUTPUT_MARKER = "trajpack-deepseek-research-demo/0.1\n";

async function text(root, name) {
  return readFile(join(root, ...name.split("/")), "utf8");
}

test("the synthetic DeepSeek research demo is deterministic and fails closed", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "trajpack-research-demo-"));
  const first = join(temporary, "first");
  const second = join(temporary, "second");
  try {
    const firstResult = await runDemo({ output: first, quiet: true });
    const secondResult = await runDemo({ output: second, quiet: true });

    assert.equal(firstResult.examples, 2);
    assert.equal(firstResult.failureReport.export_blocked, true);
    assert.deepEqual(firstResult.failureReport.raw_integrity_reasons, ["RAW_SEQUENCE_GAP"]);
    assert.equal(firstResult.utilityEvidence.hidden_chain_of_thought_present_or_claimed, false);
    assert.equal(firstResult.utilityEvidence.empirical_model_improvement_claimed, false);
    assert.equal(firstResult.utilityEvidence.fabricated_reward_count, 0);

    assert.equal(await text(first, "reproducibility.json"), await text(second, "reproducibility.json"));
    assert.equal(await text(first, "checksums.sha256"), await text(second, "checksums.sha256"));
    assert.equal(await text(first, "hf-trl/dataset.jsonl"), await text(second, "hf-trl/dataset.jsonl"));

    const dataset = await text(first, "hf-trl/dataset.jsonl");
    assert.doesNotMatch(dataset, /session_header|first_live_seq|seed_length/u);
    assert.match(dataset, /"hidden_chain_of_thought_claimed":false/u);
    assert.match(dataset, /"reward":null/u);

    const replay = await readFile(join(REPOSITORY_ROOT, "work", "demo-replay", "trajpack-deepseek-demo.json"), "utf8");
    assert.doesNotMatch(replay, /trajpack-research-demo-|[A-Za-z]:[\\/]|\/(?:home|Users)\//u);
    assert.match(replay, /"actual_run":true/u);
    assert.match(replay, /"training_effect_evidence":false/u);
    const safeTranscript = await readFile(join(REPOSITORY_ROOT, "work", "demo-replay", "trajpack-deepseek-demo.txt"), "utf8");
    assert.doesNotMatch(safeTranscript, /trajpack-research-demo-|[A-Za-z]:[\\/]|\/(?:home|Users)\//u);
    assert.match(safeTranscript, /PASS: 2 exact SFT epochs/u);
    assert.match(safeTranscript, /not a downstream model-quality claim/u);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("--clean refuses a parent symlink or Windows junction that escapes the demo root", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "trajpack-clean-boundary-"));
  const outside = join(temporary, "outside");
  const managed = join(outside, "managed");
  const sentinel = join(managed, "must-survive.txt");
  const link = join(DEMO_ROOT, `.clean-boundary-${randomUUID()}`);
  let linkCreated = false;
  try {
    await mkdir(managed, { recursive: true });
    await writeFile(join(managed, ".trajpack-demo-output"), OUTPUT_MARKER);
    await writeFile(sentinel, "outside demo root\n");
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    linkCreated = true;

    await assert.rejects(
      runDemo({ output: join(link, "managed"), clean: true, quiet: true }),
      /symbolic link|junction|reparse point|filesystem indirection/u,
    );
    assert.equal(await readFile(sentinel, "utf8"), "outside demo root\n");
    assert.equal(await readFile(join(managed, ".trajpack-demo-output"), "utf8"), OUTPUT_MARKER);
  } finally {
    if (linkCreated) await unlink(link).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
});
