#!/usr/bin/env python3
"""Generate owned, deterministic calculator trajectories for a narrow utility smoke test.

The generated records intentionally match trajpack's DatasetExample shape.  No
provider output, website data, or third-party benchmark text is used.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


GENERATOR_VERSION = "synthetic-calculator/0.1"
DATA_LICENSE = "Apache-2.0"
SYSTEM_PROMPT = (
    "You are an arithmetic agent with an optional calculator. Reply with only compact JSON. "
    'A calculator request has shape {"name":"calculator","arguments":{"expression":"..."}}. '
    'A final answer has shape {"answer":INTEGER}. After a tool result, provide a final answer. Do not add prose.'
)
TOOL = {
    "type": "function",
    "function": {
        "name": "calculator",
        "description": "Evaluate an integer arithmetic expression.",
        "parameters": {
            "type": "object",
            "properties": {"expression": {"type": "string"}},
            "required": ["expression"],
            "additionalProperties": False,
        },
    },
}


@dataclass(frozen=True)
class Task:
    family: str
    user: str
    expression: str
    answer: int

    @property
    def signature(self) -> str:
        return sha256_text(canonical_json([self.family, self.user, self.expression, self.answer]))


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_text(value: str) -> str:
    return sha256_bytes(value.encode("utf-8"))


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _candidate(rng: random.Random) -> Task:
    family = rng.choice(("mul_add", "add_mul", "mul_sub", "sub_mul", "nested_add"))
    a = rng.randint(2, 39)
    b = rng.randint(2, 17)
    c = rng.randint(2, 19)
    if family == "mul_add":
        return Task(family, f"Start with {a}, multiply by {b}, then add {c}.", f"({a}*{b})+{c}", a * b + c)
    if family == "add_mul":
        return Task(family, f"Add {a} and {b}, then multiply that sum by {c}.", f"({a}+{b})*{c}", (a + b) * c)
    if family == "mul_sub":
        # c (2..19) may exceed a*b (>= 4), so answers can be negative or zero.
        return Task(family, f"Multiply {a} by {b}, then subtract {c}.", f"({a}*{b})-{c}", a * b - c)
    if family == "sub_mul":
        high, low = max(a, b), min(a, b)
        return Task(family, f"Subtract {low} from {high}, then multiply by {c}.", f"({high}-{low})*{c}", (high - low) * c)
    return Task(family, f"Add {b} and {c}, then multiply the sum by {a}.", f"{a}*({b}+{c})", a * (b + c))


def make_tasks(count: int, rng: random.Random, used: set[str]) -> list[Task]:
    tasks: list[Task] = []
    while len(tasks) < count:
        task = _candidate(rng)
        if task.signature in used:
            continue
        used.add(task.signature)
        tasks.append(task)
    return tasks


def _identity(task: Task, split: str, index: int) -> tuple[str, str, str]:
    stem = sha256_text(canonical_json([GENERATOR_VERSION, split, index, task.signature]))
    return f"calc-{split}-{stem[:16]}", stem[:32], f"synthetic:{split}:{stem[:24]}"


def _base_metadata(task: Task, split: str, index: int) -> dict[str, Any]:
    return {
        "synthetic": True,
        "generator": GENERATOR_VERSION,
        "data_license": DATA_LICENSE,
        "ownership": "project-authored deterministic synthetic data",
        "split": split,
        "split_index": index,
        "task_family": task.family,
        "task_signature_sha256": task.signature,
        "evaluation": {
            "expected_expression": task.expression,
            "gold_answer": task.answer,
        },
    }


def answer_only_example(task: Task, index: int) -> dict[str, Any]:
    example_id, trace_id, source = _identity(task, "train", index)
    answer_source = f"{source}:answer"
    return {
        "id": f"{example_id}-answer-only",
        "trace_id": trace_id,
        "source_event_ids": [f"{source}:user", answer_source],
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": task.user},
            {"role": "assistant", "content": compact_json({"answer": task.answer})},
        ],
        "tools": [TOOL],
        "assistant_loss_mask": [False, False, True],
        "training_targets": [{
            "message_index": 2,
            "components": ["answer_text"],
            "loss_weight": 1,
            "source_event_ids": [answer_source],
        }],
        "reward": None,
        "verifier": None,
        "metadata": {**_base_metadata(task, "train", index), "arm": "answer_only_sft"},
    }


def complete_trajectory_example(task: Task, index: int) -> dict[str, Any]:
    example_id, trace_id, source = _identity(task, "train", index)
    call_id = f"call_{sha256_text(source)[:16]}"
    call_source = f"{source}:tool-call"
    result_source = f"{source}:tool-result"
    answer_source = f"{source}:answer"
    return {
        "id": f"{example_id}-complete-trajectory",
        "trace_id": trace_id,
        "source_event_ids": [f"{source}:user", call_source, result_source, answer_source],
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": task.user},
            {
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "id": call_id,
                    "type": "function",
                    "function": {
                        "name": "calculator",
                        "arguments": compact_json({"expression": task.expression}),
                    },
                }],
            },
            {"role": "tool", "name": "calculator", "tool_call_id": call_id, "content": str(task.answer)},
            {"role": "assistant", "content": compact_json({"answer": task.answer})},
        ],
        "tools": [TOOL],
        "assistant_loss_mask": [False, False, True, False, True],
        "training_targets": [
            {
                "message_index": 2,
                "components": ["tool_name", "tool_arguments"],
                "loss_weight": 1,
                "source_event_ids": [call_source],
            },
            {
                "message_index": 4,
                "components": ["answer_text"],
                "loss_weight": 1,
                "source_event_ids": [answer_source],
            },
        ],
        "reward": None,
        "verifier": None,
        "metadata": {**_base_metadata(task, "train", index), "arm": "complete_trajectory_sft"},
    }


def evaluation_example(task: Task, index: int) -> dict[str, Any]:
    example_id, trace_id, source = _identity(task, "eval", index)
    return {
        "id": f"{example_id}-held-out",
        "trace_id": trace_id,
        "source_event_ids": [f"{source}:user"],
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": task.user},
        ],
        "tools": [TOOL],
        "assistant_loss_mask": [False, False],
        "training_targets": [],
        "reward": None,
        "verifier": None,
        "metadata": {**_base_metadata(task, "eval", index), "arm": "held_out_evaluation"},
    }


def write_jsonl(path: Path, records: Iterable[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for record in records:
            handle.write(canonical_json(record))
            handle.write("\n")


def generate(output: Path, train_count: int, eval_count: int, seed: int) -> dict[str, Any]:
    if train_count < 1 or eval_count < 1:
        raise ValueError("train and eval counts must both be positive")
    output.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)
    used: set[str] = set()
    train = make_tasks(train_count, rng, used)
    held_out = make_tasks(eval_count, rng, used)

    paths = {
        "answer_only": output / "answer-only.train.jsonl",
        "complete_trajectory": output / "complete-trajectory.train.jsonl",
        "evaluation": output / "held-out.eval.jsonl",
    }
    write_jsonl(paths["answer_only"], (answer_only_example(task, i) for i, task in enumerate(train)))
    write_jsonl(paths["complete_trajectory"], (complete_trajectory_example(task, i) for i, task in enumerate(train)))
    write_jsonl(paths["evaluation"], (evaluation_example(task, i) for i, task in enumerate(held_out)))

    manifest = {
        "schema_version": "trajectory-utility-data/0.1",
        "generator_version": GENERATOR_VERSION,
        "seed": seed,
        "license": DATA_LICENSE,
        "provenance": "deterministic project-authored synthetic calculator tasks; no model generations",
        "counts": {"train": train_count, "held_out": eval_count},
        "arms": {
            "base": {"training_file": None},
            "answer_only_sft": {"training_file": paths["answer_only"].name},
            "complete_trajectory_sft": {"training_file": paths["complete_trajectory"].name},
        },
        "evaluation_file": paths["evaluation"].name,
        "files": {
            path.name: {"sha256": sha256_bytes(path.read_bytes()), "bytes": path.stat().st_size}
            for path in paths.values()
        },
        "split_integrity": {
            "overlap_count": 0,
            "train_signature_sha256": sha256_text(canonical_json(sorted(task.signature for task in train))),
            "held_out_signature_sha256": sha256_text(canonical_json(sorted(task.signature for task in held_out))),
        },
    }
    manifest_path = output / "data-manifest.json"
    manifest_path.write_text(canonical_json(manifest) + "\n", encoding="utf-8", newline="\n")
    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True, help="Output directory (use work/ignored/...)")
    parser.add_argument("--train", type=int, default=96)
    parser.add_argument("--eval", type=int, default=32)
    parser.add_argument("--seed", type=int, default=20260817)
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    result = generate(args.out.resolve(), args.train, args.eval, args.seed)
    print(canonical_json({"output": str(args.out.resolve()), "manifest": result}))
