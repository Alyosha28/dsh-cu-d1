from __future__ import annotations

import argparse
import json
import platform
import statistics
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .d1 import DEFAULT_MODEL_ID, DEFAULT_REVISION, D1Model
from .policy import (
    DecisionError,
    apply_text_value,
    build_questions,
    parse_decision,
    text_question_for_target,
)


ROOT = Path(__file__).resolve().parents[2]


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    weight = position - low
    return ordered[low] * (1 - weight) + ordered[high] * weight


def summarize(records: list[dict[str, Any]]) -> dict[str, Any]:
    latencies = [latency for record in records for latency in record["latency_ms"]]
    input_tokens = [record["usage"]["input_tokens"] for record in records if record.get("usage")]
    return {
        "cases": len(records),
        "valid_decisions": sum(not record.get("error") for record in records),
        "operation_accuracy": sum(record["operation_correct"] for record in records) / len(records),
        "joint_accuracy": sum(record["joint_correct"] for record in records) / len(records),
        "latency_ms": {
            "mean": statistics.mean(latencies) if latencies else None,
            "median": statistics.median(latencies) if latencies else None,
            "p95": percentile(latencies, 0.95),
            "min": min(latencies) if latencies else None,
            "max": max(latencies) if latencies else None,
        },
        "forward_calls_per_case_mean": statistics.mean(record["forward_calls"] for record in records),
        "text_extraction_calls_per_case_mean": statistics.mean(
            record["text_extraction_calls"] for record in records
        ),
        "input_tokens_mean": statistics.mean(input_tokens) if input_tokens else None,
        "output_tokens": 0,
    }


def run(args: argparse.Namespace) -> dict[str, Any]:
    cases = json.loads(args.cases.read_text())
    if args.case:
        selected = set(args.case)
        cases = [case for case in cases if case["id"] in selected]
    if not cases:
        raise ValueError("No benchmark cases selected")

    model = D1Model(device=args.device, local_files_only=args.local_files_only)
    print(f"Loaded {DEFAULT_MODEL_ID} on {model.device}/{model.dtype} in {model.load_seconds:.2f}s")

    warmup_state = {"goal": cases[0]["goal"], "observation": cases[0]["state"]}
    _, warmup_ms = model.system_one(
        warmup_state, build_questions(cases[0]["state"], text_strategy=args.text_strategy)
    )
    print(f"First decision (cold): {warmup_ms:.1f}ms; warm rounds per case: {args.repeat}")

    records = []
    for index, case in enumerate(cases, 1):
        observation = case["state"]
        state = {"goal": case["goal"], "observation": observation}
        questions = build_questions(observation, text_strategy=args.text_strategy)
        decision = None
        error = None
        usage = None
        latencies = []
        text_extraction_calls = 0
        forward_calls = 0
        try:
            for _ in range(args.repeat):
                output, elapsed_ms = model.system_one(state, questions)
                forward_calls += 1
                total_ms = elapsed_ms
                decision = parse_decision(observation, output["answers"], text_strategy=args.text_strategy)
                usage = dict(output["usage"])
                if args.text_strategy == "on-demand" and decision["operation"] in {"TYPE_TEXT", "PASTE_TEXT"}:
                    text_output, text_ms = model.system_one(
                        state,
                        {"type_text_value": text_question_for_target(
                            observation, decision["target"], decision["operation"]
                        )},
                    )
                    forward_calls += 1
                    text_extraction_calls += 1
                    total_ms += text_ms
                    usage["input_tokens"] += text_output["usage"]["input_tokens"]
                    apply_text_value(decision, text_output["answers"]["type_text_value"])
                latencies.append(total_ms)
        except (DecisionError, KeyError, TypeError, ValueError) as exc:
            error = f"{type(exc).__name__}: {exc}"

        expected = case["expected"]
        operation_correct = bool(decision and decision["operation"] == expected["operation"])
        joint_correct = bool(operation_correct and decision["target"] == expected.get("target"))
        record = {
            "id": case["id"],
            "modality": case["modality"],
            "expected": expected,
            "decision": decision,
            "error": error,
            "operation_correct": operation_correct,
            "joint_correct": joint_correct,
            "latency_ms": latencies,
            "usage": usage,
            "forward_calls": forward_calls / args.repeat,
            "text_extraction_calls": text_extraction_calls / args.repeat,
        }
        records.append(record)
        actual = decision or {"error": error}
        print(
            f"[{index:02}/{len(cases)}] {case['id']}: expected={expected} actual={actual} "
            f"joint={'PASS' if joint_correct else 'FAIL'} median={statistics.median(latencies):.1f}ms"
        )

    by_modality = {
        modality: summarize([record for record in records if record["modality"] == modality])
        for modality in sorted({record["modality"] for record in records})
    }
    return {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "model": {"id": DEFAULT_MODEL_ID, "revision": DEFAULT_REVISION},
        "config": {"text_strategy": args.text_strategy},
        "runtime": {
            "device": model.device,
            "dtype": str(model.dtype),
            "torch": model.torch.__version__,
            "python": platform.python_version(),
            "platform": platform.platform(),
            "load_seconds": model.load_seconds,
            "cold_first_decision_ms": warmup_ms,
            "warm_rounds_per_case": args.repeat,
        },
        "summary": summarize(records),
        "by_modality": by_modality,
        "cases": records,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, default=ROOT / "fixtures" / "ui_decisions.json")
    parser.add_argument("--output", type=Path, default=ROOT / "results" / "d1-2b-offline.json")
    parser.add_argument("--device", choices=["auto", "cpu", "mps", "cuda"], default="auto")
    parser.add_argument("--repeat", type=int, default=3, help="Warm inference rounds per case")
    parser.add_argument("--case", action="append", help="Run only this case ID; repeatable")
    parser.add_argument("--text-strategy", choices=["speculative", "on-demand"], default="speculative")
    parser.add_argument("--local-files-only", action="store_true")
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error("--repeat must be at least 1")

    report = run(args)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print("\nSummary:")
    print(json.dumps(report["summary"], indent=2))
    print(f"Saved report to {args.output}")


if __name__ == "__main__":
    main()
