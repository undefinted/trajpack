import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runTermsSnapshot } from "./commands.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("terms snapshot command", () => {
  it("rejects locale-dependent and calendar-invalid timestamps", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-terms-invalid-"));
    temporaryDirectories.push(root);
    const input = join(root, "terms.txt");
    await writeFile(input, "fixture terms");

    for (const effectiveAt of ["08/22/2026", "2026-02-30T00:00:00Z"]) {
      await expect(runTermsSnapshot({
        name: "fixture",
        url: "https://example.test/terms",
        effectiveAt,
        reviewAfter: "2099-01-01T00:00:00Z",
        input,
        output: join(root, `snapshot-${effectiveAt.length}.json`),
      })).rejects.toThrow("ISO-8601 UTC timestamp");
    }
  });

  it("normalizes an explicit UTC instant into the signed snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "trajpack-terms-valid-"));
    temporaryDirectories.push(root);
    const input = join(root, "terms.txt");
    const output = join(root, "snapshot.json");
    await writeFile(input, "fixture terms");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runTermsSnapshot({
      name: "fixture",
      url: "https://example.test/terms",
      effectiveAt: "2026-08-01T00:00:00Z",
      reviewAfter: "2099-01-01T00:00:00.123Z",
      input,
      output,
    });

    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({
      effective_at: "2026-08-01T00:00:00.000Z",
      review_after: "2099-01-01T00:00:00.123Z",
    });
  });
});
