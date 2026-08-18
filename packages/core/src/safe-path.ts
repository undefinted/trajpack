import { lstat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, parse, relative, resolve } from "node:path";

function comparable(path: string): string {
  const value = normalize(path);
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isWithin(base: string, target: string): boolean {
  const child = relative(base, target);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

/**
 * Resolve an output parent without silently following a caller-controlled
 * symlink/junction. The process cwd and OS temp directory are trusted roots so
 * platform aliases such as macOS `/var` -> `/private/var` do not make every
 * temporary export fail; links introduced below those roots are still denied.
 *
 * Returns the canonical (realpath) parent so callers build paths from a
 * symlink-free absolute directory. Returning the lexical path would leave a
 * validate-then-use window in which a concurrent rename could swap the parent
 * for a symlink after this function returned.
 */
export async function assertSafeOutputParent(input: string): Promise<string> {
  const parent = resolve(input);
  const metadata = await lstat(parent);
  if (metadata.isSymbolicLink()) {
    throw new Error(`Output parent contains a symbolic-link or junction ancestor: ${parent}`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`Output parent must be an existing real directory: ${parent}`);
  }

  // `/tmp` and `/var` are macOS platform symlinks (/tmp -> /private/tmp,
  // /var -> /private/var) that sit below the filesystem root, so they are not
  // reachable through `tmpdir()` (which returns /var/folders/... on macOS).
  // Treating them as trusted roots keeps system temp exports working while
  // still rejecting caller-controlled links below them.
  const systemAliasRoots = process.platform === "win32" ? [] : [resolve("/tmp"), resolve("/var")];
  const candidates = [resolve(process.cwd()), resolve(tmpdir()), ...systemAliasRoots, parse(parent).root]
    .filter((candidate, index, values) => values.indexOf(candidate) === index)
    .filter((candidate) => isWithin(candidate, parent))
    .sort((left, right) => right.length - left.length);
  const trustedBase = candidates[0] ?? parse(parent).root;
  const [canonicalBase, canonicalParent] = await Promise.all([
    realpath(trustedBase),
    realpath(parent),
  ]);
  const expected = resolve(join(canonicalBase, relative(trustedBase, parent)));
  if (comparable(expected) !== comparable(canonicalParent)) {
    throw new Error(`Output parent contains a symbolic-link or junction ancestor: ${parent}`);
  }
  return canonicalParent;
}
