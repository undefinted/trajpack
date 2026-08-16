import { copyFile, lstat, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const packageRoot = resolve(process.cwd());
const requested = process.argv[2] ?? "dist";
const target = resolve(packageRoot, requested);
const withNotices = process.argv.slice(3).includes("--with-notices");

if (requested !== "dist" || basename(target) !== "dist" || dirname(target) !== packageRoot || target === packageRoot) {
  throw new Error(`Refusing to clean an unsafe build target: ${target}`);
}

try {
  const details = await lstat(target);
  if (details.isSymbolicLink()) throw new Error(`Refusing to clean a symlinked build target: ${target}`);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });

if (withNotices) {
  await mkdir(target, { recursive: true });
  await copyFile(join(repositoryRoot, "THIRD_PARTY_NOTICES.md"), join(target, "THIRD_PARTY_NOTICES.md"));
}
