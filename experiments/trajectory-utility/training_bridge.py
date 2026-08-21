"""Strict, deterministic DatasetExample -> ChatML supervision bridge.

The exporter owns semantic selection.  This bridge owns the last-mile contract:
tool schemas must be visible to the model, every enabled assistant message must
have one explicit component target, and unsupported/lossy projections fail.
"""

from __future__ import annotations

import json
from typing import Any, Iterable

from validate_data import validate_dataset_example


BRIDGE_VERSION = "trajpack-datasetexample-chatml/0.2"
TOOLS_SCHEMA_VERSION = "trajpack-hf-tools/0.1"
ASSISTANT_ENVELOPE_VERSION = "trajpack-assistant-envelope/0.2"
SUPPORTED_COMPONENTS = {"answer_text", "reasoning", "tool_name", "tool_arguments", "plan"}
RESERVED_CHATML_TOKENS = ("<|im_start|>", "<|im_end|>", "<|endoftext|>")


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def compact_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _reject_reserved_tokens(value: Any, where: str) -> None:
    if isinstance(value, str):
        if any(token in value for token in RESERVED_CHATML_TOKENS):
            raise ValueError(f"{where} contains a reserved ChatML delimiter")
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            _reject_reserved_tokens(item, f"{where}[{index}]")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            _reject_reserved_tokens(key, f"{where}.key")
            _reject_reserved_tokens(item, f"{where}.{key}")


def _tool_calls(message: dict[str, Any]) -> list[dict[str, Any]]:
    calls = message.get("tool_calls")
    if calls is None:
        return []
    if not isinstance(calls, list) or not calls:
        raise ValueError("assistant tool_calls must be a non-empty list")
    normalized: list[dict[str, Any]] = []
    for call in calls:
        if not isinstance(call, dict) or not isinstance(call.get("function"), dict):
            raise ValueError("assistant tool call is malformed")
        function = call["function"]
        name, arguments = function.get("name"), function.get("arguments")
        if not isinstance(name, str) or not name:
            raise ValueError("assistant tool call is missing a function name")
        if not isinstance(arguments, str):
            raise ValueError("assistant tool arguments must be canonical JSON text")
        try:
            parsed_arguments = json.loads(arguments)
        except json.JSONDecodeError as error:
            raise ValueError("assistant tool arguments are not valid JSON") from error
        if not isinstance(parsed_arguments, dict):
            raise ValueError("assistant tool arguments must decode to a JSON object")
        call_id, call_type = call.get("id"), call.get("type")
        if not isinstance(call_id, str) or not call_id or call_type != "function":
            raise ValueError("assistant tool call requires an id and type=function")
        normalized.append({
            "id": call_id,
            "type": "function",
            "function": {"name": name, "arguments": parsed_arguments},
        })
    return normalized


def _target_call_projection(call: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": call["function"]["name"],
        "arguments": call["function"]["arguments"],
    }


def assistant_payload(message: dict[str, Any], components: Iterable[str] | None = None) -> str:
    selected = None if components is None else set(components)
    if selected is not None:
        unsupported = selected - SUPPORTED_COMPONENTS
        if unsupported or not selected:
            raise ValueError(f"unsupported or empty training components: {sorted(unsupported)}")

    calls = _tool_calls(message)
    has_tool_target = selected is not None and bool(selected & {"tool_name", "tool_arguments"})
    if has_tool_target and not {"tool_name", "tool_arguments"} <= selected:
        raise ValueError("tool supervision requires both tool_name and tool_arguments")
    include_calls = bool(calls) and (selected is None or has_tool_target)
    include_reasoning = selected is None or "reasoning" in selected
    include_answer = selected is None or "answer_text" in selected
    include_plan = selected is not None and "plan" in selected
    reasoning = message.get("reasoning_content")
    content = message.get("content")

    if selected is not None and "reasoning" in selected and (not isinstance(reasoning, str) or not reasoning):
        raise ValueError("reasoning target is missing reasoning_content")
    if selected is not None and ("answer_text" in selected or "plan" in selected) and (not isinstance(content, str) or not content):
        raise ValueError("text target is missing assistant content")
    if has_tool_target and not calls:
        raise ValueError("tool target is missing native tool_calls")

    # Preserve the established single-call target used by the calculator
    # evaluator only when it is genuinely the entire selected target. Context
    # and mixed targets use a versioned envelope that retains ids and all calls.
    selected_text = selected is not None and bool(selected & {"answer_text", "plan"})
    selected_reasoning = selected is not None and "reasoning" in selected
    if selected is not None and include_calls and len(calls) == 1 and not selected_text and not selected_reasoning:
        return compact_json(_target_call_projection(calls[0]))

    payload: dict[str, Any] = {}
    if include_reasoning and isinstance(reasoning, str) and reasoning:
        payload["reasoning_content"] = reasoning
    if include_calls:
        payload["tool_calls"] = calls
    if include_plan and isinstance(content, str):
        payload["plan"] = content
    elif include_answer and isinstance(content, str):
        # Plain answer-only targets retain their native text, including JSON
        # answers.  The wrapper is needed only when another component coexists.
        if not payload:
            return content
        payload["content"] = content
    if payload:
        payload = {"protocol": ASSISTANT_ENVELOPE_VERSION, **payload}
        return compact_json(payload)
    if selected is None and isinstance(content, str):
        return content
    raise ValueError("assistant message has no renderable selected component")


def message_payload(message: dict[str, Any]) -> str:
    role = message["role"]
    if role == "assistant":
        return assistant_payload(message)
    if role == "tool":
        call_id = message.get("tool_call_id")
        if not isinstance(call_id, str) or not call_id:
            raise ValueError("tool message is missing tool_call_id")
        content = message.get("content")
        if not isinstance(content, str):
            raise ValueError("tool message content must be text")
        return compact_json({"tool_call_id": call_id, "output": content})
    content = message.get("content")
    if not isinstance(content, str):
        raise ValueError(f"{role} message content must be text")
    return content


def render_message(message: dict[str, Any]) -> str:
    return f"<|im_start|>{message['role']}\n{message_payload(message)}<|im_end|>\n"


def render_tool_schema(tools: list[dict[str, Any]]) -> str:
    if not tools:
        return ""
    return render_message({
        "role": "system",
        "content": (
            f"Available tools ({TOOLS_SCHEMA_VERSION}). Calls must conform to this canonical schema:\n"
            f"{canonical_json(tools)}"
        ),
    })


def validate_tool_schemas(tools: list[dict[str, Any]], where: str) -> set[str]:
    names: set[str] = set()
    for index, tool in enumerate(tools):
        if not isinstance(tool, dict) or tool.get("type") != "function" or not isinstance(tool.get("function"), dict):
            raise ValueError(f"{where}: malformed tool schema at {index}")
        function = tool["function"]
        name, parameters = function.get("name"), function.get("parameters")
        if not isinstance(name, str) or not name or name in names or not isinstance(parameters, dict):
            raise ValueError(f"{where}: invalid or duplicate tool schema at {index}")
        names.add(name)
    return names


def render_generation_prompt(messages: Iterable[dict[str, Any]], tools: list[dict[str, Any]] | None = None) -> str:
    return render_tool_schema(tools or []) + "".join(render_message(message) for message in messages) + "<|im_start|>assistant\n"


def validate_chatml_tokenizer(tokenizer: Any) -> None:
    converter = getattr(tokenizer, "convert_tokens_to_ids", None)
    if converter is None:
        return
    unknown = getattr(tokenizer, "unk_token_id", None)
    for token in RESERVED_CHATML_TOKENS:
        token_id = converter(token)
        encoded = tokenizer.encode(token, add_special_tokens=False)
        if not isinstance(token_id, int) or token_id < 0 or token_id == unknown or encoded != [token_id]:
            raise ValueError(f"tokenizer does not register {token} as one exact special token")


def target_for_message(record: dict[str, Any], message_index: int) -> dict[str, Any]:
    targets = [target for target in record.get("training_targets", []) if target.get("message_index") == message_index]
    if len(targets) != 1:
        raise ValueError(f"{record.get('id', '<unknown>')}: enabled assistant message {message_index} requires exactly one training target")
    target = targets[0]
    weight = target.get("loss_weight", 1)
    if not isinstance(weight, (int, float)) or isinstance(weight, bool) or float(weight) != 1.0:
        raise ValueError("the smoke trainer supports only loss_weight=1")
    components = target.get("components")
    if not isinstance(components, list) or not all(isinstance(value, str) for value in components):
        raise ValueError("training target components are malformed")
    return target


def supervised_samples(
    records: list[dict[str, Any]], tokenizer: Any, max_length: int,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    samples: list[dict[str, Any]] = []
    prompt_tokens = 0
    target_tokens = 0
    reasoning_target_tokens = 0
    tool_target_tokens = 0
    tool_schema_prompt_tokens = 0
    if not isinstance(max_length, int) or isinstance(max_length, bool) or max_length < 1:
        raise ValueError("max_length must be a positive integer")
    validate_chatml_tokenizer(tokenizer)
    for record in records:
        validate_dataset_example(record, str(record.get("id", "<unknown>")))
        _reject_reserved_tokens(record.get("messages"), f"{record['id']}.messages")
        _reject_reserved_tokens(record.get("tools"), f"{record['id']}.tools")
        messages = record["messages"]
        tools = record.get("tools", [])
        if not isinstance(tools, list):
            raise ValueError(f"{record['id']}: tools must be a list")
        declared_tools = validate_tool_schemas(tools, str(record["id"]))
        masks = record["assistant_loss_mask"]
        if len(messages) != len(masks):
            raise ValueError(f"{record['id']}: assistant loss mask length mismatch")
        enabled_indexes = {index for index, enabled in enumerate(masks) if enabled}
        target_indexes = {target.get("message_index") for target in record.get("training_targets", [])}
        if enabled_indexes != target_indexes:
            raise ValueError(f"{record['id']}: assistant loss mask and training_targets disagree")
        tool_header_ids = tokenizer.encode(render_tool_schema(tools), add_special_tokens=False)
        for index in sorted(enabled_indexes):
            message = messages[index]
            if message.get("role") != "assistant":
                raise ValueError(f"{record['id']}: loss target {index} is not an assistant message")
            target = target_for_message(record, index)
            components = target["components"]
            calls = _tool_calls(message)
            if calls and any(call["function"]["name"] not in declared_tools for call in calls):
                raise ValueError(f"{record['id']}: assistant call has no matching declared tool schema")
            prompt = render_generation_prompt(messages[:index], tools)
            completion = assistant_payload(message, components) + "<|im_end|>\n"
            prompt_ids = tokenizer.encode(prompt, add_special_tokens=False)
            completion_ids = tokenizer.encode(completion, add_special_tokens=False)
            if len(prompt_ids) + len(completion_ids) > max_length:
                raise ValueError(f"sample for {record['id']} exceeds max_length; lossy token truncation is disabled")
            input_ids = prompt_ids + completion_ids
            labels = [-100] * len(prompt_ids) + completion_ids
            if not completion_ids or all(label == -100 for label in labels):
                raise ValueError(f"empty assistant completion for {record['id']}")
            samples.append({"input_ids": input_ids, "labels": labels, "source_id": record["id"]})
            prompt_tokens += len(prompt_ids)
            target_tokens += len(completion_ids)
            tool_schema_prompt_tokens += len(tool_header_ids)
            if "reasoning" in components:
                reasoning_target_tokens += len(tokenizer.encode(str(message["reasoning_content"]), add_special_tokens=False))
            if "tool_name" in components or "tool_arguments" in components:
                tool_target_tokens += len(tokenizer.encode(
                    compact_json([_target_call_projection(call) for call in calls]),
                    add_special_tokens=False,
                ))
    if not samples:
        raise ValueError("training data has no assistant loss targets")
    return samples, {
        "samples": len(samples),
        "prompt_tokens": prompt_tokens,
        "target_tokens": target_tokens,
        "reasoning_target_tokens": reasoning_target_tokens,
        "tool_target_tokens": tool_target_tokens,
        "tool_schema_prompt_tokens": tool_schema_prompt_tokens,
    }
