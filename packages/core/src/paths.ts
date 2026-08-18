import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

export interface TrajpackPaths {
  data: string;
  vault: string;
  runtime: string;
  tombstones: string;
}

export function defaultPaths(environment: NodeJS.ProcessEnv = process.env): TrajpackPaths {
  const system = platform();
  // An empty-string env var must be treated as unset; otherwise
  // `join("", "trajpack")` yields a *relative* root that silently relocates
  // the encrypted store to the process cwd.
  const value = (name: string): string | undefined => {
    const raw = environment[name];
    return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
  };
  const localAppData = value("LOCALAPPDATA");
  const xdgDataHome = value("XDG_DATA_HOME");
  const xdgRuntimeDir = value("XDG_RUNTIME_DIR");
  const root = system === "win32"
    ? join(localAppData ?? join(homedir(), "AppData", "Local"), "trajpack")
    : system === "darwin"
      ? join(homedir(), "Library", "Application Support", "trajpack")
      : join(xdgDataHome ?? join(homedir(), ".local", "share"), "trajpack");
  const runtimeRoot = system === "win32"
    ? join(localAppData ?? tmpdir(), "trajpack", "runtime")
    : join(xdgRuntimeDir ?? tmpdir(), `trajpack-${process.getuid?.() ?? "user"}`);
  return {
    data: root,
    vault: join(root, "vault"),
    runtime: runtimeRoot,
    tombstones: join(root, "tombstones"),
  };
}
