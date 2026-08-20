#!/usr/bin/env python3
"""Run the three-arm calculator trajectory utility smoke experiment.

This file keeps ML imports lazy so data generation and structural tests do not
need a model environment. Outputs are restricted to work/ignored by default.
"""

from __future__ import annotations

import argparse
import ast
import gc
import hashlib
import importlib.metadata
import json
import os
import platform
import random
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Iterable

from validate_data import read_jsonl, validate_suite


RUNNER_VERSION = "trajectory-utility-runner/0.1"
ARM_ORDER = ("base", "answer_only_sft", "complete_trajectory_sft")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(canonical_json(value) + "\n", encoding="utf-8", newline="\n")
    temporary.replace(path)


def require_ignored_path(path: Path, repository: Path, label: str) -> Path:
    resolved = path.resolve()
    root = (repository / "work" / "ignored").resolve()
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise ValueError(f"{label} must be inside {root}, got {resolved}") from error
    return resolved


def create_fresh_output(path: Path) -> None:
    """Atomically reserve a never-before-used run directory.

    Reusing a partial or completed directory could mix adapters and metrics from
    different executions, so resume is intentionally unsupported in v0.1.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        path.mkdir(exist_ok=False)
    except FileExistsError as error:
        raise FileExistsError(f"output directory already exists; choose a fresh run path: {path}") from error


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def assistant_payload(message: dict[str, Any]) -> str:
    calls = message.get("tool_calls")
    if calls is not None:
        if not isinstance(calls, list) or len(calls) != 1:
            raise ValueError("the smoke renderer requires exactly one tool call per assistant turn")
        function = calls[0]["function"]
        arguments = json.loads(function["arguments"])
        return compact_json({"name": function["name"], "arguments": arguments})
    content = message.get("content")
    if not isinstance(content, str):
        raise ValueError("assistant target content must be text or a single native tool call")
    return content


def message_payload(message: dict[str, Any]) -> str:
    role = message["role"]
    if role == "assistant":
        return assistant_payload(message)
    if role == "tool":
        return compact_json({
            "tool_call_id": message["tool_call_id"],
            "output": str(message.get("content", "")),
        })
    content = message.get("content")
    if not isinstance(content, str):
        raise ValueError(f"{role} message content must be text")
    return content


def render_message(message: dict[str, Any]) -> str:
    return f"<|im_start|>{message['role']}\n{message_payload(message)}<|im_end|>\n"


def render_generation_prompt(messages: Iterable[dict[str, Any]]) -> str:
    return "".join(render_message(message) for message in messages) + "<|im_start|>assistant\n"


def supervised_samples(records: list[dict[str, Any]], tokenizer: Any, max_length: int) -> tuple[list[dict[str, Any]], dict[str, int]]:
    samples: list[dict[str, Any]] = []
    prompt_tokens = 0
    target_tokens = 0
    for record in records:
        messages = record["messages"]
        for index, enabled in enumerate(record["assistant_loss_mask"]):
            if not enabled:
                continue
            prompt = render_generation_prompt(messages[:index])
            completion = assistant_payload(messages[index]) + "<|im_end|>\n"
            prompt_ids = tokenizer.encode(prompt, add_special_tokens=False)
            completion_ids = tokenizer.encode(completion, add_special_tokens=False)
            if len(completion_ids) >= max_length:
                raise ValueError(f"target for {record['id']} exceeds max_length")
            if len(prompt_ids) + len(completion_ids) > max_length:
                prompt_ids = prompt_ids[-(max_length - len(completion_ids)):]
            input_ids = prompt_ids + completion_ids
            labels = [-100] * len(prompt_ids) + completion_ids
            if not completion_ids or all(label == -100 for label in labels):
                raise ValueError(f"empty assistant completion for {record['id']}")
            samples.append({"input_ids": input_ids, "labels": labels, "source_id": record["id"]})
            prompt_tokens += len(prompt_ids)
            target_tokens += len(completion_ids)
    if not samples:
        raise ValueError("training data has no assistant loss targets")
    return samples, {"samples": len(samples), "prompt_tokens": prompt_tokens, "target_tokens": target_tokens}


class SupervisedDataset:
    def __init__(self, samples: list[dict[str, Any]]) -> None:
        self.samples = samples

    def __len__(self) -> int:
        return len(self.samples)

    def __getitem__(self, index: int) -> dict[str, Any]:
        return self.samples[index]


def make_collator(torch: Any, pad_token_id: int):
    def collate(rows: list[dict[str, Any]]) -> dict[str, Any]:
        width = max(len(row["input_ids"]) for row in rows)
        input_ids: list[list[int]] = []
        labels: list[list[int]] = []
        attention: list[list[int]] = []
        for row in rows:
            padding = width - len(row["input_ids"])
            input_ids.append(row["input_ids"] + [pad_token_id] * padding)
            labels.append(row["labels"] + [-100] * padding)
            attention.append([1] * len(row["input_ids"]) + [0] * padding)
        return {
            "input_ids": torch.tensor(input_ids, dtype=torch.long),
            "labels": torch.tensor(labels, dtype=torch.long),
            "attention_mask": torch.tensor(attention, dtype=torch.long),
        }
    return collate


def set_determinism(torch: Any, seed: int) -> None:
    os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
    random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    torch.backends.cudnn.benchmark = False
    torch.backends.cudnn.deterministic = True
    if torch.cuda.is_available():
        # Windows CUDA otherwise selects a memory-efficient SDPA backward that
        # PyTorch explicitly reports as nondeterministic.
        torch.backends.cuda.enable_flash_sdp(False)
        torch.backends.cuda.enable_mem_efficient_sdp(False)
        torch.backends.cuda.enable_math_sdp(True)
    torch.use_deterministic_algorithms(True, warn_only=False)


def load_model(
    stack: dict[str, Any],
    model_config: dict[str, str],
    cache_dir: Path,
    device: Any,
    local_files_only: bool,
) -> tuple[Any, str]:
    torch = stack["torch"]
    dtype = torch.float32
    if device.type == "cuda":
        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    model = stack["AutoModelForCausalLM"].from_pretrained(
        model_config["id"],
        revision=model_config["revision"],
        cache_dir=str(cache_dir),
        trust_remote_code=False,
        use_safetensors=True,
        local_files_only=local_files_only,
        torch_dtype=dtype,
    )
    resolved_revision = str(getattr(model.config, "_commit_hash", "") or "")
    if resolved_revision != model_config["revision"]:
        del model
        raise RuntimeError(
            f"resolved model revision {resolved_revision!r} does not match pinned revision {model_config['revision']!r}"
        )
    model.to(device)
    return model, resolved_revision


def train_adapter(
    stack: dict[str, Any],
    model: Any,
    tokenizer: Any,
    records: list[dict[str, Any]],
    train_config: dict[str, Any],
    seed: int,
    device: Any,
    adapter_dir: Path,
) -> tuple[Any, dict[str, Any]]:
    torch = stack["torch"]
    samples, token_stats = supervised_samples(records, tokenizer, int(train_config["max_length"]))
    lora = stack["LoraConfig"](
        task_type=stack["TaskType"].CAUSAL_LM,
        r=int(train_config["lora_rank"]),
        lora_alpha=int(train_config["lora_alpha"]),
        lora_dropout=float(train_config["lora_dropout"]),
        target_modules=list(train_config["target_modules"]),
        bias="none",
    )
    model = stack["get_peft_model"](model, lora)
    if bool(train_config["gradient_checkpointing"]):
        model.gradient_checkpointing_enable()
        model.enable_input_require_grads()
    model.config.use_cache = False
    trainable = sum(parameter.numel() for parameter in model.parameters() if parameter.requires_grad)
    total = sum(parameter.numel() for parameter in model.parameters())

    generator = torch.Generator()
    generator.manual_seed(seed)
    loader = torch.utils.data.DataLoader(
        SupervisedDataset(samples),
        batch_size=int(train_config["micro_batch_size"]),
        shuffle=True,
        generator=generator,
        collate_fn=make_collator(torch, int(tokenizer.pad_token_id)),
        pin_memory=device.type == "cuda",
        num_workers=0,
    )
    optimizer = torch.optim.AdamW(
        (parameter for parameter in model.parameters() if parameter.requires_grad),
        lr=float(train_config["learning_rate"]),
        weight_decay=float(train_config["weight_decay"]),
    )
    total_steps = int(train_config["max_steps"])
    scheduler = stack["get_linear_schedule_with_warmup"](
        optimizer,
        num_warmup_steps=int(train_config["warmup_steps"]),
        num_training_steps=total_steps,
    )
    accumulation = int(train_config["gradient_accumulation_steps"])
    use_bf16 = device.type == "cuda" and torch.cuda.is_bf16_supported()
    use_fp16 = device.type == "cuda" and not use_bf16
    scaler = torch.amp.GradScaler("cuda", enabled=use_fp16)
    losses: list[float] = []
    seen_target_tokens = 0
    started = time.perf_counter()
    model.train()
    optimizer.zero_grad(set_to_none=True)
    iterator = iter(loader)
    for step in range(total_steps):
        accumulated_loss = 0.0
        for _ in range(accumulation):
            try:
                batch = next(iterator)
            except StopIteration:
                iterator = iter(loader)
                batch = next(iterator)
            batch = {key: value.to(device, non_blocking=True) for key, value in batch.items()}
            seen_target_tokens += int((batch["labels"] != -100).sum().item())
            with torch.autocast(device_type=device.type, dtype=torch.bfloat16 if use_bf16 else torch.float16, enabled=device.type == "cuda"):
                loss = model(**batch).loss / accumulation
            accumulated_loss += float(loss.detach().cpu())
            scaler.scale(loss).backward()
        scaler.unscale_(optimizer)
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        scaler.step(optimizer)
        scaler.update()
        scheduler.step()
        optimizer.zero_grad(set_to_none=True)
        losses.append(accumulated_loss)
    elapsed = time.perf_counter() - started
    if bool(train_config["gradient_checkpointing"]):
        model.gradient_checkpointing_disable()
    model.config.use_cache = True
    adapter_dir.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(adapter_dir, safe_serialization=True)
    adapter_files = sorted(path for path in adapter_dir.rglob("*") if path.is_file())
    adapter_manifest = {
        str(path.relative_to(adapter_dir)).replace("\\", "/"): file_sha256(path)
        for path in adapter_files
    }
    return model, {
        **token_stats,
        "optimizer_steps": total_steps,
        "gradient_accumulation_steps": accumulation,
        "seen_target_tokens": seen_target_tokens,
        "final_loss": losses[-1],
        "mean_loss": sum(losses) / len(losses),
        "loss_by_step": losses,
        "elapsed_seconds": elapsed,
        "target_tokens_per_second": seen_target_tokens / elapsed if elapsed else None,
        "trainable_parameters": trainable,
        "total_parameters_with_adapter": total,
        "trainable_fraction": trainable / total,
        "adapter_files_sha256": adapter_manifest,
        "adapter_tree_sha256": sha256_bytes(canonical_json(adapter_manifest).encode("utf-8")),
    }


def strip_model_text(value: str) -> str:
    return value.replace("<|im_end|>", "").replace("<|endoftext|>", "").strip()


def generate_text(torch: Any, model: Any, tokenizer: Any, messages: list[dict[str, Any]], device: Any, max_new_tokens: int) -> str:
    prompt = render_generation_prompt(messages)
    encoded = tokenizer.encode(prompt, add_special_tokens=False, return_tensors="pt").to(device)
    attention = torch.ones_like(encoded)
    terminator = tokenizer.convert_tokens_to_ids("<|im_end|>")
    eos_ids = [int(tokenizer.eos_token_id)]
    if isinstance(terminator, int) and terminator >= 0 and terminator not in eos_ids:
        eos_ids.append(terminator)
    with torch.inference_mode():
        output = model.generate(
            input_ids=encoded,
            attention_mask=attention,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            temperature=None,
            top_p=None,
            top_k=None,
            eos_token_id=eos_ids,
            pad_token_id=int(tokenizer.pad_token_id),
            use_cache=True,
        )
    return strip_model_text(tokenizer.decode(output[0, encoded.shape[1]:], skip_special_tokens=False))


def parse_tool_call(text: str) -> tuple[bool, str | None, str | None]:
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        return False, None, f"invalid_json:{error.msg}"
    if not isinstance(value, dict) or set(value) != {"name", "arguments"}:
        return False, None, "wrong_top_level_shape"
    arguments = value.get("arguments")
    if value.get("name") != "calculator" or not isinstance(arguments, dict) or set(arguments) != {"expression"}:
        return False, None, "wrong_tool_or_arguments_shape"
    expression = arguments.get("expression")
    if not isinstance(expression, str) or not expression or len(expression) > 128:
        return False, None, "invalid_expression_field"
    return True, expression, None


def safe_calculate(expression: str) -> int:
    tree = ast.parse(expression, mode="eval")
    nodes = list(ast.walk(tree))
    if len(nodes) > 32:
        raise ValueError("expression_too_complex")

    def visit(node: ast.AST) -> int:
        if isinstance(node, ast.Expression):
            return visit(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, int) and not isinstance(node.value, bool):
            if abs(node.value) > 100_000:
                raise ValueError("integer_out_of_range")
            return int(node.value)
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult)):
            left, right = visit(node.left), visit(node.right)
            result = left + right if isinstance(node.op, ast.Add) else left - right if isinstance(node.op, ast.Sub) else left * right
            if abs(result) > 10_000_000:
                raise ValueError("result_out_of_range")
            return result
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = visit(node.operand)
            return value if isinstance(node.op, ast.UAdd) else -value
        raise ValueError(f"unsupported_node:{type(node).__name__}")

    return visit(tree)


def parse_final(text: str) -> tuple[bool, int | None, str | None]:
    try:
        value = json.loads(text)
    except json.JSONDecodeError as error:
        return False, None, f"invalid_json:{error.msg}"
    if not isinstance(value, dict) or set(value) != {"answer"}:
        return False, None, "wrong_final_shape"
    answer = value["answer"]
    if not isinstance(answer, int) or isinstance(answer, bool):
        return False, None, "answer_not_integer"
    return True, answer, None


def evaluate(torch: Any, model: Any, tokenizer: Any, records: list[dict[str, Any]], config: dict[str, Any], device: Any) -> dict[str, Any]:
    model.eval()
    rows: list[dict[str, Any]] = []
    started = time.perf_counter()
    for record in records:
        context = list(record["messages"])
        evaluation = record["metadata"]["evaluation"]
        expected_expression = evaluation["expected_expression"]
        gold_answer = int(evaluation["gold_answer"])
        tool_text = generate_text(torch, model, tokenizer, context, device, int(config["max_tool_tokens"]))
        valid_tool_json, expression, tool_error = parse_tool_call(tool_text)
        direct_final_valid, direct_final_answer, direct_final_error = parse_final(tool_text)
        direct_final_accuracy = bool(direct_final_valid and direct_final_answer == gold_answer)
        tool_json_exact = bool(valid_tool_json and expression == expected_expression)
        executable = False
        outcome_correct = False
        observed: int | None = None
        execution_error: str | None = None
        final_text: str | None = tool_text if direct_final_valid else None
        final_valid = direct_final_valid
        final_answer: int | None = direct_final_answer
        final_error: str | None = direct_final_error
        if valid_tool_json and expression is not None:
            try:
                observed = safe_calculate(expression)
                executable = True
                outcome_correct = observed == gold_answer
            except (SyntaxError, ValueError) as error:
                execution_error = str(error)
        if executable:
            call_id = f"eval_{record['id']}"
            context.extend([
                {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": call_id,
                        "type": "function",
                        "function": {"name": "calculator", "arguments": compact_json({"expression": expression})},
                    }],
                },
                {"role": "tool", "name": "calculator", "tool_call_id": call_id, "content": str(observed)},
            ])
            final_text = generate_text(torch, model, tokenizer, context, device, int(config["max_final_tokens"]))
            final_valid, final_answer, final_error = parse_final(final_text)
        rows.append({
            "id": record["id"],
            "task_signature_sha256": record["metadata"]["task_signature_sha256"],
            "expected_expression": expected_expression,
            "gold_answer": gold_answer,
            "tool_response": tool_text,
            "direct_final_json_valid": direct_final_valid,
            "direct_final_parse_error": direct_final_error,
            "direct_final_answer": direct_final_answer,
            "direct_final_accuracy": direct_final_accuracy,
            "tool_json_valid": valid_tool_json,
            "tool_json_exact": tool_json_exact,
            "tool_parse_error": tool_error,
            "tool_executable": executable,
            "tool_execution_error": execution_error,
            "tool_observed_answer": observed,
            "tool_outcome_correct": outcome_correct,
            "final_response": final_text,
            "final_json_valid": final_valid,
            "final_parse_error": final_error,
            "final_answer": final_answer,
            "final_accuracy": bool(final_valid and final_answer == gold_answer),
            "end_to_end_success": bool(valid_tool_json and executable and outcome_correct and final_valid and final_answer == gold_answer),
        })
    elapsed = time.perf_counter() - started
    metric_names = (
        "tool_json_valid",
        "tool_json_exact",
        "tool_executable",
        "tool_outcome_correct",
        "direct_final_json_valid",
        "direct_final_accuracy",
        "final_json_valid",
        "final_accuracy",
        "end_to_end_success",
    )
    counts = {name: sum(1 for row in rows if row[name]) for name in metric_names}
    total = len(rows)
    return {
        "examples": total,
        "elapsed_seconds": elapsed,
        "examples_per_second": total / elapsed if elapsed else None,
        "counts": counts,
        "rates": {name: counts[name] / total for name in metric_names},
        "predictions": rows,
    }


def dependency_versions() -> dict[str, str | None]:
    names = ("torch", "transformers", "peft", "accelerate", "safetensors", "huggingface-hub", "tokenizers")
    versions: dict[str, str | None] = {}
    for name in names:
        try:
            versions[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            versions[name] = None
    return versions


def git_revision(repository: Path) -> str | None:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=repository, text=True, capture_output=True, check=False,
        )
    except OSError:
        # Minimal GPU images often omit the git executable. Source identity is
        # still bound by source_tree_hash; an unavailable convenience field
        # must not make an otherwise reproducible offline run impossible.
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def source_tree_hash(experiment_dir: Path) -> str:
    files = sorted(
        path for path in experiment_dir.rglob("*")
        if path.is_file()
        and "__pycache__" not in path.parts
        and "results" not in path.relative_to(experiment_dir).parts
        and path.suffix in {".py", ".mjs", ".json", ".txt"}
    )
    manifest = {str(path.relative_to(experiment_dir)).replace("\\", "/"): file_sha256(path) for path in files}
    return sha256_bytes(canonical_json(manifest).encode("utf-8"))


def load_stack() -> dict[str, Any]:
    import torch
    from peft import LoraConfig, TaskType, get_peft_model
    from transformers import AutoModelForCausalLM, AutoTokenizer, get_linear_schedule_with_warmup
    return {
        "torch": torch,
        "LoraConfig": LoraConfig,
        "TaskType": TaskType,
        "get_peft_model": get_peft_model,
        "AutoModelForCausalLM": AutoModelForCausalLM,
        "AutoTokenizer": AutoTokenizer,
        "get_linear_schedule_with_warmup": get_linear_schedule_with_warmup,
    }


def parse_args() -> argparse.Namespace:
    experiment_dir = Path(__file__).resolve().parent
    repository = experiment_dir.parents[1]
    default_data = repository / "work" / "ignored" / "trajectory-utility" / "data"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=experiment_dir / "config" / "smoke.json")
    parser.add_argument("--answer-only", type=Path, default=default_data / "answer-only.train.jsonl")
    parser.add_argument("--complete", type=Path, default=default_data / "complete-trajectory.train.jsonl")
    parser.add_argument("--eval", type=Path, default=default_data / "held-out.eval.jsonl")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache-dir", type=Path, default=repository / "work" / "ignored" / "trajectory-utility" / "hf-cache")
    parser.add_argument("--local-files-only", action="store_true", help="Fail closed unless the pinned snapshot is already cached")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    experiment_dir = Path(__file__).resolve().parent
    repository = experiment_dir.parents[1]
    output = require_ignored_path(args.output, repository, "output")
    cache_dir = require_ignored_path(args.cache_dir, repository, "cache-dir")
    create_fresh_output(output)
    cache_dir.mkdir(parents=True, exist_ok=True)
    os.environ["HF_HOME"] = str(cache_dir)
    if args.local_files_only:
        # The explicit from_pretrained flag does not cover PEFT's save-time
        # base-config lookup. These process-wide guards make offline mode real.
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

    config = json.loads(args.config.read_text(encoding="utf-8"))
    validation = validate_suite(args.answer_only, args.complete, args.eval)
    answer_records = read_jsonl(args.answer_only)
    complete_records = read_jsonl(args.complete)
    eval_records = read_jsonl(args.eval)
    input_paths = {
        "answer_only": args.answer_only.resolve(),
        "complete_trajectory": args.complete.resolve(),
        "evaluation": args.eval.resolve(),
    }
    config_hash = file_sha256(args.config)
    input_hashes = {name: file_sha256(path) for name, path in input_paths.items()}

    stack = load_stack()
    torch = stack["torch"]
    seed = int(config["seed"])
    set_determinism(torch, seed)
    if not torch.cuda.is_available():
        raise RuntimeError("the committed smoke configuration requires a CUDA GPU; no CPU result is emitted")
    device = torch.device("cuda")
    tokenizer = stack["AutoTokenizer"].from_pretrained(
        config["model"]["id"],
        revision=config["model"]["revision"],
        cache_dir=str(cache_dir),
        trust_remote_code=False,
        use_fast=True,
        local_files_only=args.local_files_only,
    )
    tokenizer_revision = str(getattr(tokenizer, "_commit_hash", "") or tokenizer.init_kwargs.get("_commit_hash", "") or "")
    if tokenizer_revision and tokenizer_revision != config["model"]["revision"]:
        raise RuntimeError(f"tokenizer resolved to unexpected revision {tokenizer_revision}")
    if tokenizer.pad_token_id is None:
        tokenizer.pad_token_id = tokenizer.eos_token_id

    environment = {
        "runner_version": RUNNER_VERSION,
        "python": sys.version,
        "platform": platform.platform(),
        "machine": platform.machine(),
        "dependencies": dependency_versions(),
        "cuda_available": torch.cuda.is_available(),
        "cuda_runtime": torch.version.cuda,
        "gpu": torch.cuda.get_device_name(0),
        "gpu_memory_bytes": torch.cuda.get_device_properties(0).total_memory,
        "deterministic_algorithms": torch.are_deterministic_algorithms_enabled(),
        "git_revision_at_run": git_revision(repository),
        "experiment_source_tree_sha256": source_tree_hash(experiment_dir),
        "local_files_only": args.local_files_only,
    }
    run_header = {
        "schema_version": "trajectory-utility-run/0.1",
        "status": "running",
        "seed": seed,
        "config_sha256": config_hash,
        "input_sha256": input_hashes,
        "model": config["model"],
        "validation": validation,
        "environment": environment,
    }
    atomic_json(output / "run-state.json", run_header)

    arm_results: dict[str, Any] = {}
    arm_training_records = {
        "base": None,
        "answer_only_sft": answer_records,
        "complete_trajectory_sft": complete_records,
    }
    try:
        for arm in ARM_ORDER:
            # Pair arms on the exact same RNG seed so their delta does not
            # conflate the training view with LoRA initialization or shuffle.
            arm_seed = seed
            set_determinism(torch, arm_seed)
            torch.cuda.reset_peak_memory_stats(device)
            arm_started = time.perf_counter()
            model, resolved_revision = load_model(stack, config["model"], cache_dir, device, args.local_files_only)
            training: dict[str, Any] | None = None
            records = arm_training_records[arm]
            if records is not None:
                model, training = train_adapter(
                    stack,
                    model,
                    tokenizer,
                    records,
                    config["train"],
                    arm_seed,
                    device,
                    output / "adapters" / arm,
                )
            metrics = evaluate(torch, model, tokenizer, eval_records, config["evaluation"], device)
            arm_result = {
                "arm": arm,
                "seed": arm_seed,
                "resolved_model_revision": resolved_revision,
                "arm_elapsed_seconds": time.perf_counter() - arm_started,
                "peak_gpu_memory_allocated_bytes": torch.cuda.max_memory_allocated(device),
                "peak_gpu_memory_reserved_bytes": torch.cuda.max_memory_reserved(device),
                "training": training,
                "evaluation": metrics,
            }
            arm_results[arm] = arm_result
            atomic_json(output / "arms" / arm / "result.json", arm_result)
            del model
            gc.collect()
            torch.cuda.empty_cache()

        metrics = next(iter(arm_results.values()))["evaluation"]["rates"].keys()
        deltas = {
            metric: {
                "complete_minus_base": arm_results["complete_trajectory_sft"]["evaluation"]["rates"][metric]
                - arm_results["base"]["evaluation"]["rates"][metric],
                "complete_minus_answer_only": arm_results["complete_trajectory_sft"]["evaluation"]["rates"][metric]
                - arm_results["answer_only_sft"]["evaluation"]["rates"][metric],
            }
            for metric in metrics
        }
        paired_counts: dict[str, Any] = {}
        for reference in ("base", "answer_only_sft"):
            comparison: dict[str, Any] = {}
            complete_rows = arm_results["complete_trajectory_sft"]["evaluation"]["predictions"]
            reference_rows = arm_results[reference]["evaluation"]["predictions"]
            if [row["id"] for row in complete_rows] != [row["id"] for row in reference_rows]:
                raise RuntimeError(f"held-out prediction order diverged for {reference}")
            for metric in metrics:
                pairs = [(bool(left[metric]), bool(right[metric])) for left, right in zip(complete_rows, reference_rows, strict=True)]
                comparison[metric] = {
                    "complete_only": sum(left and not right for left, right in pairs),
                    "reference_only": sum(right and not left for left, right in pairs),
                    "both": sum(left and right for left, right in pairs),
                    "neither": sum(not left and not right for left, right in pairs),
                }
            paired_counts[f"complete_vs_{reference}"] = comparison
        results = {
            "schema_version": "trajectory-utility-results/0.1",
            "claim_scope": "narrow synthetic calculator tool-use smoke evidence; not a general trajectory utility proof",
            "seed": seed,
            "model": config["model"],
            "config_sha256": config_hash,
            "input_sha256": input_hashes,
            "arms": arm_results,
            "paired_rate_deltas": deltas,
            "paired_task_counts": paired_counts,
        }
        results_path = output / "results.json"
        atomic_json(results_path, results)
        result_files = sorted(path for path in output.rglob("*") if path.is_file() and path.name != "run-state.json")
        run_manifest = {
            **run_header,
            "status": "complete",
            "results_sha256": file_sha256(results_path),
            "artifacts_sha256": {
                str(path.relative_to(output)).replace("\\", "/"): file_sha256(path)
                for path in result_files
            },
        }
        atomic_json(output / "run-state.json", run_manifest)
        print(canonical_json({"output": str(output), "results": str(results_path), "results_sha256": run_manifest["results_sha256"]}))
    except BaseException as error:
        atomic_json(output / "run-state.json", {**run_header, "status": "failed", "error_type": type(error).__name__, "error": str(error)})
        raise


if __name__ == "__main__":
    main()
