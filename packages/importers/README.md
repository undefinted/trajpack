# @trajpack/importers

Conservative, non-executing import adapters for official exports and user-created
archives. The public APIs are:

- `importFile(path, options)` for the CLI;
- `importToRawEnvelopes(stringOrBytes, options)` for in-memory callers;
- `detectImportFormat(text, options)` for preview-only detection; and
- `importOfficialZipArchive(bytes, options)` for bounded in-memory ZIP import.

`conversations.json` is treated as a ChatGPT or Claude official export only when
its filename and structure both match a versioned fixture, or when an explicit
source hint and the same structure match. Everything else remains a generic
manual import. Shape detection never authenticates a user-supplied file, so every
record explicitly carries `source_authenticity: unverified_user_supplied`. HTML is
retained as untrusted text and never rendered; the optional
text preview is best-effort and is explicitly not visibility evidence.

Official ZIP archives are inspected and decoded entirely in memory; no member
is extracted to disk. The reader accepts one validated `conversations.json`, a
contiguous ChatGPT `conversations-000.json` shard set, one validated
`conversations.jsonl`, or (only when structured data is absent) a `chat.html`
carrying the conservative `ChatGPT Data Export` document marker. A normal
ChatGPT archive may contain both JSON and `chat.html`; validated JSON wins and
the HTML viewer is ignored. Multiple roots, mixed formats, missing shard
indices, format drift, or any other ambiguous selection fail closed.

Before decoding a selected entry, every ZIP member is checked for traversal,
absolute/backslash paths, duplicate/confusable names, encryption, ZIP64,
unsupported compression, Unix symlinks/special files, metadata disagreement,
overlap, and declared-size bounds. The defaults are 64 MiB compressed input,
4,096 entries, 64 MiB per entry, and 256 MiB total uncompressed data; callers
may lower or explicitly raise these through `ImportOptions`. Both the full archive SHA-256 and each
selected entry SHA-256 are stored in raw provenance. The archive itself remains
the user-provided source file and is not copied into plaintext storage.

Saved DeepSeek Chat Completions responses are recognized as
`deepseek_api_response` when every JSON/JSONL record has the validated
`chat.completion` or `chat.completion.chunk` shape and a DeepSeek model
identifier. An explicit `sourceHint: "deepseek-api"` may identify a compatible
model alias, but never bypasses structural validation. This is an offline manual
artifact import: it makes no API request and does not authenticate the artifact.
