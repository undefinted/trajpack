---
name: export-agent-trajectory
description: Capture, review, explain policy for, or export one explicitly authorized Codex agent trajectory with trajpack. Use when the user asks to archive a Codex session, inspect its observable tool/message trajectory, prepare post-training data, or determine whether a trace may be used for training or distillation.
---

# Export an agent trajectory

Treat the data as observable provider output and agent activity, never as hidden chain-of-thought.

1. Confirm that the user controls the session and has authority over prompts, repository content, tool results, and all participants' data.
2. Identify the account class, provider, applicable terms snapshot, input-rights basis, third-party-content status, exact teacher model, target model, participant-consented purpose, and whether the intended training is competitive. Do not infer missing rights or treat a URL, bare written-permission reference, or custom `LicenseRef` as proof.
3. Run `trajpack arm codex --next-session --cwd <absolute-path>` with the corresponding `--provider`, `--account-type`, `--terms`, rights, consent-purpose, and target options. If a contract is the authority, use a current source/use/target-scoped `--permission-evidence` JSON. Keep the command in the foreground while the session is captured.
4. If the policy command refuses capture, report the exact reason codes. Do not bypass the gate or read the unstable transcript file.
5. After the session ends, run `trajpack review`. Require automated checks and human approval before any plaintext export.
6. Use `trajpack policy explain <trace-id>` before training export. Use `trajpack export <trace-id> --format hf-trl --output <new-directory> --plaintext --mode training_competitive_distillation` only when every gate is `allow`.

Never scrape commercial chat pages, read credentials or cookies, enable persistent background capture, or label OpenAI or Claude summaries as raw reasoning. Prefer `provider_summary`, `provider_exposed_reasoning`, or `unavailable` according to the source interface.
