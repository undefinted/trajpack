#!/usr/bin/env node
import { Command, Option } from "commander";
import type { ExportFormat } from "@trajpack/core";
import { runArm, runCapture } from "./capture-command.js";
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
import { startReviewServer } from "./review-server.js";
import { readPassphrase } from "./secret.js";

function addSourceOptions(command: Command): Command {
  return command
    .addOption(new Option("--provider <provider>", "actual model provider").choices(["openai", "anthropic", "deepseek", "self_hosted", "other", "unknown"]).default("unknown"))
    .addOption(new Option("--account-type <type>", "account or contract class").choices(["consumer", "api", "business", "enterprise", "managed_workspace", "self_hosted", "unknown"]).default("unknown"))
    .option("--model <id>", "exact model id")
    .option("--model-digest <digest>", "model snapshot or weights digest")
    .option("--interface-version <version>", "source interface version")
    .option("--origin <origin>", "authorized source origin")
    .option("--terms <json>", "terms snapshot JSON file")
    .option("--written-permission <reference>", "order form or written permission evidence reference")
    .option("--permission-evidence <json>", "scoped permission evidence JSON file")
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
  .showHelpAfterError();

addSourceOptions(
  program.command("capture")
    .description("Run one explicitly authorized host session under encrypted capture")
    .argument("<host>", "codex, claude, or dsh")
    .argument("[command...]", "host executable and arguments after --")
    .option("--cwd <path>", "working directory"),
).allowUnknownOption(true).passThroughOptions().action(async (host: string, command: string[], options) => {
  process.exitCode = await runCapture(host, command, options);
});

addSourceOptions(
  program.command("arm")
    .description("Arm the next matching interactive Codex or Claude session")
    .argument("<host>", "codex or claude")
    .option("--next-session", "bind the first matching session")
    .requiredOption("--cwd <path>", "exact session working directory")
    .option("--ttl <duration>", "30s, 10m, or 1h", "10m"),
).action(async (host: string, options) => runArm(host, options));

addSourceOptions(
  program.command("import")
    .description("Import a user-provided official/manual export into the encrypted vault")
    .argument("<input>", "JSON, JSONL, HTML, ZIP official export, or .trajpack vault")
    .addOption(new Option("--source-hint <source>", "fail-closed source shape hint")
      .choices(["chatgpt", "claude", "deepseek-api", "generic"]))
    .option("--max-bytes <bytes>", "explicit compressed input/file byte limit")
    .option("--max-archive-entries <count>", "explicit ZIP entry-count limit")
    .option("--max-archive-entry-bytes <bytes>", "explicit ZIP per-entry decoded byte limit")
    .option("--max-archive-uncompressed-bytes <bytes>", "explicit ZIP aggregate decoded byte limit"),
).action(async (input: string, options) => { await runImport(input, options); });

program.command("review")
  .description("Open the loopback-only local review workbench")
  .option("--idle-minutes <minutes>", "vault idle lock timeout", "15")
  .option("--output-root <path>", "server-owned plaintext export root")
  .action(async (options: { idleMinutes: string; outputRoot?: string }) => {
    let passphrase = await readPassphrase();
    const server = await startReviewServer({
      passphrase,
      idleMinutes: Number(options.idleMinutes),
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

program.command("validate")
  .description("Validate an encrypted trace, canonical bundle, or HF/TRL JSONL")
  .argument("<selection>")
  .action(async (selection: string) => { if (!(await runValidate(selection))) process.exitCode = 2; });

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
  .requiredOption("--evidence <reference>")
  .requiredOption("--expires <timestamp>")
  .requiredOption("--reason <text>")
  .option("--purpose <purpose...>")
  .option("--target-model-owner <name>")
  .option("--target-product <name>")
  .addOption(new Option("--competitive <state>").choices(["yes", "no", "unknown"]))
  .option("--yes", "confirm the exact override scope")
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
  .argument("<selection>")
  .addOption(new Option("--format <format>").choices(["canonical", "atif", "hf-trl", "otlp"]).makeOptionMandatory())
  .requiredOption("--output <directory>")
  .option("--plaintext", "acknowledge that output leaves the encrypted vault")
  .addOption(new Option("--mode <mode>").choices(["archive", "training_noncompetitive", "training_competitive_distillation", "redistribution"]))
  .action((selection: string, options: { format: ExportFormat; output: string; plaintext?: boolean; mode?: "archive" | "training_noncompetitive" | "training_competitive_distillation" | "redistribution" }) => runExport(selection, options));

program.command("delete")
  .description("Delete one exact encrypted trace and create a lineage tombstone")
  .argument("<trace-id>")
  .option("--yes", "confirm the exact trace id")
  .action((traceId: string, options: { yes?: boolean }) => runDelete(traceId, Boolean(options.yes)));

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`trajpack: ${message}\n`);
  if (process.env.TRAJPACK_DEBUG === "1" && error instanceof Error) process.stderr.write(`${error.stack ?? ""}\n`);
  process.exitCode = 1;
});
