from __future__ import annotations

from typing import Any


def area(box: dict[str, float]) -> float:
    return max(0.0, box["right"] - box["left"]) * max(0.0, box["bottom"] - box["top"])


def iou(predicted: dict[str, float], expected: dict[str, float]) -> float:
    intersection = area({
        "left": max(predicted["left"], expected["left"]),
        "top": max(predicted["top"], expected["top"]),
        "right": min(predicted["right"], expected["right"]),
        "bottom": min(predicted["bottom"], expected["bottom"]),
    })
    union = area(predicted) + area(expected) - intersection
    return intersection / union if union > 0 else 0.0


def center(box: dict[str, float], size: tuple[int, int]) -> tuple[float, float]:
    width, height = size
    return (
        (box["left"] + box["right"]) * width / 2,
        (box["top"] + box["bottom"]) * height / 2,
    )


def center_inside(predicted: dict[str, float], expected: dict[str, float]) -> bool:
    x = (predicted["left"] + predicted["right"]) / 2
    y = (predicted["top"] + predicted["bottom"]) / 2
    return expected["left"] <= x <= expected["right"] and expected["top"] <= y <= expected["bottom"]


def evaluate_box(
    answer: dict[str, Any], expected: dict[str, float] | None, size: tuple[int, int]
) -> dict[str, Any]:
    predicted = answer.get("box")
    found = answer.get("found", 0)
    if expected is None:
        return {
            "present_expected": False,
            "correct": found < 0.5 or predicted is None,
            "found": found,
            "confidence": answer.get("confidence"),
        }
    if found < 0.5 or predicted is None:
        return {
            "present_expected": True,
            "correct": False,
            "found": found,
            "confidence": answer.get("confidence"),
            "missed": True,
        }
    predicted_center = center(predicted, size)
    expected_center = center(expected, size)
    return {
        "present_expected": True,
        "correct": center_inside(predicted, expected),
        "center_inside": center_inside(predicted, expected),
        "iou": iou(predicted, expected),
        "center_error_px": ((predicted_center[0] - expected_center[0]) ** 2
                            + (predicted_center[1] - expected_center[1]) ** 2) ** 0.5,
        "predicted_center_px": predicted_center,
        "expected_center_px": expected_center,
        "predicted_box": predicted,
        "found": found,
        "confidence": answer.get("confidence"),
        "missed": False,
    }
