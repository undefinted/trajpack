# DeepSeek Harness research demo

This directory contains an authored synthetic, pinned DeepSeek Harness rc.6
session and its deterministic trajpack outputs. Start with
[`../../docs/demo.md`](../../docs/demo.md).

No model or network service is called. The provider/model names are fixture
routing labels, not claims that DeepSeek generated the content. The short
reasoning field is authored synthetic text; it is not hidden chain-of-thought.

```powershell
./examples/deepseek-research-demo/run.ps1
```

Or on a POSIX shell:

```sh
sh examples/deepseek-research-demo/run.sh
```

The committed `artifacts/` directory lets reviewers inspect JSONL, native
Parquet, policy/lineage reports, research metrics, checksums, and a deliberately
blocked sequence-gap sample without first running the script.
