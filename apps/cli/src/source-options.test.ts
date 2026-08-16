import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    evidence_ref: "contract:scope-17",
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

describe("source permission evidence", () => {
  it("parses a scoped permission JSON object", async () => {
    const path = await evidenceFile();
    const resolved = await resolveSourceOptions("codex", {
      provider: "openai",
      accountType: "business",
      permissionEvidence: path,
    });
    expect(resolved.permissionEvidence?.evidence_ref).toBe("contract:scope-17");
  });

  it("rejects a conflicting bare reference and invalid validity window", async () => {
    const path = await evidenceFile();
    await expect(resolveSourceOptions("codex", {
      permissionEvidence: path,
      writtenPermission: "contract:other",
    })).rejects.toThrow("must match permission evidence_ref");

    const invalid = await evidenceFile({ expires_at: "2026-07-01T00:00:00.000Z" });
    await expect(resolveSourceOptions("codex", { permissionEvidence: invalid })).rejects.toThrow();
  });
});
