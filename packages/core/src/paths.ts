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
  const root = system === "win32"
    ? join(environment.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "trajpack")
    : system === "darwin"
      ? join(homedir(), "Library", "Application Support", "trajpack")
      : join(environment.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "trajpack");
  const runtimeRoot = system === "win32"
    ? join(environment.LOCALAPPDATA ?? tmpdir(), "trajpack", "runtime")
    : join(environment.XDG_RUNTIME_DIR ?? tmpdir(), `trajpack-${process.getuid?.() ?? "user"}`);
  return {
    data: root,
    vault: join(root, "vault"),
    runtime: runtimeRoot,
    tombstones: join(root, "tombstones"),
  };
}
