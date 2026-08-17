import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEvidenceArtifactReference,
  MAX_EVIDENCE_ARTIFACT_BYTES,
  validateEvidenceKind,
} from "./evidence-artifact.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "trajpack-evidence-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("evidence artifact binding", () => {
  it("returns a deterministic kind-bound streaming SHA-256 reference", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "authorization.pdf");
    const content = Buffer.from("signed research authorization\n", "utf8");
    await writeFile(path, content);

    const reference = await createEvidenceArtifactReference("teacher-receipt.v1", path);
    expect(reference).toBe(`teacher-receipt.v1:sha256:${createHash("sha256").update(content).digest("hex")}`);
    expect(await createEvidenceArtifactReference("teacher-receipt.v1", path)).toBe(reference);
  });

  it.each([
    "",
    "Teacher",
    "teacher receipt",
    "teacher:receipt",
    "teacher/receipt",
    ".teacher",
    "teacher-",
    "teacher--receipt",
    "a".repeat(65),
  ])("rejects unsafe or non-canonical evidence kind %j", (kind) => {
    expect(() => validateEvidenceKind(kind)).toThrow("lowercase token");
  });

  it("rejects non-files and files over the 64 MiB bound before hashing", async () => {
    const directory = await temporaryDirectory();
    await expect(createEvidenceArtifactReference("review", directory)).rejects.toThrow("regular file");

    const path = join(directory, "oversized.bin");
    await writeFile(path, "");
    await truncate(path, MAX_EVIDENCE_ARTIFACT_BYTES + 1);
    await expect(createEvidenceArtifactReference("review", path)).rejects.toThrow("exceeds");
  });

  it.skipIf(process.platform === "win32")("rejects a symbolic-link evidence path", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "target.txt");
    const link = join(directory, "link.txt");
    await writeFile(target, "authorization");
    await symlink(target, link, "file");
    await expect(createEvidenceArtifactReference("review", link)).rejects.toThrow("symbolic link");
  });

  it.skipIf(process.platform !== "win32")("rejects a Windows junction in the evidence path", async () => {
    const directory = await temporaryDirectory();
    const targetDirectory = join(directory, "target");
    const junction = join(directory, "junction");
    await mkdir(targetDirectory);
    await writeFile(join(targetDirectory, "authorization.txt"), "authorization");
    await symlink(targetDirectory, junction, "junction");
    await expect(createEvidenceArtifactReference(
      "review",
      join(junction, "authorization.txt"),
    )).rejects.toThrow("symbolic link or junction");
  });
});
