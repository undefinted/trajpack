import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
import { runDatasetMigrate, runDatasetPlan } from "./dataset-command.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  mocks.loadTrace.mockReset();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("dataset plan CLI", () => {
  it("migrates a legacy frozen build only into a new explicit output", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-migrate-"));
    temporaryDirectories.push(root);
    const input = join(root, "legacy.json");
    const output = join(root, "current.json");
    const legacy = {
      record_type: "dataset_build",
      schema_version: "dataset-build/0.1",
      name: "legacy-research-set",
      policy_version: "policy/legacy-fixture",
      mode: "archive",
      target: null,
      view_recipe: "trace_full",
      quality_profile: "sft_basic",
      compiler_versions: {
        view: "trace-full-view/0.2",
        quality: "trajectory-quality/0.1",
        dedupe: "canonical-training-view+shingle-jaccard/0.3",
      },
      split_policy: {
        algorithm: "sha256-group-threshold-v1",
        seed: "legacy",
        ratios_bp: { train: 10_000, validation: 0, test: 0 },
      },
      traces: [{
        trace_id: "a".repeat(32),
        split_group_id: "b".repeat(64),
        group_basis: "trace_fallback",
        source_bundle_sha256: "c".repeat(64),
        approval_scope_sha256: "d".repeat(64),
        eligibility_decision_id: "legacy-decision",
      }],
    };
    await writeFile(input, JSON.stringify(legacy));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const migrated = await runDatasetMigrate(input, output);
    expect(migrated).toMatchObject({
      schema_version: "dataset-build/0.2",
      view_recipe_version: "trace-full-view/0.2",
      compiler_versions: {
        view: "dataset-view-selector/0.3",
        training_view: null,
        dedupe: "compiled-example+canonical-shingle-jaccard/0.4",
      },
    });
    expect(JSON.parse(await readFile(input, "utf8"))).toMatchObject({ schema_version: "dataset-build/0.1" });
    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({ schema_version: "dataset-build/0.2" });
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"build_sha256"'));
    await expect(runDatasetMigrate(input, output)).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("rejects migration output beneath a symlink or junction ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-output-link-"));
    temporaryDirectories.push(root);
    const actual = join(root, "actual");
    const linked = join(root, "linked");
    const nested = join(actual, "nested");
    await mkdir(nested, { recursive: true });
    await symlink(actual, linked, process.platform === "win32" ? "junction" : "dir");
    const input = join(root, "legacy.json");
    await writeFile(input, JSON.stringify({
      record_type: "dataset_build",
      schema_version: "dataset-build/0.1",
      name: "legacy-research-set",
      policy_version: "policy/legacy-fixture",
      mode: "archive",
      target: null,
      view_recipe: "trace_full",
      quality_profile: "sft_basic",
      compiler_versions: {
        view: "trace-full-view/0.2",
        quality: "trajectory-quality/0.1",
        dedupe: "canonical-training-view+shingle-jaccard/0.3",
      },
      split_policy: {
        algorithm: "sha256-group-threshold-v1",
        seed: "legacy",
        ratios_bp: { train: 10_000, validation: 0, test: 0 },
      },
      traces: [{
        trace_id: "a".repeat(32),
        split_group_id: "b".repeat(64),
        group_basis: "trace_fallback",
        source_bundle_sha256: "c".repeat(64),
        approval_scope_sha256: "d".repeat(64),
        eligibility_decision_id: "legacy-decision",
      }],
    }));

    await expect(runDatasetMigrate(input, join(linked, "nested", "current.json")))
      .rejects.toThrow("symbolic-link or junction ancestor");
  });

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

  it("freezes a versioned training recipe and rejects traces without an eligible view", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-dataset-plan-recipe-"));
    temporaryDirectories.push(root);
    const traceId = "0123456789abcdef0123456789abcdef";
    const bundle = fixtureBundle("licensed assistant answer");
    bundle.manifest.source.host = "manual_import";
    bundle.manifest.review.approval_scope = createApprovalScope(bundle, ["training_competitive_distillation"]);
    mocks.loadTrace.mockResolvedValue(bundle);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const build = await runDatasetPlan([traceId], {
      output: join(root, "answer-build.json"),
      name: "answer-recipe",
      mode: "training_competitive_distillation",
      seed: "answer-recipe",
      recipe: "answer_sft",
      qualityProfile: "sft_basic",
      targetModelOwner: "owner",
      targetProduct: "open-model",
    });
    expect(build.view_recipe).toBe("answer_sft");

    await expect(runDatasetPlan([traceId], {
      output: join(root, "tool-build.json"),
      name: "tool-recipe",
      mode: "training_competitive_distillation",
      seed: "tool-recipe",
      recipe: "tool_use_sft",
      qualityProfile: "sft_basic",
      targetModelOwner: "owner",
      targetProduct: "open-model",
    })).rejects.toThrow("VIEW_RECIPE_NO_ELIGIBLE_VIEWS");
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("build_sha256"));
  });
});
