import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, parse, relative, resolve } from "node:path";

export const MAX_EVIDENCE_ARTIFACT_BYTES = 64 * 1024 * 1024;

export type EvidenceArtifactReference = `${string}:sha256:${string}`;

const EVIDENCE_KIND_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const MAX_EVIDENCE_KIND_LENGTH = 64;

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function pathWithin(base: string, target: string): boolean {
  const child = relative(base, target);
  return child === "" || (!isAbsolute(child) && child !== ".."
    && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

async function expectedCanonicalPath(path: string): Promise<string> {
  // `/tmp` and `/var` are macOS platform symlinks that sit below the root and
  // are not covered by `tmpdir()` (/var/folders/...), so treat them as trusted
  // roots to avoid falsely rejecting evidence files under the system temp dir.
  const systemAliasRoots = process.platform === "win32" ? [] : [resolve("/tmp"), resolve("/var")];
  const candidates = [resolve(process.cwd()), resolve(tmpdir()), ...systemAliasRoots, parse(path).root]
    .filter((candidate, index, values) => values.indexOf(candidate) === index)
    .filter((candidate) => pathWithin(candidate, path))
    .sort((left, right) => right.length - left.length);
  const trustedBase = candidates[0] ?? parse(path).root;
  return resolve(join(await realpath(trustedBase), relative(trustedBase, path)));
}

function sameFile(
  left: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
  right: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

export function validateEvidenceKind(kind: string): string {
  if (kind.length > MAX_EVIDENCE_KIND_LENGTH || !EVIDENCE_KIND_PATTERN.test(kind)) {
    throw new Error(
      "Evidence kind must be a lowercase token of at most 64 characters; separators '.', '_' and '-' must occur between alphanumeric segments",
    );
  }
  return kind;
}

/**
 * Hash a bounded, regular local file and return a content-bound reference.
 *
 * The path must not traverse a symlink. The file is checked before opening,
 * immediately after opening, and again after streaming so replacement or
 * mutation races fail closed instead of binding a different artifact.
 */
export async function createEvidenceArtifactReference(
  kind: string,
  inputPath: string,
): Promise<EvidenceArtifactReference> {
  const canonicalKind = validateEvidenceKind(kind);
  const path = resolve(inputPath);
  const before = await lstat(path);
  if (before.isSymbolicLink()) throw new Error("Evidence artifact cannot be a symbolic link");
  if (!before.isFile()) throw new Error("Evidence artifact must be a regular file");
  if (before.size > MAX_EVIDENCE_ARTIFACT_BYTES) {
    throw new Error(`Evidence artifact exceeds ${MAX_EVIDENCE_ARTIFACT_BYTES} bytes`);
  }

  // Reject symlinks/junctions in parent components as well as a symlink at the
  // final component. O_NOFOLLOW below additionally closes the final-component
  // replacement race on platforms that expose it.
  const [canonicalPath, expectedPath] = await Promise.all([
    realpath(path),
    expectedCanonicalPath(path),
  ]);
  if (!samePath(canonicalPath, expectedPath)) {
    throw new Error("Evidence artifact path cannot traverse a symbolic link or junction");
  }

  const noFollow = process.platform === "win32"
    ? 0
    : (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened)) {
      throw new Error("Evidence artifact changed while opening");
    }
    if (opened.size > MAX_EVIDENCE_ARTIFACT_BYTES) {
      throw new Error(`Evidence artifact exceeds ${MAX_EVIDENCE_ARTIFACT_BYTES} bytes`);
    }

    const digest = createHash("sha256");
    let bytesRead = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const buffer = chunk as Buffer;
      bytesRead += buffer.byteLength;
      if (bytesRead > MAX_EVIDENCE_ARTIFACT_BYTES) {
        throw new Error(`Evidence artifact exceeds ${MAX_EVIDENCE_ARTIFACT_BYTES} bytes`);
      }
      digest.update(buffer);
    }

    const after = await handle.stat();
    const pathAfter = await lstat(path);
    const [canonicalPathAfter, expectedPathAfter] = await Promise.all([
      realpath(path),
      expectedCanonicalPath(path),
    ]);
    if (bytesRead !== opened.size
      || !sameFile(opened, after)
      || !sameFile(opened, pathAfter)
      || !samePath(canonicalPathAfter, expectedPathAfter)) {
      throw new Error("Evidence artifact changed while hashing");
    }

    return `${canonicalKind}:sha256:${digest.digest("hex")}`;
  } finally {
    await handle.close();
  }
}
