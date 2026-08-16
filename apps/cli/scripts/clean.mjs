import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const targets = [resolve(packageRoot, "dist"), resolve(packageRoot, "reviewer")];

for (const target of targets) {
  if (dirname(target) !== packageRoot || target === packageRoot) {
    throw new Error(`Refusing to clean outside @trajpack/cli: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
}
