# @trajpack/cli

Local-first trajectory capture, review, policy, validation, and export commands
for `trajpack`. The package includes the compiled React reviewer under
`reviewer/`; `trajpack review` serves those files only on a random loopback
port and does not require a separate `@trajpack/reviewer` installation.

Requires Node.js 24 or newer. Run `trajpack --help` for the public command
surface. See the repository README and security documentation before capturing
or exporting data.

`trajpack import export.zip --source-hint chatgpt|claude` reads a user-supplied
official export in memory and writes only encrypted raw envelopes to the vault.
It never extracts archive members to disk. Archive and selected-entry hashes
remain attached to every imported record; unsupported or ambiguous ZIP layouts
are rejected rather than guessed.

The secure defaults cap compressed input, entry count, per-entry decoded bytes,
and aggregate decoded bytes. Large legitimate exports can opt in to explicit
numeric overrides with `--max-bytes`, `--max-archive-entries`,
`--max-archive-entry-bytes`, and `--max-archive-uncompressed-bytes`; the same
validation still applies.
