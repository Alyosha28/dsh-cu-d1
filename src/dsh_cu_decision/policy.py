from __future__ import annotations

from collections.abc import Mapping
from typing import Any


TARGET_HEADS = {
    "CLICK": ("click_target", "click"),
    "TYPE_TEXT": ("type_text_target", "type"),
    "PASTE_TEXT": ("paste_text_target", "paste"),
    "INCREMENT": ("increment_target", "increment"),
    "DECREMENT": ("decrement_target", "decrement"),
}
TERMINAL_OPERATIONS = ("WAIT", "DONE", "BLOCKED")
TEXT_STRATEGIES = ("speculative", "on-demand")
OPERATION_DESCRIPTIONS = {
    "CLICK": "Click one visible, enabled element.",
    "TYPE_TEXT": "Enter the text already specified in the goal into a text field.",
    "PASTE_TEXT": "Paste the text already specified in the goal into a document or text field.",
    "INCREMENT": "Increment a numeric spinbutton by one step.",
    "DECREMENT": "Decrement a numeric spinbutton by one step.",
    "SCROLL_UP": "Scroll up to reveal earlier content.",
    "SCROLL_DOWN": "Scroll down to reveal more content.",
    "WAIT": "Wait because the current state is loading or changing.",
    "DONE": "The goal is already satisfied by the current observed state.",
    "BLOCKED": "No safe available action can make progress toward the goal.",
}


class DecisionError(ValueError):
    """The model response cannot be executed under the observed action space."""


def element_label(element: Mapping[str, Any]) -> str:
    parts = [str(element.get("role", "element"))]
    if element.get("name"):
        parts.append(str(element["name"]))
    if element.get("value") not in (None, ""):
        parts.append(f"value={element['value']}")
    if element.get("enabled") is False:
        parts.append("disabled")
    if element.get("focused"):
        parts.append("focused")
    return " · ".join(parts)


def candidate_elements(state: Mapping[str, Any], action: str) -> list[Mapping[str, Any]]:
    return [
        element
        for element in state.get("elements", [])
        if element.get("visible", True)
        and element.get("enabled", True)
        and action in element.get("actions", [])
    ]


def available_operations(state: Mapping[str, Any]) -> list[str]:
    operations = [op for op, (_, action) in TARGET_HEADS.items() if candidate_elements(state, action)]
    if state.get("can_scroll_up"):
        operations.append("SCROLL_UP")
    if state.get("can_scroll_down"):
        operations.append("SCROLL_DOWN")
    operations.extend(TERMINAL_OPERATIONS)
    return operations


def text_value_question(element: Mapping[str, Any]) -> dict[str, str]:
    return {
        "type": "text",
        "instructions": (
            f"If text is entered into the {element_label(element)} field, what exact literal "
            "value should be entered? Extract only text explicitly supplied by the goal or "
            "structured inputs in the state. Do not invent or paraphrase a value."
        ),
    }


def text_question_for_target(
    state: Mapping[str, Any], target: str, operation: str = "TYPE_TEXT"
) -> dict[str, str]:
    if operation not in {"TYPE_TEXT", "PASTE_TEXT"}:
        raise ValueError(f"Text extraction is unavailable for {operation}")
    action = TARGET_HEADS[operation][1]
    for element in candidate_elements(state, action):
        if str(element["id"]) == target:
            return text_value_question(element)
    raise DecisionError(f"Target {target!r} is not valid for {operation}")


def build_questions(
    state: Mapping[str, Any], text_strategy: str = "speculative", visual: bool = False
) -> dict[str, dict[str, Any]]:
    """Build one operation head and compatible target/text heads."""
    if text_strategy not in TEXT_STRATEGIES:
        raise ValueError(f"Unknown text strategy: {text_strategy}")
    questions: dict[str, dict[str, Any]] = {}
    operations = available_operations(state)
    questions["operation"] = {
        "type": "choice",
        "instructions": (
            "For the goal in the state, choose the single best next UI operation. "
            "When the goal requires entering or replacing text, choose a compatible text operation directly. "
            "Use PASTE_TEXT for document bodies and multiline text; use TYPE_TEXT for directly writable fields. "
            "Use DONE only when the current state proves the goal is satisfied. "
            "Use BLOCKED when no available safe action can make progress."
        ),
        "criteria": {operation: OPERATION_DESCRIPTIONS[operation] for operation in operations},
    }
    for operation, (head, action) in TARGET_HEADS.items():
        candidates = candidate_elements(state, action)
        if not candidates:
            continue
        questions[head] = {
            "type": "choice",
            "instructions": (
                f"If the selected operation is {operation}, which observed element should receive it? "
                "Choose only from these candidates from the current snapshot."
            ),
            "criteria": {str(element["id"]): element_label(element) for element in candidates},
        }
        if operation in {"TYPE_TEXT", "PASTE_TEXT"} and text_strategy == "speculative":
            for element in candidates:
                element_id = str(element["id"])
                questions[f"{operation.lower()}_value__{element_id}"] = text_value_question(element)
    if visual:
        if "CLICK" not in operations:
            operations.append("CLICK")
        visual_text_operations = ["TYPE_TEXT"]
        if str(state.get("url", "")).startswith("app://"):
            visual_text_operations.append("PASTE_TEXT")
        for text_operation in visual_text_operations:
            if text_operation not in operations:
                operations.append(text_operation)
        questions["operation"]["criteria"] = {
            operation: OPERATION_DESCRIPTIONS[operation] for operation in operations
        }
        questions["visual_target"] = {
            "type": "box",
            "instructions": (
                "Locate the UI element needed for the goal in this exact window screenshot. "
                "Return its bounding box, or no box when the target is absent."
            ),
        }
        if text_strategy == "speculative":
            questions["type_text_value"] = {
                "type": "text",
                "instructions": (
                    "If text is entered into the visual target field, what exact literal value "
                    "should be entered? Extract only text explicitly supplied by the goal or structured inputs."
                ),
            }
    return questions


def apply_text_value(decision: dict[str, Any], answer: Mapping[str, Any]) -> dict[str, Any]:
    text = answer.get("text")
    target = decision.get("target")
    if answer.get("found", 0) < 0.5 or not isinstance(text, str) or not text:
        raise DecisionError(f"No literal input text could be extracted for target {target!r}")
    decision.update(
        text=text,
        text_found=answer.get("found"),
        text_span=answer.get("span"),
        text_path=answer.get("path"),
    )
    return decision


def parse_decision(
    state: Mapping[str, Any], answers: Mapping[str, Any], text_strategy: str = "speculative", visual: bool = False
) -> dict[str, Any]:
    """Validate a model response against the current snapshot before execution."""
    if text_strategy not in TEXT_STRATEGIES:
        raise ValueError(f"Unknown text strategy: {text_strategy}")
    if "operation" not in answers:
        raise DecisionError("Missing operation answer")
    operation_answer = answers["operation"]
    operation = operation_answer.get("choice")
    allowed_operations = available_operations(state)
    if visual:
        extra_visual_operations = ["CLICK", "TYPE_TEXT"]
        if str(state.get("url", "")).startswith("app://"):
            extra_visual_operations.append("PASTE_TEXT")
        allowed_operations.extend(
            operation for operation in extra_visual_operations if operation not in allowed_operations
        )
    if operation not in allowed_operations:
        raise DecisionError(f"Operation {operation!r} is not available in this snapshot")

    result: dict[str, Any] = {
        "operation": operation,
        "target": None,
        "confidence": operation_answer.get("confidence"),
        "operation_probabilities": operation_answer.get("probabilities", {}),
    }
    if visual and operation in {"CLICK", "TYPE_TEXT", "PASTE_TEXT"} and "visual_target" in answers:
        visual_answer = answers["visual_target"]
        box = visual_answer.get("box")
        if visual_answer.get("found", 0) < 0.5 or box is None:
            raise DecisionError(f"No visual target was found for {operation}")
        result.update(
            box=box,
            target_confidence=visual_answer.get("confidence"),
            found=visual_answer.get("found"),
        )
        if operation in {"TYPE_TEXT", "PASTE_TEXT"} and text_strategy == "speculative":
            if "type_text_value" not in answers:
                raise DecisionError("Missing visual text value head")
            apply_text_value(result, answers["type_text_value"])
        return result
    if operation not in TARGET_HEADS:
        return result

    head, _ = TARGET_HEADS[operation]
    if head not in answers:
        raise DecisionError(f"Missing speculative target head {head}")
    target_answer = answers[head]
    target = target_answer.get("choice")
    valid_targets = {str(element["id"]) for element in candidate_elements(state, TARGET_HEADS[operation][1])}
    if target not in valid_targets:
        raise DecisionError(f"Target {target!r} is not valid for {operation}")
    result.update(
        target=target,
        target_confidence=target_answer.get("confidence"),
        target_probabilities=target_answer.get("probabilities", {}),
    )
    if operation in {"TYPE_TEXT", "PASTE_TEXT"} and text_strategy == "speculative":
        value_head = f"{operation.lower()}_value__{target}"
        if value_head not in answers:
            raise DecisionError(f"Missing speculative text value head {value_head}")
        apply_text_value(result, answers[value_head])
    return result
