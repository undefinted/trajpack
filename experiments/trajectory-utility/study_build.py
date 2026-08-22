#!/usr/bin/env python3
"""Build deterministic, split-safe trainer views for a multi-arm study.

The private task registry is an index of opaque identifiers and hashes. It is
validated but never copied into the output tree. In particular, this builder
does not add prompts, gold answers, rewards, preferences, or verifier results.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
from typing import Any, Iterable


STUDY_SPEC_VERSION = "study-build/0.1"
TASK_REGISTRY_VERSION = "study-task-registry/0.1"
VERIFIER_MANIFEST_VERSION = "study-verifier-manifest/0.1"
OUTPUT_MANIFEST_VERSION = "study-build-manifest/0.1"
ROW_BINDING_VERSION = "study-row-binding/0.1"

_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_SAFE_NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_SPLITS = {"train", "eval"}
_ROLES = {"system", "developer", "user", "assistant", "tool"}


@dataclass(frozen=True)
class ArmSpec:
    name: str
    dataset: Path


@dataclass(frozen=True)
class StudySpec:
    study_id: str
    seed: int
    task_registry: Path
    verifier_manifest: Path
    arms: tuple[ArmSpec, ...]


@dataclass(frozen=True)
class RowBinding:
    arm: str
    trace_id: str
    view_id: str
    view_sha256: str
    source_event_ids_sha256: str


@dataclass(frozen=True)
class TaskEntry:
    task_id: str
    task_signature_sha256: str
    split: str
    verifier_id: str | None
    bindings: tuple[RowBinding, ...]


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


def source_event_ids_sha256(source_event_ids: Iterable[str]) -> str:
    return sha256_bytes(canonical_json(list(source_event_ids)).encode("utf-8"))


def dataset_example_sha256(example: dict[str, Any]) -> str:
    return sha256_bytes(canonical_json(example).encode("utf-8"))


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def _object(value: Any, where: str) -> dict[str, Any]:
    _require(isinstance(value, dict), f"{where}: expected an object")
    return value


def _array(value: Any, where: str) -> list[Any]:
    _require(isinstance(value, list), f"{where}: expected an array")
    return value


def _text(value: Any, where: str) -> str:
    _require(isinstance(value, str) and bool(value), f"{where}: expected a non-empty string")
    return value


def _exact_keys(value: dict[str, Any], required: set[str], optional: set[str], where: str) -> None:
    missing = required - value.keys()
    unknown = value.keys() - required - optional
    _require(not missing, f"{where}: missing fields: {', '.join(sorted(missing))}")
    _require(not unknown, f"{where}: unknown fields: {', '.join(sorted(unknown))}")


def _sha256(value: Any, where: str) -> str:
    text = _text(value, where)
    _require(bool(_SHA256.fullmatch(text)), f"{where}: expected a lowercase SHA-256")
    return text


def _safe_name(value: Any, where: str) -> str:
    text = _text(value, where)
    _require(bool(_SAFE_NAME.fullmatch(text)), f"{where}: expected [a-z0-9][a-z0-9_-]{{0,63}}")
    return text


def _load_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(
            path.read_text(encoding="utf-8"),
            parse_constant=lambda token: (_ for _ in ()).throw(ValueError(f"non-finite JSON number: {token}")),
        )
    except json.JSONDecodeError as error:
        raise ValueError(f"{label}: invalid JSON at line {error.lineno}, column {error.colno}") from error
    return _object(value, label)


def _require_unchanged(path: Path, expected_sha256: str, label: str) -> None:
    _require(file_sha256(path) == expected_sha256, f"{label}: file changed while it was being validated")


def _validate_dataset_record(record: dict[str, Any], where: str) -> None:
    for field in (
        "id",
        "trace_id",
        "source_event_ids",
        "messages",
        "tools",
        "assistant_loss_mask",
        "training_targets",
        "reward",
        "verifier",
        "metadata",
    ):
        _require(field in record, f"{where}: missing {field}")
    _text(record["id"], f"{where}.id")
    _text(record["trace_id"], f"{where}.trace_id")
    source_ids = _array(record["source_event_ids"], f"{where}.source_event_ids")
    _require(bool(source_ids), f"{where}.source_event_ids: empty")
    _require(all(isinstance(item, str) and item for item in source_ids), f"{where}.source_event_ids: invalid value")
    messages = _array(record["messages"], f"{where}.messages")
    masks = _array(record["assistant_loss_mask"], f"{where}.assistant_loss_mask")
    _require(len(messages) == len(masks), f"{where}: assistant loss mask length mismatch")
    for index, (message_value, enabled) in enumerate(zip(messages, masks, strict=True)):
        message = _object(message_value, f"{where}.messages[{index}]")
        _require(message.get("role") in _ROLES, f"{where}.messages[{index}]: invalid role")
        _require(isinstance(enabled, bool), f"{where}.assistant_loss_mask[{index}]: expected boolean")
        _require(not enabled or message["role"] == "assistant", f"{where}: non-assistant loss target at message {index}")
    _array(record["tools"], f"{where}.tools")
    targets = _array(record["training_targets"], f"{where}.training_targets")
    for index, target_value in enumerate(targets):
        target = _object(target_value, f"{where}.training_targets[{index}]")
        message_index = target.get("message_index")
        _require(
            isinstance(message_index, int)
            and not isinstance(message_index, bool)
            and 0 <= message_index < len(messages),
            f"{where}.training_targets[{index}]: invalid message_index",
        )
        _require(
            masks[message_index] is True and messages[message_index]["role"] == "assistant",
            f"{where}.training_targets[{index}]: target is not a loss-enabled assistant message",
        )
    reward, verifier = record["reward"], record["verifier"]
    _require(reward is None or isinstance(reward, (int, float)) and not isinstance(reward, bool), f"{where}.reward: invalid value")
    _require(verifier is None or isinstance(verifier, dict), f"{where}.verifier: invalid value")
    if verifier is not None:
        _exact_keys(verifier, {"name", "version"}, set(), f"{where}.verifier")
        _text(verifier["name"], f"{where}.verifier.name")
        _text(verifier["version"], f"{where}.verifier.version")
    _require((reward is None) == (verifier is None), f"{where}: reward and verifier must be present together")
    _object(record["metadata"], f"{where}.metadata")


def _resolve(base: Path, locator: Any, where: str) -> Path:
    raw = _text(locator, where)
    path = Path(raw)
    resolved = path.resolve() if path.is_absolute() else (base / path).resolve()
    _require(resolved.is_file(), f"{where}: file does not exist: {resolved}")
    return resolved


def load_study_spec(path: Path) -> StudySpec:
    raw = _load_json(path, "study spec")
    _exact_keys(
        raw,
        {"schema_version", "study_id", "seed", "task_registry", "verifier_manifest", "arms"},
        set(),
        "study spec",
    )
    _require(raw["schema_version"] == STUDY_SPEC_VERSION, f"study spec: expected {STUDY_SPEC_VERSION}")
    study_id = _safe_name(raw["study_id"], "study spec.study_id")
    seed = raw["seed"]
    _require(isinstance(seed, int) and not isinstance(seed, bool) and 0 <= seed <= 2**63 - 1, "study spec.seed: invalid seed")
    arms: list[ArmSpec] = []
    base = path.resolve().parent
    for index, item in enumerate(_array(raw["arms"], "study spec.arms")):
        arm = _object(item, f"study spec.arms[{index}]")
        _exact_keys(arm, {"name", "dataset"}, set(), f"study spec.arms[{index}]")
        arms.append(ArmSpec(
            name=_safe_name(arm["name"], f"study spec.arms[{index}].name"),
            dataset=_resolve(base, arm["dataset"], f"study spec.arms[{index}].dataset"),
        ))
    _require(len(arms) >= 2, "study spec: at least two dataset arms are required")
    _require(len({arm.name for arm in arms}) == len(arms), "study spec: duplicate arm name")
    return StudySpec(
        study_id=study_id,
        seed=seed,
        task_registry=_resolve(base, raw["task_registry"], "study spec.task_registry"),
        verifier_manifest=_resolve(base, raw["verifier_manifest"], "study spec.verifier_manifest"),
        arms=tuple(sorted(arms, key=lambda arm: arm.name)),
    )


def load_verifier_manifest(path: Path, study_id: str) -> set[str]:
    raw = _load_json(path, "verifier manifest")
    _exact_keys(raw, {"schema_version", "study_id", "verifiers"}, set(), "verifier manifest")
    _require(raw["schema_version"] == VERIFIER_MANIFEST_VERSION, f"verifier manifest: expected {VERIFIER_MANIFEST_VERSION}")
    _require(raw["study_id"] == study_id, "verifier manifest: study_id mismatch")
    verifier_ids: list[str] = []
    for index, item in enumerate(_array(raw["verifiers"], "verifier manifest.verifiers")):
        where = f"verifier manifest.verifiers[{index}]"
        verifier = _object(item, where)
        _exact_keys(verifier, {"verifier_id", "version", "protocol", "artifact_sha256"}, set(), where)
        verifier_ids.append(_safe_name(verifier["verifier_id"], f"{where}.verifier_id"))
        _text(verifier["version"], f"{where}.version")
        _text(verifier["protocol"], f"{where}.protocol")
        _sha256(verifier["artifact_sha256"], f"{where}.artifact_sha256")
    _require(len(verifier_ids) == len(set(verifier_ids)), "verifier manifest: duplicate verifier_id")
    return set(verifier_ids)


def load_task_registry(path: Path, study_id: str, arm_names: set[str], verifier_ids: set[str]) -> tuple[TaskEntry, ...]:
    raw = _load_json(path, "task registry")
    _exact_keys(raw, {"schema_version", "study_id", "tasks"}, set(), "task registry")
    _require(raw["schema_version"] == TASK_REGISTRY_VERSION, f"task registry: expected {TASK_REGISTRY_VERSION}")
    _require(raw["study_id"] == study_id, "task registry: study_id mismatch")
    tasks: list[TaskEntry] = []
    for index, item in enumerate(_array(raw["tasks"], "task registry.tasks")):
        where = f"task registry.tasks[{index}]"
        task = _object(item, where)
        _exact_keys(
            task,
            {"task_id", "task_signature_sha256", "split", "verifier_id", "bindings"},
            set(),
            where,
        )
        task_id = _text(task["task_id"], f"{where}.task_id")
        signature = _sha256(task["task_signature_sha256"], f"{where}.task_signature_sha256")
        split = _text(task["split"], f"{where}.split")
        _require(split in _SPLITS, f"{where}.split: expected train or eval")
        verifier_id = task["verifier_id"]
        _require(verifier_id is None or isinstance(verifier_id, str) and bool(verifier_id), f"{where}.verifier_id: invalid value")
        if verifier_id is not None:
            _require(verifier_id in verifier_ids, f"{where}.verifier_id: not declared by verifier manifest")
        _require(split != "eval" or verifier_id is not None, f"{where}: eval task requires a versioned verifier")
        bindings: list[RowBinding] = []
        for binding_index, binding_item in enumerate(_array(task["bindings"], f"{where}.bindings")):
            binding_where = f"{where}.bindings[{binding_index}]"
            binding = _object(binding_item, binding_where)
            _exact_keys(
                binding,
                {"arm", "trace_id", "view_id", "view_sha256", "source_event_ids_sha256"},
                set(),
                binding_where,
            )
            arm = _safe_name(binding["arm"], f"{binding_where}.arm")
            _require(arm in arm_names, f"{binding_where}.arm: not declared by study spec")
            bindings.append(RowBinding(
                arm=arm,
                trace_id=_text(binding["trace_id"], f"{binding_where}.trace_id"),
                view_id=_text(binding["view_id"], f"{binding_where}.view_id"),
                view_sha256=_sha256(binding["view_sha256"], f"{binding_where}.view_sha256"),
                source_event_ids_sha256=_sha256(binding["source_event_ids_sha256"], f"{binding_where}.source_event_ids_sha256"),
            ))
        represented_arms = {binding.arm for binding in bindings}
        _require(represented_arms == arm_names, f"{where}: every arm must bind at least one row")
        tasks.append(TaskEntry(task_id, signature, split, verifier_id, tuple(bindings)))
    _require(bool(tasks), "task registry: no tasks")
    task_ids = [task.task_id for task in tasks]
    signatures = [task.task_signature_sha256 for task in tasks]
    _require(len(task_ids) == len(set(task_ids)), "task registry: duplicate task_id")
    _require(len(signatures) == len(set(signatures)), "task registry: duplicate task signature (including train/eval overlap)")
    splits = {task.split for task in tasks}
    _require(splits == _SPLITS, "task registry: study requires both train and eval tasks")
    train = {task.task_signature_sha256 for task in tasks if task.split == "train"}
    evaluation = {task.task_signature_sha256 for task in tasks if task.split == "eval"}
    _require(not train & evaluation, "task registry: train/eval task signature overlap")
    return tuple(sorted(tasks, key=lambda task: (task.split, task.task_signature_sha256)))


def _read_arm(path: Path, arm: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                value = json.loads(
                    line,
                    parse_constant=lambda token: (_ for _ in ()).throw(ValueError(f"non-finite JSON number: {token}")),
                )
            except json.JSONDecodeError as error:
                raise ValueError(f"arm {arm}:{line_number}: invalid JSON at column {error.colno}") from error
            record = _object(value, f"arm {arm}:{line_number}")
            _validate_dataset_record(record, f"arm {arm}:{line_number}")
            records.append(record)
    _require(bool(records), f"arm {arm}: dataset has no records")
    return records


def _binding_payload(task: TaskEntry, binding: RowBinding) -> dict[str, Any]:
    return {
        "arm": binding.arm,
        "source_event_ids_sha256": binding.source_event_ids_sha256,
        "split": task.split,
        "task_signature_sha256": task.task_signature_sha256,
        "trace_id": binding.trace_id,
        "view_id": binding.view_id,
        "view_sha256": binding.view_sha256,
    }


def _materialize_arm(
    arm: ArmSpec,
    tasks: tuple[TaskEntry, ...],
    task_registry_sha256: str,
    verifier_manifest_sha256: str,
    study_id: str,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    expected: dict[tuple[str, str], tuple[TaskEntry, RowBinding]] = {}
    task_universe: set[str] = set()
    for task in tasks:
        arm_bindings = [binding for binding in task.bindings if binding.arm == arm.name]
        _require(bool(arm_bindings), f"arm {arm.name}: task {task.task_id} has no binding")
        task_universe.add(task.task_signature_sha256)
        for binding in arm_bindings:
            key = (binding.trace_id, binding.view_id)
            _require(key not in expected, f"arm {arm.name}: duplicate registry binding for trace/view {key!r}")
            expected[key] = (task, binding)

    materialized: list[dict[str, Any]] = []
    observed: set[tuple[str, str]] = set()
    observed_tasks: set[str] = set()
    split_row_counts = {"train": 0, "eval": 0}
    for record in _read_arm(arm.dataset, arm.name):
        key = (record["trace_id"], record["id"])
        _require(key not in observed, f"arm {arm.name}: duplicate dataset trace/view {key!r}")
        observed.add(key)
        _require(key in expected, f"arm {arm.name}: unregistered trace/view {key!r}")
        task, binding = expected[key]
        _require(
            dataset_example_sha256(record) == binding.view_sha256,
            f"arm {arm.name}: compiled view hash mismatch for view {record['id']}",
        )
        actual_source_hash = source_event_ids_sha256(record["source_event_ids"])
        _require(
            actual_source_hash == binding.source_event_ids_sha256,
            f"arm {arm.name}: source binding mismatch for view {record['id']}",
        )
        metadata = record["metadata"]
        existing_signature = metadata.get("task_signature_sha256")
        _require(
            existing_signature is None or existing_signature == task.task_signature_sha256,
            f"arm {arm.name}: existing task signature conflicts for view {record['id']}",
        )
        existing_split = metadata.get("split")
        _require(
            existing_split is None or existing_split == task.split,
            f"arm {arm.name}: existing split conflicts for view {record['id']}",
        )
        _require("study_binding" not in metadata, f"arm {arm.name}: view {record['id']} already has study_binding")
        masks = record["assistant_loss_mask"]
        targets = record["training_targets"]
        if task.split == "train":
            _require(any(masks) and bool(targets), f"arm {arm.name}: train view {record['id']} has no supervised target")
        else:
            _require(not any(masks) and not targets, f"arm {arm.name}: eval view {record['id']} contains loss targets")
            roles = [message["role"] for message in record["messages"]]
            _require(bool(roles) and set(roles) <= {"system", "developer", "user"}, f"arm {arm.name}: eval view {record['id']} leaks assistant/tool context")
            _require(roles[-1] == "user", f"arm {arm.name}: eval view {record['id']} must end with a user message")
        output = deepcopy(record)
        output_metadata = output["metadata"]
        payload = _binding_payload(task, binding)
        output_metadata["task_signature_sha256"] = task.task_signature_sha256
        output_metadata["split"] = task.split
        output_metadata["study_binding"] = {
            "schema_version": ROW_BINDING_VERSION,
            "study_id": study_id,
            "binding_sha256": sha256_bytes(canonical_json(payload).encode("utf-8")),
            "task_registry_sha256": task_registry_sha256,
            "verifier_manifest_sha256": verifier_manifest_sha256,
            "verifier_id": task.verifier_id,
        }
        materialized.append(output)
        observed_tasks.add(task.task_signature_sha256)
        split_row_counts[task.split] += 1

    missing = expected.keys() - observed
    _require(not missing, f"arm {arm.name}: {len(missing)} registered rows are absent from the dataset")
    _require(observed_tasks == task_universe, f"arm {arm.name}: task universe mismatch")
    materialized.sort(key=lambda row: (
        0 if row["metadata"]["split"] == "train" else 1,
        row["metadata"]["task_signature_sha256"],
        row["trace_id"],
        row["id"],
    ))
    return materialized, {
        "row_count": len(materialized),
        "split_row_counts": split_row_counts,
        "task_count": len(observed_tasks),
    }


def _jsonl_bytes(records: Iterable[dict[str, Any]]) -> bytes:
    return b"".join((canonical_json(record) + "\n").encode("utf-8") for record in records)


def build_study(spec_path: Path, output: Path) -> dict[str, Any]:
    spec_path = spec_path.resolve()
    output = output.resolve()
    _require(spec_path.is_file(), f"study spec does not exist: {spec_path}")
    if output.exists():
        raise FileExistsError(f"study output already exists: {output}")
    spec_hash = file_sha256(spec_path)
    spec = load_study_spec(spec_path)
    _require_unchanged(spec_path, spec_hash, "study spec")
    verifier_hash = file_sha256(spec.verifier_manifest)
    verifier_ids = load_verifier_manifest(spec.verifier_manifest, spec.study_id)
    _require_unchanged(spec.verifier_manifest, verifier_hash, "verifier manifest")
    arm_names = {arm.name for arm in spec.arms}
    registry_hash = file_sha256(spec.task_registry)
    tasks = load_task_registry(spec.task_registry, spec.study_id, arm_names, verifier_ids)
    _require_unchanged(spec.task_registry, registry_hash, "task registry")
    split_assignments = [
        {"split": task.split, "task_signature_sha256": task.task_signature_sha256}
        for task in sorted(tasks, key=lambda item: item.task_signature_sha256)
    ]

    materialized: dict[str, tuple[bytes, dict[str, Any]]] = {}
    arm_manifest: dict[str, Any] = {}
    for arm in spec.arms:
        input_hash = file_sha256(arm.dataset)
        records, counts = _materialize_arm(arm, tasks, registry_hash, verifier_hash, spec.study_id)
        _require_unchanged(arm.dataset, input_hash, f"arm {arm.name}")
        content = _jsonl_bytes(records)
        filename = f"{arm.name}.trainer.jsonl"
        materialized[filename] = (content, counts)
        arm_manifest[arm.name] = {
            "input_dataset_sha256": input_hash,
            "output_file": filename,
            "output_sha256": sha256_bytes(content),
            **counts,
        }

    task_counts = {
        "total": len(tasks),
        "train": sum(task.split == "train" for task in tasks),
        "eval": sum(task.split == "eval" for task in tasks),
    }
    manifest = {
        "schema_version": OUTPUT_MANIFEST_VERSION,
        "builder_version": STUDY_SPEC_VERSION,
        "study_id": spec.study_id,
        "seed": spec.seed,
        "study_spec_sha256": spec_hash,
        "task_registry_sha256": registry_hash,
        "verifier_manifest_sha256": verifier_hash,
        "task_universe": {
            "counts": task_counts,
            "signature_set_sha256": sha256_bytes(canonical_json(sorted(task.task_signature_sha256 for task in tasks)).encode("utf-8")),
            "split_assignment_sha256": sha256_bytes(canonical_json(split_assignments).encode("utf-8")),
            "train_eval_overlap": 0,
        },
        "arms": arm_manifest,
        "privacy": {
            "private_task_registry_embedded": False,
            "verifier_manifest_embedded": False,
            "registry_prompt_or_label_fields_added": 0,
        },
        "label_policy": {
            "rewards_invented": False,
            "preference_pairs_invented": False,
            "verifier_results_invented": False,
        },
        "checksums_file": "checksums.sha256",
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{output.name}.tmp-", dir=output.parent))
    try:
        for filename, (content, _) in sorted(materialized.items()):
            (temporary / filename).write_bytes(content)
        manifest_bytes = (canonical_json(manifest) + "\n").encode("utf-8")
        (temporary / "study-manifest.json").write_bytes(manifest_bytes)
        checksums = {
            filename: sha256_bytes(content)
            for filename, (content, _) in materialized.items()
        }
        checksums["study-manifest.json"] = sha256_bytes(manifest_bytes)
        checksums_text = "".join(f"{digest}  {filename}\n" for filename, digest in sorted(checksums.items()))
        (temporary / "checksums.sha256").write_text(checksums_text, encoding="utf-8", newline="\n")
        os.replace(temporary, output)
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", type=Path, required=True, help=f"{STUDY_SPEC_VERSION} JSON file")
    parser.add_argument("--out", type=Path, required=True, help="fresh output directory")
    args = parser.parse_args()
    manifest = build_study(args.spec, args.out)
    print(canonical_json({
        "output": str(args.out.resolve()),
        "schema_version": manifest["schema_version"],
        "study_id": manifest["study_id"],
        "task_counts": manifest["task_universe"]["counts"],
    }))


if __name__ == "__main__":
    main()
