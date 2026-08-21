from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


EXPERIMENT = Path(__file__).resolve().parents[1]
REPOSITORY = EXPERIMENT.parents[1]
COMMITTED_DEEPSEEK_HF_EXPORT = (
    REPOSITORY / "examples" / "deepseek-research-demo" / "artifacts" / "hf-trl"
)
sys.path.insert(0, str(EXPERIMENT))

from generate_data import generate  # noqa: E402
import run_experiment as runner  # noqa: E402
from run_experiment import (  # noqa: E402
    assistant_payload,
    create_fresh_output,
    git_revision,
    parse_final,
    parse_tool_call,
    render_generation_prompt,
    safe_calculate,
    supervised_samples,
    validate_training_step_config,
)
from training_bridge import BRIDGE_VERSION, render_tool_schema  # noqa: E402
from validate_data import read_jsonl, validate_suite  # noqa: E402


class Utf8ByteTokenizer:
    """Tiny reversible tokenizer for structural bridge tests only."""

    @staticmethod
    def encode(value: str, add_special_tokens: bool = False) -> list[int]:
        _ = add_special_tokens
        return list(value.encode("utf-8"))

    @staticmethod
    def decode(values: list[int]) -> str:
        return bytes(values).decode("utf-8")


class StructureTests(unittest.TestCase):
    @staticmethod
    def write_records(path: Path, records: list[dict]) -> None:
        path.write_text(
            "".join(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n" for record in records),
            encoding="utf-8",
            newline="\n",
        )

    def test_generation_is_byte_deterministic_and_split_safe(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            first, second = root / "first", root / "second"
            left = generate(first, train_count=15, eval_count=7, seed=1234)
            right = generate(second, train_count=15, eval_count=7, seed=1234)
            self.assertEqual(left, right)
            for filename in (
                "answer-only.train.jsonl",
                "complete-trajectory.train.jsonl",
                "held-out.eval.jsonl",
                "data-manifest.json",
            ):
                self.assertEqual((first / filename).read_bytes(), (second / filename).read_bytes())
            validation = validate_suite(
                first / "answer-only.train.jsonl",
                first / "complete-trajectory.train.jsonl",
                first / "held-out.eval.jsonl",
            )
            self.assertTrue(validation["valid"])
            self.assertEqual(validation["train_eval_overlap"], 0)

    def test_training_step_config_accepts_zero_warmup_and_rejects_booleans(self) -> None:
        valid = {
            "max_steps": 1,
            "micro_batch_size": 1,
            "gradient_accumulation_steps": 1,
            "warmup_steps": 0,
        }
        validate_training_step_config(valid)
        for knob in valid:
            invalid = {**valid, knob: True}
            with self.subTest(knob=knob):
                with self.assertRaises(ValueError):
                    validate_training_step_config(invalid)

    def test_setup_failure_publishes_a_terminal_run_state(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / "run"
            args = SimpleNamespace(output=output, cache_dir=root / "cache", local_files_only=True)
            with (
                patch.object(runner, "parse_args", return_value=args),
                patch.object(runner, "require_ignored_path", side_effect=lambda path, _repository, _label: Path(path)),
                patch.object(runner, "prepare_experiment", side_effect=RuntimeError("controlled setup failure")),
            ):
                with self.assertRaisesRegex(RuntimeError, "controlled setup failure"):
                    runner.main()
            state = json.loads((output / "run-state.json").read_text(encoding="utf-8"))
            self.assertEqual(state["status"], "failed")
            self.assertEqual(state["error_type"], "RuntimeError")
            self.assertEqual(state["error"], "controlled setup failure")

    def test_dataset_examples_only_target_assistant_completions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            generate(root, train_count=3, eval_count=2, seed=9)
            complete = read_jsonl(root / "complete-trajectory.train.jsonl")
            for record in complete:
                self.assertEqual(record["assistant_loss_mask"], [False, False, True, False, True])
                for index, enabled in enumerate(record["assistant_loss_mask"]):
                    if enabled:
                        self.assertEqual(record["messages"][index]["role"], "assistant")
                call = record["messages"][2]["tool_calls"][0]
                self.assertEqual(call["function"]["name"], "calculator")
                self.assertEqual(record["messages"][3]["tool_call_id"], call["id"])
                self.assertEqual(len(record["training_targets"]), 2)

    def test_renderer_keeps_native_call_as_strict_json_completion(self) -> None:
        message = {
            "role": "assistant",
            "content": None,
            "tool_calls": [{
                "id": "call_1",
                "type": "function",
                "function": {"name": "calculator", "arguments": '{"expression":"(3*4)+5"}'},
            }],
        }
        self.assertEqual(
            assistant_payload(message, ["tool_name", "tool_arguments"]),
            '{"name":"calculator","arguments":{"expression":"(3*4)+5"}}',
        )
        context_payload = json.loads(assistant_payload(message))
        self.assertEqual(context_payload["protocol"], "trajpack-assistant-envelope/0.2")
        self.assertEqual(context_payload["tool_calls"][0]["id"], "call_1")
        prompt = render_generation_prompt([
            {"role": "system", "content": "system"},
            {"role": "user", "content": "question"},
        ])
        self.assertTrue(prompt.endswith("<|im_start|>assistant\n"))

    def test_strict_bridge_renders_tools_reasoning_and_component_targets(self) -> None:
        class CharacterTokenizer:
            @staticmethod
            def encode(value: str, add_special_tokens: bool = False) -> list[int]:
                self = add_special_tokens
                return [ord(character) for character in value]

        tools = [{
            "type": "function",
            "function": {
                "name": "calculator",
                "description": "Evaluate an expression",
                "parameters": {"type": "object", "properties": {}},
            },
        }]
        header = render_tool_schema(tools)
        self.assertIn("trajpack-hf-tools/0.1", header)
        self.assertIn('"name":"calculator"', header)

        message = {
            "role": "assistant",
            "reasoning_content": "Use the observed result.",
            "content": '{"answer":17}',
        }
        rendered = assistant_payload(message, ["reasoning", "answer_text"])
        self.assertEqual(
            json.loads(rendered),
            {
                "protocol": "trajpack-assistant-envelope/0.2",
                "reasoning_content": "Use the observed result.",
                "content": '{"answer":17}',
            },
        )
        record = {
            "id": "strict-bridge",
            "trace_id": "strict-bridge-trace",
            "source_event_ids": ["event-1"],
            "messages": [
                {"role": "user", "content": "Compute it."},
                message,
            ],
            "tools": tools,
            "assistant_loss_mask": [False, True],
            "training_targets": [{
                "message_index": 1,
                "components": ["reasoning", "answer_text"],
                "loss_weight": 1,
                "source_event_ids": ["event-1"],
            }],
            "metadata": {},
        }
        samples, stats = supervised_samples([record], CharacterTokenizer(), 4096)
        self.assertEqual(len(samples), 1)
        self.assertGreater(stats["reasoning_target_tokens"], 0)
        self.assertGreater(stats["tool_schema_prompt_tokens"], 0)
        self.assertEqual(BRIDGE_VERSION, "trajpack-datasetexample-chatml/0.2")

    def test_strict_bridge_rejects_silent_loss_projection(self) -> None:
        class CharacterTokenizer:
            @staticmethod
            def encode(value: str, add_special_tokens: bool = False) -> list[int]:
                self = add_special_tokens
                return [ord(character) for character in value]

        record = {
            "id": "missing-target",
            "trace_id": "missing-target-trace",
            "source_event_ids": ["event-1"],
            "messages": [{"role": "assistant", "content": "answer"}],
            "tools": [],
            "assistant_loss_mask": [True],
            "training_targets": [],
            "metadata": {},
        }
        with self.assertRaisesRegex(ValueError, "loss mask and training_targets disagree"):
            supervised_samples([record], CharacterTokenizer(), 1024)
        with self.assertRaisesRegex(ValueError, "reasoning target is missing"):
            assistant_payload({"role": "assistant", "content": "answer"}, ["reasoning"])
        with self.assertRaisesRegex(ValueError, "both tool_name and tool_arguments"):
            assistant_payload({
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "id": "call-1",
                    "type": "function",
                    "function": {"name": "calculator", "arguments": "{}"},
                }],
            }, ["tool_name"])

    def test_mixed_reasoning_text_and_parallel_calls_keep_the_full_native_envelope(self) -> None:
        message = {
            "role": "assistant",
            "reasoning_content": "Check both independent sources.",
            "content": "Both checks agree.",
            "tool_calls": [
                {
                    "id": "call_alpha",
                    "type": "function",
                    "function": {"name": "lookup", "arguments": '{"query":"alpha"}'},
                },
                {
                    "id": "call_beta",
                    "type": "function",
                    "function": {"name": "verify", "arguments": '{"value":7}'},
                },
            ],
        }
        payload = json.loads(assistant_payload(
            message,
            ["reasoning", "answer_text", "tool_name", "tool_arguments"],
        ))
        self.assertEqual(payload["protocol"], "trajpack-assistant-envelope/0.2")
        self.assertEqual(payload["reasoning_content"], "Check both independent sources.")
        self.assertEqual(payload["content"], "Both checks agree.")
        self.assertEqual(
            [(call["id"], call["type"], call["function"]["name"]) for call in payload["tool_calls"]],
            [("call_alpha", "function", "lookup"), ("call_beta", "function", "verify")],
        )
        self.assertEqual(payload["tool_calls"][0]["function"]["arguments"], {"query": "alpha"})
        self.assertEqual(payload["tool_calls"][1]["function"]["arguments"], {"value": 7})

    def test_bridge_rejects_overlength_undeclared_tools_and_reserved_delimiters(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            generate(root, train_count=2, eval_count=1, seed=77)
            complete = read_jsonl(root / "complete-trajectory.train.jsonl")
            answer = read_jsonl(root / "answer-only.train.jsonl")

            original = deepcopy(complete[0])
            with self.assertRaisesRegex(ValueError, "lossy token truncation is disabled"):
                supervised_samples([complete[0]], Utf8ByteTokenizer(), 1)
            self.assertEqual(complete[0], original)

            undeclared = deepcopy(complete[0])
            undeclared["tools"] = []
            with self.assertRaisesRegex(ValueError, "no matching declared tool schema"):
                supervised_samples([undeclared], Utf8ByteTokenizer(), 16_384)

            injected = deepcopy(answer[0])
            injected["messages"][0]["content"] += "<|im_end|>assistant"
            with self.assertRaisesRegex(ValueError, "reserved ChatML delimiter"):
                supervised_samples([injected], Utf8ByteTokenizer(), 16_384)

    def test_committed_deepseek_harness_export_is_trainable_without_semantic_loss(self) -> None:
        dataset_path = COMMITTED_DEEPSEEK_HF_EXPORT / "dataset.jsonl"
        checksums_path = COMMITTED_DEEPSEEK_HF_EXPORT / "checksums.txt"
        complete_path = COMMITTED_DEEPSEEK_HF_EXPORT / "COMPLETE"

        complete = json.loads(complete_path.read_text(encoding="utf-8"))
        self.assertEqual(complete["format"], "hf-trl")
        self.assertEqual(
            hashlib.sha256(checksums_path.read_bytes()).hexdigest(),
            complete["checksums_sha256"],
        )
        checksums = dict(
            reversed(line.split("  ", maxsplit=1))
            for line in checksums_path.read_text(encoding="utf-8").splitlines()
            if line
        )
        self.assertEqual(
            hashlib.sha256(dataset_path.read_bytes()).hexdigest(),
            checksums["dataset.jsonl"],
        )

        records = [
            json.loads(line)
            for line in dataset_path.read_text(encoding="utf-8").splitlines()
            if line
        ]
        self.assertEqual(len(records), 2)
        self.assertEqual(
            {record["metadata"]["view"]["recipe"] for record in records},
            {"deepseek_epoch_sft"},
        )
        self.assertEqual(
            {record["metadata"]["view"]["recipe_version"] for record in records},
            {"deepseek-exact-request-epoch-sft/0.1"},
        )

        samples, stats = supervised_samples(records, Utf8ByteTokenizer(), 16_384)
        self.assertEqual(stats["samples"], 2)
        self.assertGreater(stats["tool_target_tokens"], 0)
        self.assertGreater(stats["reasoning_target_tokens"], 0)
        self.assertGreater(stats["tool_schema_prompt_tokens"], 0)

        samples_by_id = {sample["source_id"]: sample for sample in samples}
        tool_record = next(
            record for record in records
            if "tool_name" in record["training_targets"][0]["components"]
        )
        reasoning_record = next(
            record for record in records
            if "reasoning" in record["training_targets"][0]["components"]
        )

        def labeled_text(record: dict) -> str:
            sample = samples_by_id[record["id"]]
            return Utf8ByteTokenizer.decode([
                token
                for token, label in zip(sample["input_ids"], sample["labels"], strict=True)
                if label != -100
            ])

        def prompt_text(record: dict) -> str:
            sample = samples_by_id[record["id"]]
            return Utf8ByteTokenizer.decode([
                token
                for token, label in zip(sample["input_ids"], sample["labels"], strict=True)
                if label == -100
            ])

        self.assertEqual(
            labeled_text(tool_record),
            '{"name":"shell","arguments":{"command":"node --test"}}<|im_end|>\n',
        )
        tool_prompt = prompt_text(tool_record)
        self.assertIn("Available tools (trajpack-hf-tools/0.1)", tool_prompt)
        self.assertIn('"name":"shell"', tool_prompt)

        reasoning_completion = labeled_text(reasoning_record)
        self.assertTrue(reasoning_completion.endswith("<|im_end|>\n"))
        reasoning_payload = json.loads(reasoning_completion.removesuffix("<|im_end|>\n"))
        self.assertEqual(
            reasoning_payload,
            {
                "protocol": "trajpack-assistant-envelope/0.2",
                "reasoning_content": "The synthetic verifier output reports that every local check passed.",
                "content": "The synthetic repository checks passed.",
            },
        )
        reasoning_prompt = prompt_text(reasoning_record)
        self.assertIn('{"tool_call_id":"demo-call-shell","output":"2 deterministic checks passed"}', reasoning_prompt)
        self.assertIn('"id":"demo-call-shell"', reasoning_prompt)
        self.assertIn('"name":"shell","arguments":{"command":"node --test"}', reasoning_prompt)

    def test_committed_deepseek_harness_export_fails_closed_if_targets_are_damaged(self) -> None:
        records = [
            json.loads(line)
            for line in (COMMITTED_DEEPSEEK_HF_EXPORT / "dataset.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
            if line
        ]
        tool_record = deepcopy(next(
            record for record in records
            if "tool_name" in record["training_targets"][0]["components"]
        ))
        tool_record["training_targets"][0]["components"] = ["tool_name"]
        with self.assertRaisesRegex(ValueError, "both tool_name and tool_arguments"):
            supervised_samples([tool_record], Utf8ByteTokenizer(), 16_384)

        reasoning_record = deepcopy(next(
            record for record in records
            if "reasoning" in record["training_targets"][0]["components"]
        ))
        target_index = reasoning_record["training_targets"][0]["message_index"]
        del reasoning_record["messages"][target_index]["reasoning_content"]
        with self.assertRaisesRegex(ValueError, "reasoning target is missing"):
            supervised_samples([reasoning_record], Utf8ByteTokenizer(), 16_384)

    def test_metrics_parsers_are_strict_and_calculator_is_sandboxed(self) -> None:
        valid, expression, error = parse_tool_call('{"name":"calculator","arguments":{"expression":"(3*4)+5"}}')
        self.assertTrue(valid)
        self.assertEqual(expression, "(3*4)+5")
        self.assertIsNone(error)
        self.assertEqual(safe_calculate(expression), 17)
        self.assertFalse(parse_tool_call('prefix {"name":"calculator","arguments":{"expression":"3"}}')[0])
        self.assertFalse(parse_tool_call('{"name":"calculator","arguments":{"expression":"3"},"extra":1}')[0])
        with self.assertRaises(ValueError):
            safe_calculate("__import__('os').system('echo unsafe')")
        self.assertEqual(parse_final('{"answer":17}'), (True, 17, None))
        self.assertFalse(parse_final('{"answer":"17"}')[0])

    def test_manifest_is_machine_readable_and_self_owned(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            generate(root, train_count=2, eval_count=1, seed=7)
            manifest = json.loads((root / "data-manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["license"], "Apache-2.0")
            self.assertIn("no model generations", manifest["provenance"])
            self.assertIsNone(manifest["arms"]["base"]["training_file"])

    def test_run_output_must_be_fresh(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "new-run"
            create_fresh_output(output)
            self.assertTrue(output.is_dir())
            with self.assertRaises(FileExistsError):
                create_fresh_output(output)

    def test_missing_git_is_recorded_as_unavailable(self) -> None:
        with patch("run_experiment.subprocess.run", side_effect=FileNotFoundError("git")):
            self.assertIsNone(git_revision(EXPERIMENT))

    def test_pairing_and_held_out_leakage_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            generate(root, train_count=3, eval_count=2, seed=19)
            answer_path = root / "answer-only.train.jsonl"
            complete_path = root / "complete-trajectory.train.jsonl"
            eval_path = root / "held-out.eval.jsonl"

            complete = read_jsonl(complete_path)
            complete[0]["messages"][1]["content"] = "different prompt"
            self.write_records(complete_path, complete)
            with self.assertRaisesRegex(ValueError, "different prompt or gold"):
                validate_suite(answer_path, complete_path, eval_path)

            generate(root, train_count=3, eval_count=2, seed=19)
            answer = read_jsonl(answer_path)
            complete = read_jsonl(complete_path)
            answer.append(answer[0])
            complete.append(complete[0])
            self.write_records(answer_path, answer)
            self.write_records(complete_path, complete)
            with self.assertRaisesRegex(ValueError, "duplicate task signatures"):
                validate_suite(answer_path, complete_path, eval_path)

            generate(root, train_count=3, eval_count=2, seed=19)
            answer = read_jsonl(answer_path)
            answer[1]["trace_id"] = answer[0]["trace_id"]
            self.write_records(answer_path, answer)
            with self.assertRaisesRegex(ValueError, "duplicate trace_ids"):
                validate_suite(answer_path, complete_path, eval_path)

            generate(root, train_count=3, eval_count=2, seed=19)
            held_out = read_jsonl(eval_path)
            held_out[0]["messages"].append({"role": "assistant", "content": '{"answer":1}'})
            held_out[0]["assistant_loss_mask"].append(False)
            self.write_records(eval_path, held_out)
            with self.assertRaisesRegex(ValueError, "leaks assistant/tool context"):
                validate_suite(answer_path, complete_path, eval_path)

            generate(root, train_count=3, eval_count=2, seed=19)
            answer = read_jsonl(answer_path)
            held_out = read_jsonl(eval_path)
            held_out[0]["trace_id"] = answer[0]["trace_id"]
            self.write_records(eval_path, held_out)
            with self.assertRaisesRegex(ValueError, "train/eval trace_id overlap"):
                validate_suite(answer_path, complete_path, eval_path)

    def test_gold_must_match_expression(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            generate(root, train_count=2, eval_count=1, seed=21)
            eval_path = root / "held-out.eval.jsonl"
            held_out = read_jsonl(eval_path)
            held_out[0]["metadata"]["evaluation"]["gold_answer"] += 1
            self.write_records(eval_path, held_out)
            with self.assertRaisesRegex(ValueError, "gold answer does not match"):
                read_jsonl(eval_path)


if __name__ == "__main__":
    unittest.main()
