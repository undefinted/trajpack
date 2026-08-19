#!/usr/bin/env python3
"""Fast structural and lineage checks for trajectory-utility JSONL inputs."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
from pathlib import Path
from typing import Any, Iterable


ALLOWED_ROLES = {"system", "developer", "user", "assistant", "tool"}
ALLOWED_COMPONENTS = {"answer_text", "reasoning", "tool_name", "tool_arguments", "plan"}


def safe_integer_expression(expression: str) -> int:
    tree = ast.parse(expression, mode="eval")

    def visit(node: ast.AST) -> int:
        if isinstance(node, ast.Expression):
            return visit(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, int) and not isinstance(node.value, bool):
            _require(abs(node.value) <= 100_000, "evaluation integer is out of range")
            return int(node.value)
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult)):
            left, right = visit(node.left), visit(node.right)
            result = left + right if isinstance(node.op, ast.Add) else left - right if isinstance(node.op, ast.Sub) else left * right
            _require(abs(result) <= 10_000_000, "evaluation result is out of range")
            return result
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = visit(node.operand)
            return value if isinstance(node.op, ast.UAdd) else -value
        raise ValueError(f"unsupported evaluation expression node: {type(node).__name__}")

    _require(len(list(ast.walk(tree))) <= 32, "evaluation expression is too complex")
    return visit(tree)


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{number}: record must be an object")
            validate_dataset_example(value, f"{path}:{number}")
            records.append(value)
    if not records:
        raise ValueError(f"{path}: no records")
    return records


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def validate_dataset_example(example: dict[str, Any], where: str = "record") -> None:
    for key in ("id", "trace_id", "source_event_ids", "messages", "tools", "assistant_loss_mask", "training_targets", "metadata"):
        _require(key in example, f"{where}: missing {key}")
    _require(isinstance(example["metadata"], dict), f"{where}: metadata must be an object")
    messages = example["messages"]
    masks = example["assistant_loss_mask"]
    _require(isinstance(messages, list) and isinstance(masks, list), f"{where}: messages/mask must be arrays")
    _require(len(messages) == len(masks), f"{where}: assistant loss mask length mismatch")
    observed_calls: set[str] = set()
    for index, (message, enabled) in enumerate(zip(messages, masks, strict=True)):
        _require(isinstance(message, dict), f"{where}: message {index} is not an object")
        _require(message.get("role") in ALLOWED_ROLES, f"{where}: invalid role at message {index}")
        _require(isinstance(enabled, bool), f"{where}: loss mask {index} is not boolean")
        _require(not enabled or message["role"] == "assistant", f"{where}: non-assistant loss target at {index}")
        for call in (message.get("tool_calls") or []):
            _require(message["role"] == "assistant" and isinstance(call, dict), f"{where}: malformed tool call")
            call_id = call.get("id")
            _require(isinstance(call_id, str) and call_id and call_id not in observed_calls, f"{where}: duplicate/invalid tool id")
            observed_calls.add(call_id)
            function = call.get("function")
            _require(isinstance(function, dict) and isinstance(function.get("name"), str), f"{where}: malformed tool function")
            arguments = function.get("arguments")
            try:
                arguments_parsed = json.loads(arguments) if isinstance(arguments, str) else None
            except json.JSONDecodeError:
                arguments_parsed = None
            _require(isinstance(arguments, str) and isinstance(arguments_parsed, dict), f"{where}: tool arguments are not JSON object text")
        if message["role"] == "tool":
            _require(message.get("tool_call_id") in observed_calls, f"{where}: tool result has no preceding call")
    for target in example["training_targets"]:
        _require(isinstance(target, dict), f"{where}: training target must be object")
        index = target.get("message_index")
        _require(isinstance(index, int) and 0 <= index < len(messages), f"{where}: target index out of bounds")
        _require(masks[index] is True and messages[index]["role"] == "assistant", f"{where}: target is not loss-enabled assistant")
        components = target.get("components")
        _require(isinstance(components, list) and components and set(components) <= ALLOWED_COMPONENTS, f"{where}: invalid target components")
    evaluation = example["metadata"].get("evaluation")
    if evaluation is not None:
        _require(isinstance(evaluation, dict), f"{where}: evaluation metadata must be object")
        _require(isinstance(evaluation.get("expected_expression"), str), f"{where}: missing expected expression")
        _require(isinstance(evaluation.get("gold_answer"), int), f"{where}: missing integer gold answer")
        try:
            calculated = safe_integer_expression(evaluation["expected_expression"])
        except (SyntaxError, ValueError) as error:
            raise ValueError(f"{where}: invalid evaluation expression: {error}") from error
        _require(calculated == evaluation["gold_answer"], f"{where}: gold answer does not match expected expression")


def task_signatures(records: Iterable[dict[str, Any]]) -> set[str]:
    signatures: list[str] = []
    for record in records:
        signature = record["metadata"].get("task_signature_sha256")
        _require(isinstance(signature, str) and len(signature) == 64, f"{record['id']}: invalid task signature")
        signatures.append(signature)
    _require(len(signatures) == len(set(signatures)), "duplicate task signatures within one split/arm")
    return set(signatures)


def trace_ids(records: Iterable[dict[str, Any]]) -> set[str]:
    values = [record["trace_id"] for record in records]
    _require(all(isinstance(value, str) and value for value in values), "invalid trace_id")
    _require(len(values) == len(set(values)), "duplicate trace_ids within one split/arm")
    return set(values)


def task_pairing_map(records: Iterable[dict[str, Any]]) -> dict[str, str]:
    result: dict[str, str] = {}
    for record in records:
        signature = str(record["metadata"]["task_signature_sha256"])
        leading_context: list[dict[str, Any]] = []
        for message in record["messages"]:
            if message["role"] in {"assistant", "tool"}:
                break
            leading_context.append(message)
        payload = {
            "trace_id": record["trace_id"],
            "leading_context": leading_context,
            "evaluation": record["metadata"]["evaluation"],
        }
        result[signature] = hashlib.sha256(
            json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()
    return result


def validate_suite(answer_path: Path, complete_path: Path, eval_path: Path) -> dict[str, Any]:
    answer = read_jsonl(answer_path)
    complete = read_jsonl(complete_path)
    held_out = read_jsonl(eval_path)
    _require(len(answer) == len(complete), "SFT arm record counts differ")
    answer_signatures = task_signatures(answer)
    complete_signatures = task_signatures(complete)
    eval_signatures = task_signatures(held_out)
    answer_trace_ids = trace_ids(answer)
    complete_trace_ids = trace_ids(complete)
    eval_trace_ids = trace_ids(held_out)
    _require(answer_signatures == complete_signatures, "SFT arms do not contain the same training tasks")
    _require(answer_trace_ids == complete_trace_ids, "SFT arms do not contain the same trace identities")
    _require(task_pairing_map(answer) == task_pairing_map(complete), "paired SFT tasks have different prompt or gold data")
    overlap = answer_signatures & eval_signatures
    _require(not overlap, f"train/eval overlap: {len(overlap)} tasks")
    _require(not (answer_trace_ids & eval_trace_ids), "train/eval trace_id overlap")
    _require(all(not any(record["assistant_loss_mask"]) for record in held_out), "held-out records contain loss targets")
    _require(all(not record["training_targets"] for record in held_out), "held-out records contain training targets")
    for record in held_out:
        roles = [message["role"] for message in record["messages"]]
        _require(bool(roles) and set(roles) <= {"system", "developer", "user"}, f"{record['id']}: held-out prompt leaks assistant/tool context")
        _require(roles[-1] == "user", f"{record['id']}: held-out prompt must end with a user message")
    return {
        "schema_version": "trajectory-utility-validation/0.1",
        "valid": True,
        "counts": {"answer_only": len(answer), "complete_trajectory": len(complete), "held_out": len(held_out)},
        "train_eval_overlap": 0,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--answer-only", type=Path, required=True)
    parser.add_argument("--complete", type=Path, required=True)
    parser.add_argument("--eval", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(validate_suite(args.answer_only, args.complete, args.eval), sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
