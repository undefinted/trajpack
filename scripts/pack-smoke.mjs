import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const scratch = await mkdtemp(join(tmpdir(), "trajpack-release-smoke-"));
const scratchBoundary = `${resolve(tmpdir())}${sep}`;

if (!resolve(scratch).startsWith(scratchBoundary)) {
  throw new Error(`Refusing to use an unexpected smoke-test directory: ${scratch}`);
}

function run(command, args, cwd) {
  const useCommandProcessor = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
  const executable = useCommandProcessor ? (process.env.ComSpec ?? "cmd.exe") : command;
  const executableArgs = useCommandProcessor ? ["/d", "/s", "/c", command, ...args] : args;
  return execFileSync(executable, executableArgs, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function filesBelow(directory, prefix = "") {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) output.push(...await filesBelow(path, name));
    else if (entry.isFile()) output.push(name);
  }
  return output.sort();
}

const packages = [
  ["@trajpack/schema", "packages/schema", "schema"],
  ["@trajpack/core", "packages/core", "core"],
  ["@trajpack/adapters", "packages/adapters", "adapters"],
  ["@trajpack/importers", "packages/importers", "importers"],
  ["@trajpack/deepseek-harness-plugin", "plugins/deepseek-harness", "deepseek-harness-plugin"],
  ["@trajpack/cli", "apps/cli", "cli"],
];

try {
  const packDirectory = join(scratch, "pack");
  const installDirectory = join(scratch, "install");
  const dependencies = {};
  const overrides = {};

  for (const [name, directory, shortName] of packages) {
    const tarball = join(packDirectory, `trajpack-${shortName}-0.1.0.tgz`);
    run(pnpm, ["pack", "--out", tarball], join(root, directory));
    assert.ok((await stat(tarball)).size > 0, `${name} pack did not produce a tarball`);
    dependencies[name] = `file:../pack/${basename(tarball)}`;
    overrides[name] = dependencies[name];
  }

  await mkdir(installDirectory, { recursive: true });
  await writeFile(join(installDirectory, "package.json"), JSON.stringify({
    name: "trajpack-release-smoke",
    private: true,
    version: "0.0.0",
    type: "module",
    packageManager: "pnpm@11.19.0",
    dependencies,
  }, null, 2));
  await writeFile(join(installDirectory, "pnpm-workspace.yaml"), [
    "packages:",
    '  - "."',
    "overrides:",
    ...Object.entries(overrides).map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`),
    "",
  ].join("\n"));
  run(pnpm, ["install", "--prefer-offline", "--ignore-scripts", "--no-frozen-lockfile"], installDirectory);

  for (const [name] of packages) {
    const packageRoot = join(installDirectory, "node_modules", ...name.split("/"));
    const packageFiles = await filesBelow(packageRoot);
    assert.equal(
      packageFiles.some((path) => path.includes(".test.") || path.includes(".spec.") || path.endsWith(".map")),
      false,
      `${name} tarball contains test or sourcemap files`,
    );
    assert.ok(
      packageFiles.some((path) => path.endsWith("THIRD_PARTY_NOTICES.md")),
      `${name} tarball is missing THIRD_PARTY_NOTICES.md`,
    );
    assert.ok(packageFiles.includes("LICENSE"), `${name} tarball is missing the Apache-2.0 LICENSE`);
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    assert.equal(manifest.engines?.node, ">=24", `${name} must require Node >=24`);
  }

  const cliRoot = join(installDirectory, "node_modules", "@trajpack", "cli");
  const installedFiles = await filesBelow(cliRoot);
  for (const required of [
    "dist/index.js",
    "dist/THIRD_PARTY_NOTICES.md",
    "reviewer/index.html",
    "reviewer/THIRD_PARTY_NOTICES.md",
  ]) {
    assert.ok(installedFiles.includes(required), `@trajpack/cli tarball is missing ${required}`);
  }
  assert.ok(installedFiles.some((path) => /^reviewer\/assets\/.*\.js$/.test(path)), "reviewer JavaScript asset is missing");
  assert.ok(installedFiles.some((path) => /^reviewer\/assets\/.*\.css$/.test(path)), "reviewer CSS asset is missing");
  assert.equal(
    installedFiles.some((path) => path.includes(".test.") || path.includes(".spec.") || path.endsWith(".map")),
    false,
    "CLI tarball contains tests or sourcemaps",
  );

  const cliEntry = join(cliRoot, "dist", "index.js");
  const installedBin = join(installDirectory, "node_modules", ".bin", process.platform === "win32" ? "trajpack.CMD" : "trajpack");
  assert.ok((await stat(installedBin)).isFile(), "installed trajpack binary shim is missing");
  const help = run(installedBin, ["--help"], installDirectory);
  assert.match(help, /Usage: trajpack/);
  for (const command of ["capture", "arm", "import", "review", "doctor", "validate", "export", "delete"]) {
    assert.match(help, new RegExp(`\\b${command}\\b`), `CLI help omits ${command}`);
  }

  const doctor = JSON.parse(run(installedBin, ["doctor", "--json"], installDirectory));
  assert.equal(doctor.report_version, "doctor/0.2", "installed CLI doctor report version drifted");
  const gemini = doctor.native_agents.find((host) => host.id === "gemini");
  assert.equal(gemini?.plugin_directory, "plugins/trajpack-gemini", "installed CLI doctor omits the Gemini extension path");
  assert.deepEqual(gemini?.expected_interfaces, ["gemini-cli-hook/1"]);

  const reviewModule = await import(pathToFileURL(join(cliRoot, "dist", "review-server.js")).href);
  const reviewerDist = await realpath(reviewModule.defaultReviewerDist());
  assert.equal(reviewerDist, await realpath(join(cliRoot, "reviewer")), "review server did not resolve package-local assets");

  const running = await reviewModule.startReviewServer({ passphrase: "release-smoke-passphrase" });
  try {
    const response = await fetch(running.launchUrl);
    assert.equal(response.status, 200, "installed reviewer root did not load");
    const html = await response.text();
    assert.match(html, /<div id="root"><\/div>/, "installed reviewer served the fallback page");
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
    assert.ok(assets.length >= 2, "installed reviewer index has no production assets");
    for (const asset of assets) {
      const assetResponse = await fetch(new URL(asset, running.url));
      assert.equal(assetResponse.status, 200, `installed reviewer asset is not served: ${asset}`);
      assert.ok((await assetResponse.arrayBuffer()).byteLength > 0, `installed reviewer asset is empty: ${asset}`);
    }
  } finally {
    await running.close();
  }

  const extensionSource = JSON.parse(await readFile(join(root, "extensions/chromium/manifest.json"), "utf8"));
  const extensionBuildRoot = join(root, "extensions/chromium/build");
  const extensionBuild = JSON.parse(await readFile(join(extensionBuildRoot, "manifest.json"), "utf8"));
  assert.equal(extensionBuild.manifest_version, 3);
  assert.equal(extensionBuild.version, extensionSource.version);
  assert.deepEqual(extensionBuild.permissions, extensionSource.permissions);
  const extensionFiles = await filesBelow(extensionBuildRoot);
  for (const required of [
    "manifest.json",
    "popup.html",
    "popup.css",
    "selector-recipe.schema.json",
    "dist/popup.js",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
  ]) {
    assert.ok(extensionFiles.includes(required), `Chromium release artifact is missing ${required}`);
  }
  assert.equal(extensionFiles.some((path) => path.endsWith(".map") || path.includes(".test.")), false, "Chromium release artifact contains development files");

  // Gemini CLI extensions are linked from the source checkout in v0.1. Keep
  // their documented root manifest, hook catalog, and silent forwarder in the
  // same release smoke gate as the packaged browser extension.
  const geminiRoot = join(root, "plugins/trajpack-gemini");
  const geminiManifest = JSON.parse(await readFile(join(geminiRoot, "gemini-extension.json"), "utf8"));
  const geminiHooks = JSON.parse(await readFile(join(geminiRoot, "hooks/hooks.json"), "utf8"));
  assert.deepEqual(
    { name: geminiManifest.name, version: geminiManifest.version },
    { name: "trajpack-gemini", version: "0.1.0" },
  );
  assert.deepEqual(Object.keys(geminiHooks.hooks).sort(), [
    "AfterAgent", "AfterModel", "AfterTool", "BeforeAgent", "BeforeModel", "BeforeTool",
    "BeforeToolSelection", "Notification", "PreCompress", "SessionEnd", "SessionStart",
  ]);
  for (const required of ["README.md", "gemini-extension.json", "hooks/hooks.json", "scripts/forward-hook.mjs"]) {
    assert.ok((await stat(join(geminiRoot, ...required.split("/")))).isFile(), `Gemini CLI extension is missing ${required}`);
  }

  process.stdout.write(`Release pack smoke passed: ${installedFiles.length} CLI files, ${extensionFiles.length} Chromium files, Gemini CLI extension validated.\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
