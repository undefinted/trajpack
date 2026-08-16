import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadTrace: vi.fn(),
}));

vi.mock("./secret.js", () => ({
  readPassphrase: vi.fn(async () => "test-passphrase-long-enough"),
}));

vi.mock("@trajpack/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@trajpack/core")>();
  return { ...actual, loadTrace: mocks.loadTrace };
});

import { fixtureBundle } from "../../../packages/core/src/testing.js";
import { createApprovalScope, sha256 } from "@trajpack/core";
import { runDatasetPlan } from "./dataset-command.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  mocks.loadTrace.mockReset();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("dataset plan CLI", () => {
  it("hashes private group aliases and freezes approved managed trace bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-plan-"));
    temporaryDirectories.push(root);
    const traceId = "0123456789abcdef0123456789abcdef";
    mocks.loadTrace.mockResolvedValue(fixtureBundle("approved research trajectory"));
    const groups = join(root, "groups.json");
    const output = join(root, "build.json");
    const secondOutput = join(root, "build-2.json");
    await writeFile(groups, JSON.stringify({ [traceId]: "private/repo-and-task-family" }));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const build = await runDatasetPlan([traceId], {
      output,
      name: "paper-fixture",
      mode: "archive",
      seed: "paper-1",
      groupMap: groups,
      qualityProfile: "sft_basic",
    });
    const secondBuild = await runDatasetPlan([traceId], {
      output: secondOutput,
      name: "paper-fixture",
      mode: "archive",
      seed: "paper-1",
      groupMap: groups,
      qualityProfile: "sft_basic",
    });

    expect(build.traces[0]).toMatchObject({ trace_id: traceId, group_basis: "explicit_hmac" });
    expect(build.traces[0]!.split_group_id).toMatch(/^[a-f0-9]{64}$/u);
    expect(secondBuild.traces[0]!.split_group_id).not.toBe(build.traces[0]!.split_group_id);
    expect(await readFile(output, "utf8")).not.toContain("private/repo-and-task-family");
    expect(await readFile(secondOutput, "utf8")).not.toContain("private/repo-and-task-family");
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("build_sha256"));
    expect(mocks.loadTrace).toHaveBeenCalledWith(traceId, "test-passphrase-long-enough");
  });

  it("rejects incomplete group maps and invalid split totals", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-plan-invalid-"));
    temporaryDirectories.push(root);
    const traceId = "0123456789abcdef0123456789abcdef";
    const groups = join(root, "groups.json");
    await writeFile(groups, "{}");
    await expect(runDatasetPlan([traceId], {
      output: join(root, "build.json"),
      name: "paper-fixture",
      mode: "archive",
      seed: "paper-1",
      groupMap: groups,
    })).rejects.toThrow("every selected trace id exactly once");
    await expect(runDatasetPlan([traceId], {
      output: join(root, "build-2.json"),
      name: "paper-fixture",
      mode: "archive",
      seed: "paper-1",
      train: 9000,
      validation: 1000,
      test: 1000,
    })).rejects.toThrow("total 10000");
  });

  it("applies strict warning gates during planning instead of deferring them to export", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-plan-quality-"));
    temporaryDirectories.push(root);
    const traceId = "0123456789abcdef0123456789abcdef";
    const bundle = fixtureBundle("diff --git a/file b/file");
    bundle.events[0]!.event_type = "artifact.patch";
    bundle.events[0]!.content[0]!.type = "patch";
    bundle.events[0]!.content[0]!.sha256 = sha256(bundle.events[0]!.content[0]!.value!);
    bundle.manifest.review.approval_scope = createApprovalScope(bundle, ["archive"]);
    mocks.loadTrace.mockResolvedValue(bundle);
    await expect(runDatasetPlan([traceId], {
      output: join(root, "build.json"),
      name: "strict-fixture",
      mode: "archive",
      seed: "paper-strict",
      qualityProfile: "research_strict",
    })).rejects.toThrow("QUALITY_REPO_COMMIT_EVIDENCE_MISSING");
  });
});
