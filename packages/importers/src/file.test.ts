import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importFile } from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("importFile", () => {
  it("provides the CLI-facing result shape with detected format and provenance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "trajpack-import-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "events.jsonl");
    await writeFile(path, '{"event":"one"}\n{"event":"two"}\n', "utf8");

    const result = await importFile(path, { capturedAt: "2026-08-16T00:00:00.000Z" });
    expect(result.detectedFormat).toBe("generic_jsonl");
    expect(result.envelopes).toHaveLength(2);
    expect(result.sourceMetadata).toHaveProperty("provenance");
  });
});
