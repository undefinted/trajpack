#!/usr/bin/env node
// Bind the synthetic fixture to trajpack's actual Zod DatasetExample schema.
import { readFile } from "node:fs/promises";
import { datasetExampleSchema } from "../../packages/schema/dist/index.js";

const files = process.argv.slice(2);
if (files.length === 0) {
  throw new Error("usage: node validate_with_trajpack.mjs <dataset.jsonl> [...]");
}

const counts = {};
for (const file of files) {
  const text = await readFile(file, "utf8");
  let count = 0;
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      datasetExampleSchema.parse(JSON.parse(line));
    } catch (error) {
      throw new Error(`${file}:${index + 1}: incompatible DatasetExample`, { cause: error });
    }
    count += 1;
  }
  if (count === 0) throw new Error(`${file}: no records`);
  counts[file] = count;
}

process.stdout.write(`${JSON.stringify({ schema: "@trajpack/schema DatasetExample", valid: true, counts })}\n`);
