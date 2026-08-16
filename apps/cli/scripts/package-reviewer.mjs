import { cp, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const source = resolve(packageRoot, "../reviewer/dist");
const target = resolve(packageRoot, "reviewer");

if (dirname(target) !== packageRoot || target === packageRoot) {
  throw new Error("Refusing to package reviewer assets outside @trajpack/cli");
}

const indexPath = resolve(source, "index.html");
if (!(await stat(indexPath)).isFile()) {
  throw new Error("Reviewer build is missing; build @trajpack/reviewer before @trajpack/cli");
}
const index = await readFile(indexPath, "utf8");
if (!index.includes('<div id="root"></div>') || !index.includes("/assets/")) {
  throw new Error("Reviewer build does not contain the expected production entry point");
}

await cp(source, target, { recursive: true, force: true });
process.stdout.write(`Packaged reviewer assets at ${target}\n`);
