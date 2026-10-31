from __future__ import annotations

import argparse
import base64
import io
import json
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image

from .d1 import DEFAULT_MODEL_ID, DEFAULT_REVISION, D1Model
from .visual_fixtures import ROOT
from .visual_metrics import evaluate_box


DEFAULT_NATIVE_ROOT = Path("/tmp/dsh-official-alpha2/packages/experimental/cua-macos/native")
OUTPUT_ROOT = ROOT / "results" / "official-cua"


def expected_box_from_ax(
    element: dict[str, Any], screenshot: dict[str, Any]
) -> dict[str, float]:
    x, y, width, height = element["bounds"]
    bounds = screenshot["bounds"]
    return {
        "left": (x - bounds["x"]) / bounds["width"],
        "top": (y - bounds["y"]) / bounds["height"],
        "right": (x + width - bounds["x"]) / bounds["width"],
        "bottom": (y + height - bounds["y"]) / bounds["height"],
    }


def prediction_center_in_window_points(
    box: dict[str, float], screenshot: dict[str, Any]
) -> tuple[float, float]:
    bounds = screenshot["bounds"]
    return (
        (box["left"] + box["right"]) * bounds["width"] / 2,
        (box["top"] + box["bottom"]) * bounds["height"] / 2,
    )


def wait_fixture_count(state_path: Path, expected: int) -> dict[str, Any]:
    deadline = time.monotonic() + 5
    while True:
        state = json.loads(state_path.read_text())
        if state["count"] == expected:
            return state
        if time.monotonic() >= deadline:
            raise AssertionError(f"Fixture count did not become {expected}: {state}")
        time.sleep(0.025)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native-root", type=Path, default=DEFAULT_NATIVE_ROOT)
    parser.add_argument("--helper", type=Path, default=None)
    parser.add_argument("--execute", action="store_true", help="Allow clicks only inside the newly built fixture")
    parser.add_argument("--local-files-only", action="store_true")
    parser.add_argument("--output", type=Path, default=OUTPUT_ROOT / "report.json")
    args = parser.parse_args()
    native_root = args.native_root.resolve()
    helper_path = args.helper or native_root / ".build" / "release" / "dsh-cua-native"
    sys.path.insert(0, str(native_root / "tests"))
    from native_test_support import NativeHelper, line, stop

    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    transcript = []
    report: dict[str, Any] = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "model": {"id": DEFAULT_MODEL_ID, "revision": DEFAULT_REVISION},
        "scope": "Only a newly compiled disposable AppKit fixture; no user application or data",
        "execute_authorized": args.execute,
    }
    with tempfile.TemporaryDirectory(prefix="dsh-cua-d1-visual-") as directory:
        fixture_binary = Path(directory) / "fixture"
        state_path = Path(directory) / "state.json"
        subprocess.run(["swiftc", str(native_root / "tests" / "Fixture.swift"), "-o", str(fixture_binary)], check=True)
        fixture = subprocess.Popen([str(fixture_binary), str(state_path)], stdout=subprocess.PIPE, text=True)
        helper = None
        try:
            assert line(fixture).strip() == "READY"
            helper = NativeHelper(transcript, helper_path)
            capabilities = helper.call("getCapabilities", {})
            report["capabilities"] = capabilities
            if capabilities["permissions"] != {"accessibility": True, "screenRecording": True}:
                raise RuntimeError(f"Required macOS permissions are unavailable: {capabilities['permissions']}")
            if capabilities.get("sessionLocked"):
                raise RuntimeError("macOS session is locked")

            app = helper.call("getApp", {"selector": str(fixture.pid)})
            owner = {"appHandle": app["appHandle"]}
            windows = helper.call("listWindows", owner)
            primary = next(window for window in windows if window["title"] == "DSH CUA primary fixture")
            params = {**owner, "windowId": primary["windowId"], "maxElements": 300, "maxDepth": 20}
            observed = helper.call("getState", params)
            target = next(element for element in observed["elements"] if element.get("title") == "Increment primary")
            screenshot = helper.call("screenshot", {**owner, "windowId": primary["windowId"]})
            image_bytes = base64.b64decode(screenshot["data"], validate=True)
            (OUTPUT_ROOT / "primary.png").write_bytes(image_bytes)
            with Image.open(io.BytesIO(image_bytes)) as source:
                image = source.convert("RGB")

            expected_box = expected_box_from_ax(target, screenshot)
            model = D1Model(local_files_only=args.local_files_only)
            output, decision_ms = model.system_one(
                None,
                {"target": {"type": "box", "instructions": "Where is the Increment primary button?"}},
                media=[image],
            )
            answer = output["answers"]["target"]
            evaluation = evaluate_box(answer, expected_box, image.size)
            report.update({
                "official_source": subprocess.check_output(
                    ["git", "-C", str(native_root), "rev-parse", "HEAD"], text=True
                ).strip(),
                "window": {key: primary[key] for key in ["windowId", "bounds", "title"]},
                "screenshot": {key: screenshot[key] for key in [
                    "pixelWidth", "pixelHeight", "bounds", "coordinateSpace", "mimeType"
                ]},
                "ax_target": target,
                "expected_box": expected_box,
                "answer": answer,
                "evaluation": evaluation,
                "decision_ms": decision_ms,
                "usage": output["usage"],
                "actions": [],
            })

            if args.execute and evaluation["correct"]:
                x, y = prediction_center_in_window_points(answer["box"], screenshot)
                click = helper.call("click", {**owner, "windowId": primary["windowId"], "x": x, "y": y})
                state = wait_fixture_count(state_path, 1)
                report["actions"].append({
                    "path": "visual_box", "window_point": [x, y], "dispatch": click,
                    "independently_verified_count": state["count"],
                })
            elif args.execute:
                report["actions"].append({"path": "visual_box", "rejected": "prediction_center_outside_ax_truth"})

            if args.execute:
                current = helper.call("getState", params)
                stale_target = next(e for e in current["elements"] if e.get("title") == "Increment primary")
                stale_click = {**owner, "snapshotId": current["snapshotId"], "elementIndex": stale_target["index"]}
                helper.call("getState", params)
                stale_error = helper.call("click", stale_click, "STALE_SNAPSHOT")
                count_after_stale = json.loads(state_path.read_text())["count"]
                report["actions"].append({
                    "path": "stale_ax_snapshot", "error": stale_error,
                    "independently_verified_count": count_after_stale,
                })
                assert count_after_stale == 1, "Stale AX input unexpectedly changed fixture state"

                fresh = helper.call("getState", params)
                fresh_target = next(e for e in fresh["elements"] if e.get("title") == "Increment primary")
                dispatch = helper.call("click", {
                    **owner, "snapshotId": fresh["snapshotId"], "elementIndex": fresh_target["index"],
                })
                state = wait_fixture_count(state_path, 2)
                report["actions"].append({
                    "path": "fresh_ax_element", "dispatch": dispatch,
                    "independently_verified_count": state["count"],
                })
            report["status"] = "success"
        finally:
            if helper is not None:
                helper.stop()
            stop(fixture)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
