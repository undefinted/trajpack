from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


EXPERIMENT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EXPERIMENT))

from generate_data import generate  # noqa: E402
from run_experiment import (  # noqa: E402
    assistant_payload,
    create_fresh_output,
    git_revision,
    parse_final,
    parse_tool_call,
    render_generation_prompt,
    safe_calculate,
)
from validate_data import read_jsonl, validate_suite  # noqa: E402


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
            assistant_payload(message),
            '{"name":"calculator","arguments":{"expression":"(3*4)+5"}}',
        )
        prompt = render_generation_prompt([
            {"role": "system", "content": "system"},
            {"role": "user", "content": "question"},
        ])
        self.assertTrue(prompt.endswith("<|im_start|>assistant\n"))

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
