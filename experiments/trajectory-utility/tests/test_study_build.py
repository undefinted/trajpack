from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path


EXPERIMENT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EXPERIMENT))

from study_build import (  # noqa: E402
    OUTPUT_MANIFEST_VERSION,
    ROW_BINDING_VERSION,
    build_study,
    canonical_json,
    dataset_example_sha256,
    source_event_ids_sha256,
)


class StudyBuildTests(unittest.TestCase):
    @staticmethod
    def write_json(path: Path, value: object) -> None:
        path.write_text(canonical_json(value) + "\n", encoding="utf-8", newline="\n")

    @staticmethod
    def write_jsonl(path: Path, values: list[dict]) -> None:
        path.write_text(
            "".join(canonical_json(value) + "\n" for value in values),
            encoding="utf-8",
            newline="\n",
        )

    @staticmethod
    def record(view_id: str, trace_id: str, source_ids: list[str], content: str, *, evaluation: bool = False) -> dict:
        record = {
            "id": view_id,
            "trace_id": trace_id,
            "source_event_ids": source_ids,
            "messages": [
                {"role": "user", "content": content},
                {"role": "assistant", "content": "authorized visible output"},
            ],
            "tools": [],
            "assistant_loss_mask": [False, True],
            "training_targets": [{"message_index": 1, "components": ["answer_text"]}],
            "metadata": {"view": {"recipe": "fixture"}},
            "reward": None,
            "verifier": None,
        }
        if evaluation:
            record["messages"] = [{"role": "user", "content": content}]
            record["assistant_loss_mask"] = [False]
            record["training_targets"] = []
        return record

    def fixture(self, root: Path) -> tuple[Path, dict, dict[str, list[dict]]]:
        train_signature = hashlib.sha256(b"private-train-task").hexdigest()
        eval_signature = hashlib.sha256(b"private-eval-task").hexdigest()
        arms = {
            "answer_only": [
                self.record("answer-train-epoch-1", "trace-train", ["event-u", "event-a1"], "train input"),
                self.record("answer-train-epoch-2", "trace-train", ["event-u", "event-a1", "event-a2"], "train input"),
                self.record("answer-eval", "trace-eval-a", ["event-eval-a"], "eval input", evaluation=True),
            ],
            "complete": [
                self.record("complete-train", "trace-train", ["event-u", "event-tool", "event-final"], "train input"),
                self.record("complete-eval", "trace-eval-c", ["event-eval-c"], "eval input", evaluation=True),
            ],
        }
        for arm, rows in arms.items():
            self.write_jsonl(root / f"{arm}.jsonl", rows)

        registry = {
            "schema_version": "study-task-registry/0.1",
            "study_id": "fixture_study",
            "tasks": [
                {
                    "task_id": "opaque-task-01",
                    "task_signature_sha256": train_signature,
                    "split": "train",
                    "verifier_id": None,
                    "bindings": [
                        {
                            "arm": arm,
                            "trace_id": row["trace_id"],
                            "view_id": row["id"],
                            "view_sha256": dataset_example_sha256(row),
                            "source_event_ids_sha256": source_event_ids_sha256(row["source_event_ids"]),
                        }
                        for arm, rows in arms.items()
                        for row in rows
                        if "train" in row["id"]
                    ],
                },
                {
                    "task_id": "opaque-task-02",
                    "task_signature_sha256": eval_signature,
                    "split": "eval",
                    "verifier_id": "owned_verifier",
                    "bindings": [
                        {
                            "arm": arm,
                            "trace_id": row["trace_id"],
                            "view_id": row["id"],
                            "view_sha256": dataset_example_sha256(row),
                            "source_event_ids_sha256": source_event_ids_sha256(row["source_event_ids"]),
                        }
                        for arm, rows in arms.items()
                        for row in rows
                        if "eval" in row["id"]
                    ],
                },
            ],
        }
        verifier = {
            "schema_version": "study-verifier-manifest/0.1",
            "study_id": "fixture_study",
            "verifiers": [{
                "verifier_id": "owned_verifier",
                "version": "fixture/1",
                "protocol": "local-executable/0.1",
                "artifact_sha256": hashlib.sha256(b"owned verifier artifact").hexdigest(),
            }],
        }
        self.write_json(root / "task-registry.json", registry)
        self.write_json(root / "verifier-manifest.json", verifier)
        spec = {
            "schema_version": "study-build/0.1",
            "study_id": "fixture_study",
            "seed": 3407,
            "task_registry": "task-registry.json",
            "verifier_manifest": "verifier-manifest.json",
            "arms": [
                {"name": "complete", "dataset": "complete.jsonl"},
                {"name": "answer_only", "dataset": "answer_only.jsonl"},
            ],
        }
        self.write_json(root / "study.json", spec)
        return root / "study.json", registry, arms

    def test_build_is_deterministic_and_allows_multiple_epochs_per_trace(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            spec_path, _, _ = self.fixture(root)
            first = build_study(spec_path, root / "out-1")
            second = build_study(spec_path, root / "out-2")

            self.assertEqual(first, second)
            self.assertEqual(first["schema_version"], OUTPUT_MANIFEST_VERSION)
            self.assertEqual(first["task_universe"]["counts"], {"total": 2, "train": 1, "eval": 1})
            self.assertEqual(first["task_universe"]["train_eval_overlap"], 0)
            self.assertEqual(first["arms"]["answer_only"]["row_count"], 3)
            self.assertEqual(first["arms"]["complete"]["row_count"], 2)
            self.assertEqual(first["arms"]["answer_only"]["task_count"], 2)

            for filename in ("answer_only.trainer.jsonl", "complete.trainer.jsonl", "study-manifest.json", "checksums.sha256"):
                self.assertEqual((root / "out-1" / filename).read_bytes(), (root / "out-2" / filename).read_bytes())

            rows = [
                json.loads(line)
                for line in (root / "out-1" / "answer_only.trainer.jsonl").read_text(encoding="utf-8").splitlines()
            ]
            train_rows = [row for row in rows if row["metadata"]["split"] == "train"]
            self.assertEqual(len(train_rows), 2)
            self.assertEqual({row["trace_id"] for row in train_rows}, {"trace-train"})
            for row in rows:
                binding = row["metadata"]["study_binding"]
                self.assertEqual(binding["schema_version"], ROW_BINDING_VERSION)
                self.assertEqual(binding["task_registry_sha256"], first["task_registry_sha256"])
                self.assertEqual(binding["verifier_manifest_sha256"], first["verifier_manifest_sha256"])
                self.assertNotIn("task_id", binding)
                self.assertIsNone(row["reward"])
                self.assertIsNone(row["verifier"])

            checksums = {
                filename: digest
                for digest, filename in (
                    line.split("  ", maxsplit=1)
                    for line in (root / "out-1" / "checksums.sha256").read_text(encoding="utf-8").splitlines()
                )
            }
            for filename, digest in checksums.items():
                self.assertEqual(hashlib.sha256((root / "out-1" / filename).read_bytes()).hexdigest(), digest)

    def test_missing_row_and_content_or_source_binding_mismatch_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            spec_path, _, arms = self.fixture(root)
            self.write_jsonl(root / "complete.jsonl", arms["complete"][:-1])
            with self.assertRaisesRegex(ValueError, "registered rows are absent"):
                build_study(spec_path, root / "missing-output")

            self.fixture(root)
            damaged = deepcopy(arms["complete"])
            damaged[0]["messages"][0]["content"] = "silently changed input"
            self.write_jsonl(root / "complete.jsonl", damaged)
            with self.assertRaisesRegex(ValueError, "compiled view hash mismatch"):
                build_study(spec_path, root / "view-mismatch-output")

            self.fixture(root)
            damaged = deepcopy(arms["complete"])
            damaged[0]["source_event_ids"].append("unregistered-event")
            registry = json.loads((root / "task-registry.json").read_text(encoding="utf-8"))
            binding = next(
                item
                for task in registry["tasks"]
                for item in task["bindings"]
                if item["arm"] == "complete" and item["view_id"] == damaged[0]["id"]
            )
            binding["view_sha256"] = dataset_example_sha256(damaged[0])
            self.write_json(root / "task-registry.json", registry)
            self.write_jsonl(root / "complete.jsonl", damaged)
            with self.assertRaisesRegex(ValueError, "source binding mismatch"):
                build_study(spec_path, root / "mismatch-output")

    def test_task_universe_split_and_private_registry_fields_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            spec_path, registry, _ = self.fixture(root)

            missing_arm = deepcopy(registry)
            missing_arm["tasks"][0]["bindings"] = [
                binding for binding in missing_arm["tasks"][0]["bindings"] if binding["arm"] != "complete"
            ]
            self.write_json(root / "task-registry.json", missing_arm)
            with self.assertRaisesRegex(ValueError, "every arm must bind"):
                build_study(spec_path, root / "universe-output")

            self.fixture(root)
            overlap = deepcopy(registry)
            overlap["tasks"][1]["task_signature_sha256"] = overlap["tasks"][0]["task_signature_sha256"]
            self.write_json(root / "task-registry.json", overlap)
            with self.assertRaisesRegex(ValueError, "train/eval overlap"):
                build_study(spec_path, root / "overlap-output")

            self.fixture(root)
            leaked = deepcopy(registry)
            leaked["tasks"][0]["prompt"] = "a private prompt must not be accepted by this index"
            self.write_json(root / "task-registry.json", leaked)
            with self.assertRaisesRegex(ValueError, "unknown fields: prompt"):
                build_study(spec_path, root / "leak-output")

    def test_existing_split_signature_and_verifier_conflicts_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            spec_path, registry, arms = self.fixture(root)
            conflicting = deepcopy(arms["complete"])
            conflicting[0]["metadata"]["split"] = "eval"
            binding = next(
                item
                for task in registry["tasks"]
                for item in task["bindings"]
                if item["arm"] == "complete" and item["view_id"] == conflicting[0]["id"]
            )
            binding["view_sha256"] = dataset_example_sha256(conflicting[0])
            self.write_json(root / "task-registry.json", registry)
            self.write_jsonl(root / "complete.jsonl", conflicting)
            with self.assertRaisesRegex(ValueError, "existing split conflicts"):
                build_study(spec_path, root / "split-output")

            self.fixture(root)
            invalid_verifier = deepcopy(registry)
            invalid_verifier["tasks"][1]["verifier_id"] = "undeclared_verifier"
            self.write_json(root / "task-registry.json", invalid_verifier)
            with self.assertRaisesRegex(ValueError, "not declared by verifier manifest"):
                build_study(spec_path, root / "verifier-output")

            self.fixture(root)
            malformed_label = deepcopy(arms["complete"])
            malformed_label[0]["reward"] = 1
            malformed_label[0]["verifier"] = {"name": "", "version": "fixture/1"}
            self.write_jsonl(root / "complete.jsonl", malformed_label)
            with self.assertRaisesRegex(ValueError, "verifier.name: expected a non-empty string"):
                build_study(spec_path, root / "malformed-label-output")

    def test_versioned_json_schemas_are_machine_readable_and_strict(self) -> None:
        schemas = EXPERIMENT / "schemas"
        expected = {
            "study-build-0.1.schema.json": "study-build/0.1",
            "study-build-manifest-0.1.schema.json": "study-build-manifest/0.1",
            "study-task-registry-0.1.schema.json": "study-task-registry/0.1",
            "study-verifier-manifest-0.1.schema.json": "study-verifier-manifest/0.1",
        }
        for filename, version in expected.items():
            with self.subTest(filename=filename):
                schema = json.loads((schemas / filename).read_text(encoding="utf-8"))
                self.assertFalse(schema["additionalProperties"])
                self.assertEqual(schema["properties"]["schema_version"]["const"], version)


if __name__ == "__main__":
    unittest.main()
