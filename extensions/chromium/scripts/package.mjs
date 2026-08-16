import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const extensionRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(extensionRoot, "..", "..");
const target = resolve(extensionRoot, "build");
if (dirname(target) !== extensionRoot || target === extensionRoot) {
  throw new Error("Refusing to package outside the Chromium extension directory");
}

await rm(target, { recursive: true, force: true });
await mkdir(join(target, "dist"), { recursive: true });
for (const name of ["manifest.json", "popup.html", "popup.css", "selector-recipe.schema.json", "README.md"]) {
  await cp(join(extensionRoot, name), join(target, name));
}
for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  await cp(join(workspaceRoot, name), join(target, name));
}
for (const entry of await readdir(join(extensionRoot, "dist"), { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".js") || entry.name.includes(".test.")) continue;
  await cp(join(extensionRoot, "dist", entry.name), join(target, "dist", entry.name));
}

process.stdout.write(`Packaged unpacked extension at ${target}\n`);
