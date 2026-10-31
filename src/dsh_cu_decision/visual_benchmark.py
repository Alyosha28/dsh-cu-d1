from __future__ import annotations

import argparse
import json
import statistics
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image

from .d1 import DEFAULT_MODEL_ID, DEFAULT_REVISION, D1Model
from .visual_fixtures import ROOT, VISUAL_ROOT, build_cases
from .visual_metrics import evaluate_box


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    weight = position - low
    return ordered[low] * (1 - weight) + ordered[high] * weight


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--case", action="append")
    parser.add_argument("--local-files-only", action="store_true")
    parser.add_argument("--output", type=Path, default=ROOT / "results" / "d1-box-synthetic.json")
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error("--repeat must be positive")

    cases = build_cases()
    if args.case:
        selected = set(args.case)
        cases = [case for case in cases if case["id"] in selected]
    if not cases:
        parser.error("No visual cases selected")

    model = D1Model(local_files_only=args.local_files_only)
    records = []
    for index, case in enumerate(cases, 1):
        image_path = VISUAL_ROOT / case["image"]
        with Image.open(image_path) as source:
            image = source.convert("RGB")
        questions = {"target": {"type": "box", "instructions": case["instruction"]}}
        answer = None
        latencies = []
        usage = None
        for _ in range(args.repeat):
            output, elapsed_ms = model.system_one(None, questions, media=[image])
            latencies.append(elapsed_ms)
        answer = output["answers"]["target"]
        usage = output["usage"]
        evaluation = evaluate_box(answer, case["expected_box"], image.size)
        record = {
            "id": case["id"],
            "instruction": case["instruction"],
            "image": str(image_path.relative_to(ROOT)),
            "image_size": image.size,
            "expected_box": case["expected_box"],
            "answer": answer,
            "evaluation": evaluation,
            "latency_ms": latencies,
            "usage": usage,
        }
        records.append(record)
        print(
            f"[{index:02}/{len(cases)}] {case['id']}: "
            f"{'PASS' if evaluation['correct'] else 'FAIL'} "
            f"found={answer.get('found'):.3f} confidence={answer.get('confidence', 0):.3f} "
            f"iou={evaluation.get('iou')} center_error={evaluation.get('center_error_px')} "
            f"median={statistics.median(latencies):.1f}ms"
        )

    latencies = [value for record in records for value in record["latency_ms"]]
    present = [record for record in records if record["evaluation"]["present_expected"]]
    negative = [record for record in records if not record["evaluation"]["present_expected"]]
    report = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "model": {"id": DEFAULT_MODEL_ID, "revision": DEFAULT_REVISION, "device": model.device},
        "scope": "Synthetic images only; no screenshots of user applications and no input dispatched",
        "summary": {
            "cases": len(records),
            "correct": sum(record["evaluation"]["correct"] for record in records),
            "present_cases": len(present),
            "present_center_inside": sum(record["evaluation"]["correct"] for record in present),
            "present_iou_0_5": sum(record["evaluation"].get("iou", 0) >= 0.5 for record in present),
            "negative_cases": len(negative),
            "negative_correct": sum(record["evaluation"]["correct"] for record in negative),
            "median_iou": statistics.median([record["evaluation"]["iou"] for record in present
                                             if "iou" in record["evaluation"]]) if present else None,
            "median_center_error_px": statistics.median([
                record["evaluation"]["center_error_px"] for record in present
                if "center_error_px" in record["evaluation"]
            ]) if present else None,
            "latency_ms": {
                "mean": statistics.mean(latencies),
                "median": statistics.median(latencies),
                "p95": percentile(latencies, 0.95),
                "min": min(latencies),
                "max": max(latencies),
            },
            "input_tokens_mean": statistics.mean(record["usage"]["input_tokens"] for record in records),
            "output_tokens": 0,
        },
        "cases": records,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print("\n" + json.dumps(report["summary"], indent=2))
    print(f"Saved report to {args.output}")


if __name__ == "__main__":
    main()
