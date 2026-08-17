#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

const MAX_TRANSCRIPT_BYTES = 512 * 1024;
const MAX_LINES = 600;

function parseArgs(argv) {
  const options = { transcript: null, output: null, title: "trajpack DeepSeek research demo" };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--transcript") options.transcript = argv[++index] ?? null;
    else if (name === "--output") options.output = argv[++index] ?? null;
    else if (name === "--title") options.title = argv[++index] ?? options.title;
    else throw new Error(`Unknown argument: ${name}`);
  }
  if (!options.transcript || !options.output) {
    throw new Error("Usage: node scripts/render-demo-video.mjs --transcript <safe-log.txt> --output <demo.mp4> [--title <title>]");
  }
  return options;
}

function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

const options = parseArgs(process.argv.slice(2));
const transcriptPath = resolve(options.transcript);
const outputPath = resolve(options.output);
await mkdir(dirname(outputPath), { recursive: true });
const transcript = await readFile(transcriptPath, "utf8");
if (Buffer.byteLength(transcript, "utf8") > MAX_TRANSCRIPT_BYTES) {
  throw new Error(`Demo transcript exceeds ${MAX_TRANSCRIPT_BYTES} bytes`);
}
function replayLines(value) {
  let replay;
  try {
    replay = JSON.parse(value);
  } catch {
    return value.replaceAll("\r\n", "\n").split("\n");
  }
  if (replay?.schema_version !== "trajpack-demo-replay/0.1" || !Array.isArray(replay.frames)) {
    throw new Error("JSON demo transcript is not a supported trajpack replay");
  }
  if (replay.actual_run !== true || replay.result !== "passed") {
    throw new Error("Refusing to render a replay that is not an actual successful run");
  }
  if (replay.sensitive_content_emitted !== false
    || replay.local_paths_emitted !== false
    || replay.secrets_or_credentials_emitted !== false
    || replay.hidden_chain_of_thought_emitted !== false) {
    throw new Error("Refusing to render a replay that is not explicitly marked content-safe");
  }
  const messages = replay.frames.map((frame, index) => {
    if (frame?.frame !== index + 1 || typeof frame?.message !== "string") {
      throw new Error("Demo replay frames must be ordered, contiguous, and textual");
    }
    return frame.message;
  });
  return [
    `$ ${replay.reproducible_command}`,
    `source: ${replay.source_kind}`,
    ...messages,
    `artifact manifest sha256: ${replay.artifact_manifest_sha256}`,
    "EVIDENCE SCOPE: pipeline replay only; no downstream training-effect claim.",
  ];
}

const lines = replayLines(transcript).slice(0, MAX_LINES);
if (lines.length === 0 || lines.every((line) => line.trim() === "")) throw new Error("Demo transcript is empty");

// Resolve Playwright from the existing Chromium extension workspace rather
// than adding a second browser dependency to the release package.
const requireFromExtension = createRequire(new URL("../extensions/chromium/package.json", import.meta.url));
const { chromium } = requireFromExtension("@playwright/test");
const videoDirectory = await mkdtemp(join(tmpdir(), "trajpack-demo-video-"));
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: videoDirectory, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();
  await page.setContent(`<!doctype html>
<meta charset="utf-8">
<style>
  html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #07111f; }
  body { color: #d8e7ff; font: 20px/1.42 Consolas, "Cascadia Mono", monospace; }
  .bar { height: 54px; display: flex; align-items: center; padding: 0 26px; background: #0d1b2d; border-bottom: 1px solid #28415f; }
  .dot { width: 13px; height: 13px; border-radius: 50%; margin-right: 9px; }
  .title { margin-left: 18px; color: #8fb7e8; font: 600 17px/1.2 system-ui, sans-serif; }
  pre { box-sizing: border-box; height: 666px; margin: 0; padding: 24px 30px 50px; white-space: pre-wrap; overflow: hidden; }
  .prompt { color: #7fe7c4; } .ok { color: #8bd3ff; } .warn { color: #ffd580; }
  .footer { position: fixed; right: 22px; bottom: 14px; color: #6683a5; font: 14px system-ui, sans-serif; }
</style>
<div class="bar"><span class="dot" style="background:#ff6b6b"></span><span class="dot" style="background:#ffd166"></span><span class="dot" style="background:#58d68d"></span><span class="title">${escapeHtml(options.title)}</span></div>
<pre id="terminal"></pre><div class="footer">replay of an actual local run · no provider secrets</div>`);
  for (const [index, line] of lines.entries()) {
    await page.evaluate(({ line: nextLine }) => {
      const terminal = document.querySelector("#terminal");
      const span = document.createElement("span");
      span.textContent = `${nextLine}\n`;
      if (nextLine.startsWith("$ ") || nextLine.startsWith("> ")) span.className = "prompt";
      else if (/\b(PASS|passed|validated|complete|ok)\b/iu.test(nextLine)) span.className = "ok";
      else if (/\b(warn|fail closed|blocked)\b/iu.test(nextLine)) span.className = "warn";
      terminal.append(span);
      while (terminal.scrollHeight > terminal.clientHeight && terminal.firstChild) terminal.firstChild.remove();
    }, { line });
    await page.waitForTimeout(index < 4 ? 500 : Math.min(420, 80 + line.length * 5));
  }
  await page.waitForTimeout(1800);
  await context.close();
  await browser.close();
  browser = undefined;

  const recordings = (await readdir(videoDirectory)).filter((name) => name.endsWith(".webm"));
  if (recordings.length !== 1) throw new Error(`Expected one Playwright recording, found ${recordings.length}`);
  await run("ffmpeg", [
    "-y", "-i", join(videoDirectory, recordings[0]),
    "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", outputPath,
  ]);
  process.stdout.write(`Rendered ${basename(outputPath)} from ${lines.length} safe transcript lines.\n`);
} finally {
  if (browser) await browser.close().catch(() => undefined);
  await rm(videoDirectory, { recursive: true, force: true });
}
