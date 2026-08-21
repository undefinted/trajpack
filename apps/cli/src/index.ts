#!/usr/bin/env node
import { Command, Option } from "commander";
import type { ExportFormat } from "@trajpack/core";
import { runArm, runCapture } from "./capture-command.js";
import { DEFAULT_MAX_CAPTURE_EVENTS, DEFAULT_MAX_CAPTURE_RAW_BYTES } from "./ingest-server.js";
import {
  runDelete,
  runExport,
  runPolicyExplain,
  runPolicyOverride,
  runTermsSnapshot,
  runValidate,
  type PolicyOverrideOptions,
  type TermsSnapshotOptions,
} from "./commands.js";
import { runImport } from "./import-command.js";
import { runDoctor } from "./doctor.js";
import { runDatasetMigrate, runDatasetPlan, type DatasetPlanOptions } from "./dataset-command.js";
import {
  DEFAULT_MAX_CONCURRENT_REVIEW_VAULT_REQUESTS,
  DEFAULT_MAX_QUEUED_REVIEW_VAULT_REQUESTS,
  startReviewServer,
} from "./review-server.js";
import { safeCliDebugDiagnostic, safeCliErrorMessage } from "./safe-error.js";
import { readPassphrase } from "./secret.js";
import { runResearchAnalyze } from "./research-command.js";

function addSourceOptions(command: Command): Command {
  return command
    .addOption(new Option("--provider <provider>", "actual model provider").choices(["openai", "anthropic", "google", "deepseek", "self_hosted", "other", "unknown"]).default("unknown"))
    .addOption(new Option("--account-type <type>", "account or contract class").choices(["consumer", "api", "business", "enterprise", "managed_workspace", "self_hosted", "unknown"]).default("unknown"))
    .option("--model <id>", "exact model id")
    .option("--model-digest <digest>", "claimed model snapshot/weights digest; not proof by itself")
    .option("--model-artifact <path>", "locally hash an exact self-hosted model file or snapshot directory")
    .option("--interface-version <version>", "source interface version")
    .option("--origin <origin>", "authorized source origin")
    .option("--terms <json>", "one terms snapshot, or an array of snapshots, as JSON")
    .option("--written-permission <reference>", "lineage-only permission reference; does not clear a gate")
    .option("--permission-evidence <json>", "scoped permission metadata; requires --permission-document")
    .option("--permission-document <path>", "retained permission document hashed and bound to its metadata")
    .option("--permission-evidence-kind <kind>", "safe evidence kind used in the content-bound reference", "written-permission.v1")
    .addOption(new Option("--input-rights <basis>").choices(["owned", "licensed", "consented", "public_domain", "unknown"]).default("unknown"))
    .addOption(new Option("--third-party <state>").choices(["none", "present", "unknown"]).default("unknown"))
    .option("--source-license <expression>", "recognized SPDX expression (custom LicenseRef is archive-only in v1)", "NOASSERTION")
    .option("--model-license <expression...>", "ordered model/weights license chain")
    .option("--rights-holder <name>", "rights holder")
    .option("--target-model-owner <name>", "target model owner")
    .option("--target-product <name>", "target model/product")
    .addOption(new Option("--competitive <state>").choices(["yes", "no", "unknown"]).default("unknown"))
    .option("--region <region>", "contracting region")
    .option("--consent-purpose <purpose...>", "additional participant-consented uses, for example distillation or redistribution");
}

const program = new Command()
  .name("trajpack")
  .description("Local-first observable agent trajectory ETL and compliance router")
  .version("0.1.0")
  .enablePositionalOptions()
  .showHelpAfterError()
  .addHelpText("after", `
Research path:
  capture/import -> policy explain -> review -> dataset plan -> export -> validate

Training exporters fail closed on unknown rights, stale terms, unbound provenance,
failed quality checks, or missing target-scoped human approval. See
docs/research-workflow.md for an end-to-end reproducible workflow.`);

addSourceOptions(
  program.command("capture")
    .description("Run one explicitly authorized host session under encrypted capture")
    .argument("<host>", "codex, claude, gemini, or dsh")
    .argument("[command...]", "host executable and arguments after --")
    .option("--cwd <path>", "working directory")
    .option("--max-events <count>", "hard limit across stdout and hook channels", String(DEFAULT_MAX_CAPTURE_EVENTS))
    .option("--max-raw-bytes <bytes>", "hard raw-byte budget across stdout and hook channels", String(DEFAULT_MAX_CAPTURE_RAW_BYTES))
    .option("--drain-ms <milliseconds>", "bounded grace period for in-flight asynchronous hooks", "500"),
).allowUnknownOption(true).passThroughOptions().action(async (host: string, command: string[], options) => {
  process.exitCode = await runCapture(host, command, options);
});

addSourceOptions(
  program.command("arm")
    .description("Arm the next matching interactive Codex, Claude, or Gemini CLI session")
    .argument("<host>", "codex, claude, or gemini")
    .option("--next-session", "bind the first matching session")
    .requiredOption("--cwd <path>", "exact session working directory")
    .option("--ttl <duration>", "30s, 10m, or 1h", "10m")
    .option("--max-events <count>", "hard captured-event limit", String(DEFAULT_MAX_CAPTURE_EVENTS))
    .option("--max-raw-bytes <bytes>", "hard captured raw-byte limit", String(DEFAULT_MAX_CAPTURE_RAW_BYTES))
    .option("--drain-ms <milliseconds>", "bounded grace period for in-flight asynchronous hooks", "500"),
).action(async (host: string, options) => runArm(host, options));

addSourceOptions(
  program.command("import")
    .description("Import a user-provided official/manual export into the encrypted vault")
    .argument("<input>", "JSON, JSONL, HTML, ZIP official export, or .trajpack vault")
    .addOption(new Option("--source-hint <source>", "fail-closed source shape hint")
      .choices(["chatgpt", "claude", "gemini", "deepseek-api", "dsh-session", "generic"]))
    .option("--max-bytes <bytes>", "explicit compressed input/file byte limit")
    .option("--max-archive-entries <count>", "explicit ZIP entry-count limit")
    .option("--max-archive-entry-bytes <bytes>", "explicit ZIP per-entry decoded byte limit")
    .option("--max-archive-uncompressed-bytes <bytes>", "explicit ZIP aggregate decoded byte limit"),
).addHelpText("after", `
Offline API JSON and re-imported .trajpack files cross a trust boundary: recognized
shape is not provider authentication. Training requires the applicable policy gate,
content-bound provenance evidence, and a fresh human approval.`)
  .action(async (input: string, options) => { await runImport(input, options); });

program.command("review")
  .description("Open the loopback-only local review workbench")
  .option("--idle-minutes <minutes>", "vault idle lock timeout", "15")
  .option("--output-root <path>", "server-owned plaintext export root")
  .option(
    "--max-concurrent-vault-requests <count>",
    "bounded concurrent Argon2/decrypted-review work",
    String(DEFAULT_MAX_CONCURRENT_REVIEW_VAULT_REQUESTS),
  )
  .option(
    "--max-queued-vault-requests <count>",
    "bounded FIFO reviewer backlog before HTTP 429",
    String(DEFAULT_MAX_QUEUED_REVIEW_VAULT_REQUESTS),
  )
  .action(async (options: {
    idleMinutes: string;
    outputRoot?: string;
    maxConcurrentVaultRequests: string;
    maxQueuedVaultRequests: string;
  }) => {
    let passphrase = await readPassphrase();
    const server = await startReviewServer({
      passphrase,
      idleMinutes: Number(options.idleMinutes),
      maxConcurrentVaultRequests: Number(options.maxConcurrentVaultRequests),
      maxQueuedVaultRequests: Number(options.maxQueuedVaultRequests),
      ...(options.outputRoot ? { outputRoot: options.outputRoot } : {}),
    });
    passphrase = "";
    process.stdout.write([
      "Open this one-time local URL:",
      server.launchUrl,
      "",
      "Authorized-site Chromium pairing:",
      `Collector: ${server.url}`,
      `One-time nonce: ${server.browserPairingNonce}`,
      "",
    ].join("\n"));
    await new Promise<void>((resolve) => {
      const stop = () => resolve();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    await server.close();
  });

program.command("doctor")
  .description("Report native agent executables, pinned interfaces, and safe web import paths")
  .option("--json", "emit a machine-readable compatibility report")
  .action((options: { json?: boolean }) => runDoctor(options));

program.command("analyze")
  .description("Derive content-free workload and training-yield research metrics from approved traces")
  .argument("<trace-ids...>", "one or more exact managed trace ids")
  .addOption(new Option("--format <format>").choices(["summary", "tracelab-jsonl"]).default("summary"))
  .addHelpText("after", `
The TraceLab-shaped JSONL view is intentionally lossy and content-free. It is
for workload/DuckDB research, never canonical reconstruction or training.`)
  .action((traceIds: string[], options: { format: "summary" | "tracelab-jsonl" }) => runResearchAnalyze(traceIds, options));

program.command("validate")
  .description("Validate a managed/encrypted trace, build, export directory, canonical bundle, or HF JSONL")
  .argument("<selection>", "trace id or path to .trajpack, build JSON, export directory, canonical bundle, or JSONL")
  .addHelpText("after", `
Dataset-directory validation proves internal self-consistency and compiler support;
it does not re-open managed vaults or attest current training authorization.`)
  .action(async (selection: string) => { if (!(await runValidate(selection))) process.exitCode = 2; });

const dataset = program.command("dataset").description("Freeze and audit reproducible multi-trace research datasets");
dataset.command("plan")
  .description("Create a content-bound dataset build file from approved managed traces")
  .argument("<trace-ids...>", "exact managed trace ids")
  .requiredOption("--output <file>", "new dataset build JSON file")
  .requiredOption("--name <name>", "portable dataset name")
  .addOption(new Option("--mode <mode>").choices(["archive", "training_noncompetitive", "training_competitive_distillation", "redistribution"]).makeOptionMandatory())
  .requiredOption("--seed <seed>", "deterministic split seed")
  .option("--train <basis-points>", "train ratio in basis points", "8000")
  .option("--validation <basis-points>", "validation ratio in basis points", "1000")
  .option("--test <basis-points>", "test ratio in basis points", "1000")
  .option("--group-map <json>", "private trace-id to repo/task-family alias map; aliases are hashed before storage")
  .addOption(new Option("--recipe <recipe>", "frozen dataset view; non-trace_full recipes require a training mode and HF/TRL export")
    .choices(["trace_full", "answer_sft", "reasoning_sft", "tool_use_sft", "deepseek_epoch_sft", "failure_recovery", "subagent_handoff", "pointwise_reward_rl_ready"])
    .default("trace_full"))
  .addOption(new Option("--quality-profile <profile>").choices(["sft_basic", "tool_agent_strict", "research_strict"]).default("research_strict"))
  .option("--target-model-owner <name>")
  .option("--target-product <name>")
  .addHelpText("after", `
For multi-trace research_strict builds, --group-map must cover every selected
trace exactly once. The output parent must exist and the build file must be new.`)
  .action(async (traceIds: string[], options: DatasetPlanOptions) => { await runDatasetPlan(traceIds, options); });

dataset.command("migrate")
  .description("Explicitly migrate a historical frozen dataset build into the current schema")
  .argument("<input>", "historical dataset-build JSON")
  .requiredOption("--output <file>", "new migrated dataset-build JSON file")
  .action(async (input: string, options: { output: string }) => { await runDatasetMigrate(input, options.output); });

const policy = program.command("policy").description("Explain and manage scoped policy evidence");
policy.command("explain").argument("<selection>").action(runPolicyExplain);
policy.command("override")
  .description("Apply one trace-scoped, expiring, evidence-backed decision override")
  .argument("<trace-id>")
  .addOption(new Option("--dimension <dimension>").choices([
    "local_archive",
    "automatic_capture",
    "training_noncompetitive",
    "training_competitive_distillation",
    "redistribution",
  ]).makeOptionMandatory())
  .addOption(new Option("--status <status>").choices(["allow", "deny"]).makeOptionMandatory())
  .requiredOption("--reviewer <identity>")
  .requiredOption("--evidence-kind <kind>", "lowercase evidence category used in the content-bound reference")
  .requiredOption("--evidence-file <path>", "regular local file to hash and bind to this override")
  .requiredOption("--expires <timestamp>")
  .requiredOption("--reason <text>")
  .option("--purpose <purpose...>")
  .option("--target-model-owner <name>")
  .option("--target-product <name>")
  .addOption(new Option("--competitive <state>").choices(["yes", "no", "unknown"]))
  .option("--yes", "confirm the exact override scope")
  .addHelpText("after", `
The CLI hashes --evidence-file; caller-authored digest references are not accepted.
An override is trace/dimension/target scoped, expires, and resets review approval.`)
  .action((traceId: string, options: PolicyOverrideOptions) => runPolicyOverride(traceId, options));

policy.command("snapshot")
  .description("Hash a locally downloaded terms document into a reviewable snapshot record")
  .requiredOption("--name <name>")
  .requiredOption("--url <url>")
  .requiredOption("--effective-at <timestamp>")
  .requiredOption("--review-after <timestamp>")
  .requiredOption("--input <file>")
  .requiredOption("--output <file>")
  .action((options: TermsSnapshotOptions) => runTermsSnapshot(options));

program.command("export")
  .description("Explicitly write an approved plaintext export")
  .argument("<selection>", "managed trace id or frozen dataset-build JSON path")
  .addOption(new Option("--format <format>").choices(["canonical", "atif", "hf-trl", "otlp"]).makeOptionMandatory())
  .requiredOption("--output <directory>")
  .option("--plaintext", "acknowledge that output leaves the encrypted vault")
  .addOption(new Option("--recipe <recipe>", "versioned single-trace HF/TRL training view")
    .choices(["answer_sft", "reasoning_sft", "tool_use_sft", "deepseek_epoch_sft", "failure_recovery", "subagent_handoff", "pointwise_reward_rl_ready"]))
  .addOption(new Option("--mode <mode>").choices(["archive", "training_noncompetitive", "training_competitive_distillation", "redistribution"]))
  .addHelpText("after", `
The output directory must not already exist. A dataset build freezes its mode;
--mode may only repeat that value. Plaintext copies cannot be recalled by trajpack.`)
  .action((selection: string, options: {
    format: ExportFormat;
    output: string;
    plaintext?: boolean;
    mode?: "archive" | "training_noncompetitive" | "training_competitive_distillation" | "redistribution";
    recipe?: "answer_sft" | "reasoning_sft" | "tool_use_sft" | "deepseek_epoch_sft" | "failure_recovery" | "subagent_handoff" | "pointwise_reward_rl_ready";
  }) => runExport(selection, options));

program.command("delete")
  .description("Delete one exact encrypted trace and create a lineage tombstone")
  .argument("<trace-id>")
  .option("--yes", "confirm the exact trace id")
  .action((traceId: string, options: { yes?: boolean }) => runDelete(traceId, Boolean(options.yes)));

program.parseAsync().catch((error: unknown) => {
  const message = safeCliErrorMessage(error);
  process.stderr.write(`trajpack: ${message}\n`);
  if (process.env.TRAJPACK_DEBUG === "1") {
    process.stderr.write(`trajpack-debug: ${safeCliDebugDiagnostic(error)}\n`);
  }
  process.exitCode = 1;
});
