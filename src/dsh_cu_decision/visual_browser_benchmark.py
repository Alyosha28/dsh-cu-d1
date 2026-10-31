from __future__ import annotations

import argparse
import io
import json
import statistics
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image
from playwright.sync_api import Page, sync_playwright

from .browser_benchmark import local_server
from .d1 import DEFAULT_MODEL_ID, DEFAULT_REVISION, D1Model
from .visual_benchmark import percentile
from .visual_fixtures import ROOT
from .visual_metrics import evaluate_box


OUTPUT_ROOT = ROOT / "fixtures" / "visual-browser"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def expected_box_from_css(
    box: dict[str, float], css_size: tuple[int, int], image_size: tuple[int, int]
) -> dict[str, float]:
    scale_x = image_size[0] / css_size[0]
    scale_y = image_size[1] / css_size[1]
    return {
        "left": box["x"] * scale_x / image_size[0],
        "top": box["y"] * scale_y / image_size[1],
        "right": (box["x"] + box["width"]) * scale_x / image_size[0],
        "bottom": (box["y"] + box["height"]) * scale_y / image_size[1],
    }


def capture(
    page: Page,
    case_id: str,
    instruction: str,
    locator=None,
) -> dict[str, Any]:
    page.wait_for_timeout(50)
    css_size = (page.viewport_size["width"], page.viewport_size["height"])
    screenshot = page.screenshot(full_page=False)
    with Image.open(io.BytesIO(screenshot)) as source:
        image = source.convert("RGB")
    expected = None
    if locator is not None:
        box = locator.bounding_box()
        if box is not None:
            expected = expected_box_from_css(box, css_size, image.size)
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    image.save(OUTPUT_ROOT / f"{case_id}.png")
    return {
        "id": case_id,
        "instruction": instruction,
        "image": image,
        "image_path": f"fixtures/visual-browser/{case_id}.png",
        "expected_box": expected,
    }


def capture_cases() -> list[dict[str, Any]]:
    records = []
    with local_server() as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
        try:
            context = browser.new_context(viewport={"width": 1280, "height": 800})
            page = context.new_page()
            page.goto(f"{base_url}/flights.html", wait_until="domcontentloaded")
            records.append(capture(
                page, "browser-flight-search", "Where is the Search flights button?",
                page.get_by_role("button", name="Search flights"),
            ))
            records.append(capture(
                page, "browser-flight-destination", "Where is the To destination input field?",
                page.get_by_label("To", exact=True),
            ))
            page.get_by_label("To", exact=True).fill("London")
            records.append(capture(
                page, "browser-london-uk", "Where is the London, United Kingdom option?",
                page.get_by_role("option", name="London, United Kingdom"),
            ))
            records.append(capture(
                page, "browser-absent-payment", "Where is the Submit payment button?", None,
            ))
            page.goto(f"{base_url}/filters.html", wait_until="domcontentloaded")
            records.append(capture(
                page, "browser-nonstop-checkbox", "Where is the Nonstop only checkbox itself?",
                page.locator("#nonstop"),
            ))
            records.append(capture(
                page, "browser-apply-filters", "Where is the Apply filters button?",
                page.get_by_role("button", name="Apply filters"),
            ))
            context.close()

            retina = browser.new_context(
                viewport={"width": 800, "height": 600}, device_scale_factor=2,
            )
            page = retina.new_page()
            page.goto(f"{base_url}/flights.html", wait_until="domcontentloaded")
            records.append(capture(
                page, "browser-retina-search", "Where is the Search flights button?",
                page.get_by_role("button", name="Search flights"),
            ))
            retina.close()
        finally:
            browser.close()
    return records


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeat", type=int, default=3)
    parser.add_argument("--local-files-only", action="store_true")
    parser.add_argument("--output", type=Path, default=ROOT / "results" / "d1-box-browser.json")
    args = parser.parse_args()
    if args.repeat < 1:
        parser.error("--repeat must be positive")

    cases = capture_cases()
    model = D1Model(local_files_only=args.local_files_only)
    records = []
    for index, case in enumerate(cases, 1):
        questions = {"target": {"type": "box", "instructions": case["instruction"]}}
        latencies = []
        for _ in range(args.repeat):
            output, elapsed_ms = model.system_one(None, questions, media=[case["image"]])
            latencies.append(elapsed_ms)
        answer = output["answers"]["target"]
        evaluation = evaluate_box(answer, case["expected_box"], case["image"].size)
        record = {
            "id": case["id"],
            "instruction": case["instruction"],
            "image": case["image_path"],
            "image_size": case["image"].size,
            "expected_box": case["expected_box"],
            "answer": answer,
            "evaluation": evaluation,
            "latency_ms": latencies,
            "usage": output["usage"],
        }
        records.append(record)
        print(
            f"[{index:02}/{len(cases)}] {case['id']}: "
            f"{'PASS' if evaluation['correct'] else 'FAIL'} "
            f"iou={evaluation.get('iou')} error={evaluation.get('center_error_px')} "
            f"median={statistics.median(latencies):.1f}ms"
        )

    latencies = [value for record in records for value in record["latency_ms"]]
    present = [record for record in records if record["evaluation"]["present_expected"]]
    negative = [record for record in records if not record["evaluation"]["present_expected"]]
    report = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "model": {"id": DEFAULT_MODEL_ID, "revision": DEFAULT_REVISION, "device": model.device},
        "scope": "Screenshots of isolated local Chrome fixtures only; D1 receives pixels, not DOM; no input dispatched",
        "summary": {
            "cases": len(records),
            "correct": sum(record["evaluation"]["correct"] for record in records),
            "present_cases": len(present),
            "present_center_inside": sum(record["evaluation"]["correct"] for record in present),
            "present_iou_0_5": sum(record["evaluation"].get("iou", 0) >= 0.5 for record in present),
            "negative_cases": len(negative),
            "negative_correct": sum(record["evaluation"]["correct"] for record in negative),
            "median_iou": statistics.median([record["evaluation"]["iou"] for record in present
                                             if "iou" in record["evaluation"]]),
            "latency_ms": {
                "mean": statistics.mean(latencies),
                "median": statistics.median(latencies),
                "p95": percentile(latencies, 0.95),
                "min": min(latencies),
                "max": max(latencies),
            },
        },
        "cases": records,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    print("\n" + json.dumps(report["summary"], indent=2))
    print(f"Saved report to {args.output}")


if __name__ == "__main__":
    main()
