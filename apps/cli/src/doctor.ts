import { spawnSync } from "node:child_process";

export const DOCTOR_REPORT_VERSION = "doctor/0.1" as const;

interface ExecutableProbe {
  found: boolean;
  version: string | null;
}

export interface DoctorReport {
  report_version: typeof DOCTOR_REPORT_VERSION;
  generated_at: string;
  platform: NodeJS.Platform;
  node: { version: string; required_major: 24; compatible: boolean };
  native_agents: Array<{
    id: "codex" | "claude" | "gemini" | "dsh";
    executable: string;
    executable_found: boolean;
    detected_version: string | null;
    plugin_directory: string;
    capture_surfaces: string[];
    expected_interfaces: string[];
    plugin_installation: "not_verified";
    compatibility: "available" | "missing_executable" | "version_mismatch";
  }>;
  web_and_imports: Array<{
    product: string;
    supported_path: string;
    fidelity: "B" | "C";
    automatic_commercial_dom_capture: false;
  }>;
  boundaries: string[];
}

const VERSION_PATTERN = /(?:^|[^0-9])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:$|[^0-9A-Za-z.-])/u;

function cleanEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.TRAJPACK_PASSPHRASE;
  delete environment.TRAJPACK_COLLECTOR_URL;
  delete environment.TRAJPACK_CAPTURE_TOKEN;
  delete environment.TRAJPACK_CAPTURE_HOST;
  return environment;
}

export function probeExecutable(executable: string): ExecutableProbe {
  if (!/^[a-z0-9._-]+$/iu.test(executable)) return { found: false, version: null };
  const environment = cleanEnvironment();
  if (process.platform === "win32") {
    const located = spawnSync("where.exe", [executable], {
      env: environment,
      encoding: "utf8",
      windowsHide: true,
      shell: false,
      timeout: 10_000,
    });
    if (located.status !== 0 || located.error !== undefined) return { found: false, version: null };
  }
  // Windows npm shims are .cmd files; spawning the extensionless shell shim
  // directly returns EPERM/EINVAL. The executable names in this report are a
  // closed allowlist, so invoking the platform command processor is bounded.
  const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : executable;
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", `${executable} --version`]
    : ["--version"];
  const result = spawnSync(command, args, {
    env: environment,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: 10_000,
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { found: false, version: null };
  }
  const bounded = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.slice(0, 4_096);
  return {
    found: result.error === undefined,
    version: VERSION_PATTERN.exec(bounded)?.[1] ?? null,
  };
}

export function collectDoctorReport(
  probe: (executable: string) => ExecutableProbe = probeExecutable,
  now = new Date(),
): DoctorReport {
  const definitions = [
    {
      id: "codex" as const,
      executable: "codex",
      plugin_directory: "plugins/trajpack",
      capture_surfaces: ["codex exec --json", "Codex hooks", "App Server v2 JSON-RPC"],
      expected_interfaces: ["codex-exec-jsonl/1", "codex-hook/1", "codex-app-server-v2-jsonrpc/1"],
    },
    {
      id: "claude" as const,
      executable: "claude",
      plugin_directory: "plugins/claude-code",
      capture_surfaces: ["--output-format stream-json --verbose", "Claude Code hooks"],
      expected_interfaces: ["claude-stream-json/1", "claude-hook/1", "claude-transcript-opaque/1"],
    },
    {
      id: "gemini" as const,
      executable: "gemini",
      plugin_directory: "plugins/trajpack-gemini",
      capture_surfaces: ["Gemini CLI extension hooks"],
      expected_interfaces: ["gemini-cli-hook/1"],
    },
    {
      id: "dsh" as const,
      executable: "dsh",
      plugin_directory: "plugins/deepseek-harness",
      capture_surfaces: ["durable session/event"],
      expected_interfaces: ["deepseek-harness@0.1.0-rc.6/session-event/0"],
    },
  ];
  const nativeAgents = definitions.map((definition) => {
    const observed = probe(definition.executable);
    const mismatch = definition.id === "dsh" && observed.found && observed.version !== "0.1.0-rc.6";
    return {
      ...definition,
      executable_found: observed.found,
      detected_version: observed.version,
      plugin_installation: "not_verified" as const,
      compatibility: !observed.found
        ? "missing_executable" as const
        : mismatch
          ? "version_mismatch" as const
          : "available" as const,
    };
  });
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  return {
    report_version: DOCTOR_REPORT_VERSION,
    generated_at: now.toISOString(),
    platform: process.platform,
    node: { version: process.versions.node, required_major: 24, compatible: major >= 24 },
    native_agents: nativeAgents,
    web_and_imports: [
      { product: "ChatGPT", supported_path: "official ZIP/JSON/HTML export import", fidelity: "B", automatic_commercial_dom_capture: false },
      { product: "Claude.ai", supported_path: "official ZIP/JSON export import", fidelity: "B", automatic_commercial_dom_capture: false },
      { product: "Gemini Apps", supported_path: "Google Takeout Gemini Apps MyActivity JSON/HTML import", fidelity: "B", automatic_commercial_dom_capture: false },
      { product: "DeepSeek", supported_path: "DeepSeek API JSON/JSONL or user-created manual archive", fidelity: "B", automatic_commercial_dom_capture: false },
      { product: "DeepSeek Harness session", supported_path: "explicit --source-hint dsh-session for unpacked, uncompressed persistence v0 JSONL", fidelity: "B", automatic_commercial_dom_capture: false },
      { product: "Authorized site", supported_path: "click-driven selector recipe and visible DOM preview", fidelity: "C", automatic_commercial_dom_capture: false },
    ],
    boundaries: [
      "Executable detection does not prove that a host plugin is installed or that provider/model claims are authentic.",
      "Commercial ChatGPT, Claude, Gemini, and DeepSeek web origins have no built-in DOM selector preset.",
      "A recognized API or Harness persistence shape is user-supplied evidence, not provider authentication.",
      "Visible reasoning is classified as provider-exposed reasoning, summary, generated rationale, opaque state, or unavailable; never hidden chain of thought.",
    ],
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const rows = report.native_agents.map((host) => [
    host.id.padEnd(8),
    host.compatibility.padEnd(18),
    host.detected_version ?? "version-unparsed",
  ].join("  "));
  return [
    `trajpack doctor (${report.report_version})`,
    `Node ${report.node.version}: ${report.node.compatible ? "compatible" : "requires Node 24+"}`,
    "",
    "Native agent executables (plugin installation is checked separately by each host):",
    ...rows,
    "",
    "Web products: official/manual import only; commercial DOM presets are intentionally disabled.",
    "Run with --json for the complete interfaces and security boundaries.",
  ].join("\n");
}

export function runDoctor(options: { json?: boolean } = {}): void {
  const report = collectDoctorReport();
  process.stdout.write(`${options.json ? JSON.stringify(report, null, 2) : formatDoctorReport(report)}\n`);
}
