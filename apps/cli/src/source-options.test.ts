import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSourceOptions } from "./source-options.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function evidenceFile(overrides: Record<string, unknown> = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "trajpack-permission-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "permission.json");
  await writeFile(path, JSON.stringify({
    provider: "openai",
    account_type: "business",
    capture_methods: ["official_stream"],
    origins: [],
    permitted_purposes: ["automatic_capture"],
    target_model_owner: null,
    target_product: null,
    reviewer: "contracts-team",
    effective_at: "2026-08-01T00:00:00.000Z",
    expires_at: "2027-08-01T00:00:00.000Z",
    ...overrides,
  }), { encoding: "utf8", mode: 0o600 });
  return path;
}

async function permissionDocument(contents = "fixture written permission\n"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "trajpack-permission-document-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "order-form.txt");
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
  return path;
}

describe("source permission evidence", () => {
  it("parses a scoped permission JSON object", async () => {
    const path = await evidenceFile();
    const resolved = await resolveSourceOptions("codex", {
      provider: "openai",
      accountType: "business",
      permissionEvidence: path,
      permissionDocument: await permissionDocument(),
      permissionEvidenceKind: "contract",
    });
    expect(resolved.permissionEvidence?.evidence_ref).toMatch(/^contract:sha256:[a-f0-9]{64}$/u);
  });

  it("rejects a conflicting bare reference and invalid validity window", async () => {
    const path = await evidenceFile();
    await expect(resolveSourceOptions("codex", {
      permissionEvidence: path,
      writtenPermission: "contract:other",
      permissionDocument: await permissionDocument(),
    })).rejects.toThrow("must match permission evidence_ref");

    const invalid = await evidenceFile({ expires_at: "2026-07-01T00:00:00.000Z" });
    await expect(resolveSourceOptions("codex", {
      permissionEvidence: invalid,
      permissionDocument: await permissionDocument(),
    })).rejects.toThrow();
  });

  it("requires and binds the retained permission document bytes", async () => {
    const path = await evidenceFile();
    await expect(resolveSourceOptions("codex", { permissionEvidence: path }))
      .rejects.toThrow("requires --permission-document");

    const document = await permissionDocument("contract version one\n");
    const first = await resolveSourceOptions("codex", {
      permissionEvidence: path,
      permissionDocument: document,
    });
    await writeFile(document, "contract version two\n", { encoding: "utf8", mode: 0o600 });
    const second = await resolveSourceOptions("codex", {
      permissionEvidence: path,
      permissionDocument: document,
    });
    expect(second.permissionEvidence?.evidence_ref).not.toBe(first.permissionEvidence?.evidence_ref);
  });
});

describe("self-hosted model provenance", () => {
  it("derives the model digest and evidence reference from local artifact bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trajpack-model-artifact-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "weights"));
    await writeFile(join(directory, "config.json"), "{\"model\":\"fixture\"}\n");
    await writeFile(join(directory, "weights", "part-1.safetensors"), "weight-bytes-a");
    const first = await resolveSourceOptions("deepseek_harness", {
      provider: "self_hosted",
      accountType: "self_hosted",
      model: "fixture-model-v1",
      modelArtifact: directory,
    });
    expect(first.source.model_snapshot_or_weights_digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.source.authenticity_evidence_ref)
      .toBe(`local-model-artifact:${first.source.model_snapshot_or_weights_digest}`);

    await writeFile(join(directory, "weights", "part-1.safetensors"), "weight-bytes-b");
    const changed = await resolveSourceOptions("deepseek_harness", {
      provider: "self_hosted",
      accountType: "self_hosted",
      model: "fixture-model-v1",
      modelArtifact: directory,
    });
    expect(changed.source.model_snapshot_or_weights_digest)
      .not.toBe(first.source.model_snapshot_or_weights_digest);
  });

  it("rejects claimed digests and source classes that conflict with local observation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trajpack-model-artifact-conflict-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "weights.bin"), "fixture");
    await expect(resolveSourceOptions("deepseek_harness", {
      provider: "self_hosted",
      accountType: "self_hosted",
      model: "fixture-model-v1",
      modelArtifact: directory,
      modelDigest: `sha256:${"0".repeat(64)}`,
    })).rejects.toThrow("does not match");
    await expect(resolveSourceOptions("codex", {
      provider: "self_hosted",
      accountType: "self_hosted",
      model: "fixture-model-v1",
      modelArtifact: directory,
    })).rejects.toThrow("requires DeepSeek Harness");
  });
});
