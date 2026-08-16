import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const failures = [];

async function text(path) {
  return readFile(resolve(root, path), "utf8");
}

function requireCondition(condition, message) {
  if (!condition) failures.push(message);
}

const manifest = JSON.parse(await text("extensions/chromium/manifest.json"));
requireCondition(JSON.stringify(manifest.permissions) === JSON.stringify(["activeTab", "scripting", "storage"]), "extension permissions changed");
requireCondition(JSON.stringify(manifest.host_permissions) === JSON.stringify(["http://127.0.0.1/*"]), "extension host permissions changed");
requireCondition(manifest.incognito === "not_allowed", "incognito capture must stay disabled");
requireCondition(!("background" in manifest), "extension must not gain a background worker");
requireCondition(!("content_scripts" in manifest), "extension must not gain persistent content scripts");

const extensionSources = await Promise.all([
  "extensions/chromium/src/capture.ts",
  "extensions/chromium/src/popup.ts",
  "extensions/chromium/src/recipe.ts",
].map(text));
const extensionText = extensionSources.join("\n");
for (const forbidden of ["chrome.debugger", "chrome.webRequest", "chrome.cookies", "localStorage", "sessionStorage", "world: \"MAIN\""]) {
  requireCondition(!extensionText.includes(forbidden), `extension contains forbidden capability: ${forbidden}`);
}

const reviewerSources = await Promise.all([
  "apps/reviewer/src/App.tsx",
  "apps/reviewer/src/components/EventInspector.tsx",
  "apps/reviewer/src/components/EventTimeline.tsx",
  "apps/reviewer/src/components/SafeText.tsx",
].map(text));
const reviewerText = reviewerSources.join("\n");
for (const forbidden of ["dangerouslySetInnerHTML", ".innerHTML", "eval(", "new Function("]) {
  requireCondition(!reviewerText.includes(forbidden), `reviewer contains unsafe rendering primitive: ${forbidden}`);
}

for (const hook of ["plugins/trajpack/scripts/forward-hook.mjs", "plugins/claude-code/scripts/forward-hook.mjs"]) {
  const source = await text(hook);
  requireCondition(!source.includes("writeFile") && !source.includes("appendFile"), `${hook} must not write a plaintext spool`);
  requireCondition(source.includes("127.0.0.1"), `${hook} must restrict the collector to IPv4 loopback`);
  requireCondition(source.includes("Number.isFinite(expiresAt)"), `${hook} must reject invalid arm expiry values`);
  requireCondition(source.includes("details.mode & 0o077"), `${hook} must reject broadly readable arm descriptors`);
  requireCondition(source.includes("directoryDetails.uid"), `${hook} must verify runtime-directory ownership`);
}

const packageJson = JSON.parse(await text("package.json"));
requireCondition(packageJson.license === "Apache-2.0", "root code license changed");
await text("LICENSE");

if (failures.length) {
  process.stderr.write(`${failures.map((failure) => `security-audit: ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("security-audit: static permission and rendering checks passed\n");
}
