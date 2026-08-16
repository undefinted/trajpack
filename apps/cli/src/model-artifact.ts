import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { canonicalJson, sha256 } from "@trajpack/core";

const MAX_MODEL_ARTIFACT_FILES = 100_000;

export interface ModelArtifactObservation {
  schema_version: "model-artifact/0.1";
  kind: "file" | "directory";
  digest: `sha256:${string}`;
  file_count: number;
  total_bytes: number;
}

interface FileDigest {
  path: string;
  bytes: number;
  sha256: string;
}

function portableRelativePath(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/").normalize("NFC");
  if (!value || value.startsWith("/") || value.split("/").includes("..")
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Model artifact contains an unsafe relative path");
  }
  return value;
}

async function hashRegularFile(path: string, manifestPath: string): Promise<FileDigest> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Model artifact entry is not a regular non-symlink file: ${manifestPath}`);
  }
  const noFollow = process.platform === "win32" ? 0 : (constants as unknown as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error(`Model artifact changed while opening: ${manifestPath}`);
    }
    const digest = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream("", { fd: handle.fd, autoClose: false })) {
      const buffer = chunk as Buffer;
      bytes += buffer.byteLength;
      digest.update(buffer);
    }
    const after = await handle.stat();
    if (bytes !== opened.size || after.size !== opened.size
      || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error(`Model artifact changed while hashing: ${manifestPath}`);
    }
    return { path: manifestPath, bytes, sha256: digest.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function walkModelArtifact(root: string, current: string, files: FileDigest[]): Promise<void> {
  const directory = await lstat(current);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error(`Model artifact contains a non-directory path: ${portableRelativePath(root, current)}`);
  }
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const path = join(current, entry.name);
    const manifestPath = portableRelativePath(root, path);
    const details = await lstat(path);
    if (details.isSymbolicLink()) throw new Error(`Model artifact contains a symbolic link: ${manifestPath}`);
    if (details.isDirectory()) {
      await walkModelArtifact(root, path, files);
      continue;
    }
    if (!details.isFile()) throw new Error(`Model artifact contains a non-regular entry: ${manifestPath}`);
    if (files.length >= MAX_MODEL_ARTIFACT_FILES) {
      throw new Error(`Model artifact exceeds ${MAX_MODEL_ARTIFACT_FILES} files`);
    }
    files.push(await hashRegularFile(path, manifestPath));
  }
}

export async function observeModelArtifact(input: string): Promise<ModelArtifactObservation> {
  const path = resolve(input);
  const details = await lstat(path);
  if (details.isSymbolicLink()) throw new Error("--model-artifact cannot reference a symbolic link");
  const canonicalPath = await realpath(path);
  const files: FileDigest[] = [];
  const kind = details.isDirectory() ? "directory" : details.isFile() ? "file" : null;
  if (kind === null) throw new Error("--model-artifact must be a regular file or directory");
  if (kind === "file") files.push(await hashRegularFile(canonicalPath, "artifact"));
  else await walkModelArtifact(canonicalPath, canonicalPath, files);
  if (files.length === 0) throw new Error("--model-artifact directory contains no regular files");
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error("Model artifact contains Unicode-normalized path collisions");
  }
  const totalBytes = files.reduce((total, file) => {
    const next = total + file.bytes;
    if (!Number.isSafeInteger(next)) throw new Error("Model artifact size exceeds the safe integer range");
    return next;
  }, 0);
  const manifest = {
    schema_version: "model-artifact/0.1",
    kind,
    // A single file is intentionally name-independent. Directory paths are
    // relative and deterministic so the digest identifies the exact snapshot
    // without recording the user's absolute path.
    files,
  };
  const digest = `sha256:${sha256(canonicalJson(manifest))}` as const;
  return {
    schema_version: "model-artifact/0.1",
    kind,
    digest,
    file_count: files.length,
    total_bytes: totalBytes,
  };
}
