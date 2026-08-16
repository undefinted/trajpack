import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportApprovedBundle, toHfExample } from "./exporters.js";
import { createApprovalScope, reviewEvidenceFingerprint, validateApprovalScope } from "./policy.js";
import { fixtureBundle } from "./testing.js";

function reapprove(bundle: ReturnType<typeof fixtureBundle>): void {
  bundle.manifest.review.approval_scope = createApprovalScope(bundle, [
    "archive",
    "training_noncompetitive",
    "training_competitive_distillation",
    "redistribution",
  ]);
}

describe("exporters", () => {
  it("keeps native message structure and aligned loss masks", () => {
    const example = toHfExample(fixtureBundle());
    expect(example.messages).toHaveLength(example.assistant_loss_mask.length);
    expect(example.assistant_loss_mask).toEqual([true]);
  });

  it("exports rewards only with concrete verifier provenance", () => {
    const unverified = fixtureBundle();
    unverified.events[0]!.event_type = "evaluation";
    unverified.events[0]!.metadata.reward = 1;
    expect(toHfExample(unverified).reward).toBeNull();

    const verifier = {
      name: "tests",
      version: "1.2.3",
      artifact_sha256: "a".repeat(64),
      result_sha256: null,
    };
    unverified.events[0]!.metadata.verifier = verifier;
    unverified.events[0]!.metadata.trajpack_review = {
      verifier_confirmation: {
        schema_version: "verifier-confirmation/0.1",
        reviewer: "fixture-reviewer",
        evidence_ref: "verifier-run:fixture",
        confirmed_at: "2026-08-16T00:00:00.000Z",
        event_sha256: reviewEvidenceFingerprint(unverified.events[0]!),
        reward: 1,
        verifier,
      },
    };
    const verified = toHfExample(unverified);
    expect(verified.reward).toBe(1);
    expect(verified.verifier).toEqual({ name: "tests", version: "1.2.3" });
    expect(verified.metadata.verified_label_source_event_id).toBe("evt_fixture");
  });

  it("honors reasoning loss metadata and omits opaque reasoning states", () => {
    const summary = fixtureBundle("visible summary");
    summary.events[0]!.event_type = "reasoning";
    summary.events[0]!.content[0]!.type = "reasoning";
    summary.events[0]!.content[0]!.reasoning = {
      representation: "provider_summary",
      provider_claim: "reasoning_summary",
      source_field: "thinking",
      visibility: "user_visible",
      include_in_loss: false,
    };
    const summaryExample = toHfExample(summary);
    expect(summaryExample.assistant_loss_mask).toEqual([]);
    expect(summaryExample.messages).toEqual([]);

    summary.events[0]!.content[0]!.reasoning.representation = "opaque_reasoning_state";
    summary.events[0]!.content[0]!.reasoning.visibility = "not_returned";
    summary.events[0]!.content[0]!.value = "opaque marker";
    expect(toHfExample(summary).messages).toEqual([]);
  });

  it("refuses to emit HF/TRL through a non-training mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-export-mode-"));
    try {
      await expect(exportApprovedBundle(fixtureBundle(), {
        format: "hf-trl",
        outputDirectory: join(root, "dataset"),
        mode: "archive",
      })).rejects.toThrow("require an explicit training eligibility gate");
      await expect(exportApprovedBundle(fixtureBundle(), {
        format: "atif",
        outputDirectory: join(root, "atif"),
        mode: "archive",
      })).rejects.toThrow("require an explicit training eligibility gate");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes canonical data with checksums", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-export-"));
    const output = join(root, "dataset");
    try {
      await exportApprovedBundle(fixtureBundle(), { format: "canonical", outputDirectory: output });
      expect(await readFile(join(output, "manifest.json"), "utf8")).toContain("trajectory/0.1");
      expect(await readFile(join(output, "checksums.txt"), "utf8")).toContain("events.jsonl");
      expect(await readFile(join(output, "redaction-report.json"), "utf8")).toContain("redaction/0.1");
      expect(await readFile(join(output, "license-summary.json"), "utf8")).toContain("data_license_is_independent");
      const digest = fixtureBundle().events[0]!.content[0]!.sha256;
      expect((await stat(join(output, "blobs", "sha256", digest))).isFile()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not export content-derived provenance hashes after redaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-export-redacted-provenance-"));
    const output = join(root, "dataset");
    const bundle = fixtureBundle("[REDACTED:api_key]");
    const event = bundle.events[0]!;
    event.content[0]!.redaction_status = "redacted";
    event.event_id = `self_hosted:${"2".repeat(64)}:message:0`;
    event.source_event_id = "2".repeat(64);
    event.metadata.raw_payload_sha256 = "2".repeat(64);
    bundle.manifest.lineage.raw_sha256 = "3".repeat(64);
    reapprove(bundle);
    try {
      await exportApprovedBundle(bundle, { format: "canonical", outputDirectory: output });
      const plaintext = `${await readFile(join(output, "manifest.json"), "utf8")}\n${await readFile(join(output, "events.jsonl"), "utf8")}`;
      expect(plaintext).not.toContain("2".repeat(64));
      expect(plaintext).not.toContain("3".repeat(64));
      expect(plaintext).toContain("redacted:");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never emits excluded review content in canonical plaintext", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-export-selection-"));
    const output = join(root, "dataset");
    const bundle = fixtureBundle("included sentinel");
    const excluded = structuredClone(bundle.events[0]!);
    excluded.event_id = "evt_excluded";
    excluded.span_id = "fedcba9876543210";
    excluded.sequence = 1;
    excluded.review_disposition = "exclude";
    excluded.content[0]!.value = "must never escape sentinel";
    bundle.events.push(excluded);
    reapprove(bundle);
    try {
      await exportApprovedBundle(bundle, { format: "canonical", outputDirectory: output });
      const events = await readFile(join(output, "events.jsonl"), "utf8");
      expect(events).toContain("included sentinel");
      expect(events).not.toContain("must never escape sentinel");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes opaque reasoning parts from canonical training views", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-export-opaque-"));
    const output = join(root, "dataset");
    const bundle = fixtureBundle("opaque state sentinel");
    bundle.events[0]!.event_type = "reasoning";
    bundle.events[0]!.content[0]!.type = "reasoning";
    bundle.events[0]!.content[0]!.reasoning = {
      representation: "opaque_reasoning_state",
      provider_claim: "none",
      source_field: null,
      visibility: "not_returned",
      include_in_loss: false,
    };
    reapprove(bundle);
    try {
      await exportApprovedBundle(bundle, {
        format: "canonical",
        outputDirectory: output,
        mode: "training_competitive_distillation",
      });
      expect(await readFile(join(output, "events.jsonl"), "utf8")).not.toContain("opaque state sentinel");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves canonical-only patch and verifier fields in every lossy-format sidecar", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-export-sidecar-"));
    const bundle = fixtureBundle("diff --git a/a.ts b/a.ts");
    bundle.events[0]!.event_type = "artifact.patch";
    bundle.events[0]!.content[0]!.type = "patch";
    bundle.events[0]!.metadata.verifier = { name: "repo-tests", version: "2.0.0" };
    bundle.events[0]!.metadata.reward = 1;
    reapprove(bundle);
    try {
      for (const format of ["atif", "hf-trl", "otlp"] as const) {
        const output = join(root, format);
        await exportApprovedBundle(bundle, {
          format,
          outputDirectory: output,
          mode: "training_competitive_distillation",
        });
        const sidecar = await readFile(join(output, "provenance.json"), "utf8");
        expect(sidecar, format).toContain("artifact.patch");
        expect(sidecar, format).toContain("repo-tests");
        expect(sidecar, format).toContain("diff --git");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("attests the approved source and validates each derived canonical view", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-export-attestation-"));
    const output = join(root, "dataset");
    try {
      await exportApprovedBundle(fixtureBundle(), { format: "canonical", outputDirectory: output });
      const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
      const events = (await readFile(join(output, "events.jsonl"), "utf8"))
        .split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
      const exported = { manifest, events, raw: [] };
      expect(manifest.review.approval_scope.export_pass_version).toBe("export-view/0.1");
      expect(manifest.review.approval_scope.approved_source_bundle_sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(validateApprovalScope(exported, "archive")).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
