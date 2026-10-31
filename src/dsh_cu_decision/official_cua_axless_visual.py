from __future__ import annotations

import argparse
import base64
import io
import json
import os
import plistlib
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image

from .d1 import DEFAULT_MODEL_ID, DEFAULT_REVISION, D1Model
from .official_cua_visual import DEFAULT_NATIVE_ROOT, OUTPUT_ROOT, prediction_center_in_window_points


def point_in_box(point: tuple[float, float], box: dict[str, float], size: tuple[float, float]) -> bool:
    width, height = size
    x, y = point[0] / width, point[1] / height
    return box["left"] <= x <= box["right"] and box["top"] <= y <= box["bottom"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native-root", type=Path, default=DEFAULT_NATIVE_ROOT)
    parser.add_argument("--local-files-only", action="store_true")
    parser.add_argument("--output", type=Path, default=OUTPUT_ROOT / "axless-report.json")
    args = parser.parse_args()
    native_root = args.native_root.resolve()
    helper_path = native_root / ".build" / "release" / "dsh-cua-native"
    sys.path.insert(0, str(native_root / "tests"))
    from capabilities_e2e import stop_application
    from native_test_support import NativeHelper

    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    helper = NativeHelper([], helper_path)
    fixture = None
    report: dict[str, Any] = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "model": {"id": DEFAULT_MODEL_ID, "revision": DEFAULT_REVISION},
        "scope": "Official disposable AX-less AppKit fixture only; no user application or data",
        "actions": [],
    }
    try:
        capabilities = helper.call("getCapabilities", {})
        if capabilities["permissions"] != {"accessibility": True, "screenRecording": True}:
            raise RuntimeError("Accessibility and Screen Recording grants are required")
        if capabilities.get("sessionLocked") is not False:
            raise RuntimeError("macOS session is locked or unavailable")
        report["capabilities"] = capabilities
        with tempfile.TemporaryDirectory(prefix="dsh-cua-d1-axless-") as directory:
            root = Path(directory)
            state_path = root / "state.json"
            contents = root / "Target.app" / "Contents"
            (contents / "MacOS").mkdir(parents=True)
            (contents / "Info.plist").write_bytes(plistlib.dumps({
                "CFBundleIdentifier": f"org.deepseek-harness.cua.{root.name}.Target",
                "CFBundleExecutable": "fixture",
                "CFBundleName": "Target",
                "CFBundlePackageType": "APPL",
                "DSHFixtureStatePath": str(state_path),
            }))
            binary = contents / "MacOS" / "fixture"
            subprocess.run(["swiftc", str(native_root / "tests" / "AxlessFixture.swift"), "-o", str(binary)], check=True)
            pending = helper.call("getApp", {"selector": str(binary.parents[2])})
            fixture = helper.call("launchApp", {"appHandle": pending["appHandle"]})["pid"]

            def wait_state(predicate, description: str) -> dict[str, Any]:
                deadline = time.monotonic() + 5
                while True:
                    state = json.loads(state_path.read_text()) if state_path.exists() else {}
                    if state and state["pid"] == fixture and predicate(state):
                        return state
                    if time.monotonic() >= deadline:
                        raise AssertionError(f"{description}: {state}")
                    time.sleep(0.025)

            wait_state(lambda state: not state["hiddenAX"], "fixture initialization")
            app = helper.call("getApp", {"selector": str(fixture)})
            owner = {"appHandle": app["appHandle"]}
            window_id = json.loads(state_path.read_text())["windowId"]
            params = {**owner, "windowId": window_id, "maxElements": 100, "maxDepth": 15}

            # AX-first: a fresh native element needs no screenshot or model call.
            observed = helper.call("getState", params)
            target = next(e for e in observed["elements"] if e.get("title") == "Increment AXless fixture")
            dispatch = helper.call("click", {
                **owner, "snapshotId": observed["snapshotId"], "elementIndex": target["index"],
            })
            wait_state(lambda state: state["count"] == 1, "AX-first click")
            report["actions"].append({
                "path": "ax_first", "model_calls": 0, "dispatch": dispatch,
                "independently_verified_count": 1,
            })

            # Remove only the fixture's AX roots. D1 now receives pixels, never AX or fixture ground truth.
            os.kill(fixture, signal.SIGUSR1)
            actual = wait_state(lambda state: state["hiddenAX"], "fixture AX removal")
            empty = helper.call("getState", params)
            assert empty["elements"] == [] and empty["tree"] == ""
            screenshot = helper.call("screenshot", {**owner, "windowId": window_id})
            image_bytes = base64.b64decode(screenshot["data"], validate=True)
            (OUTPUT_ROOT / "axless.png").write_bytes(image_bytes)
            with Image.open(io.BytesIO(image_bytes)) as source:
                image = source.convert("RGB")

            model = D1Model(local_files_only=args.local_files_only)
            output, decision_ms = model.system_one(
                None,
                {"target": {"type": "box", "instructions": "Where is the Increment AXless fixture button?"}},
                media=[image],
            )
            answer = output["answers"]["target"]
            ground_truth_point = tuple(actual["buttonPoint"])
            predicted_box = answer.get("box")
            accepted = bool(
                answer.get("found", 0) >= 0.5
                and predicted_box is not None
                and point_in_box(
                    ground_truth_point, predicted_box,
                    (screenshot["bounds"]["width"], screenshot["bounds"]["height"]),
                )
            )
            x, y = prediction_center_in_window_points(predicted_box, screenshot) if accepted else (None, None)
            report.update({
                "axless_snapshot": {"snapshotId": empty["snapshotId"], "elements": empty["elements"]},
                "screenshot": {key: screenshot[key] for key in [
                    "pixelWidth", "pixelHeight", "bounds", "coordinateSpace", "mimeType"
                ]},
                "answer": answer,
                "ground_truth": {
                    "buttonPoint": ground_truth_point,
                    "prediction_contains_fixture_point": accepted,
                    "center_error_points": ((x - ground_truth_point[0]) ** 2 + (y - ground_truth_point[1]) ** 2) ** 0.5
                    if accepted else None,
                },
                "decision_ms": decision_ms,
                "usage": output["usage"],
            })
            if not accepted:
                report["actions"].append({"path": "visual_fallback", "rejected": "box_does_not_contain_fixture_point"})
                report["status"] = "rejected"
            else:
                dispatch = helper.call("click", {
                    **owner, "windowId": window_id, "snapshotId": empty["snapshotId"], "x": x, "y": y,
                })
                wait_state(lambda state: state["count"] == 2, "visual fallback click")
                report["actions"].append({
                    "path": "visual_fallback", "window_point": [x, y], "dispatch": dispatch,
                    "independently_verified_count": 2,
                })

                # Resize only the fixture. The old visual coordinates must not be replayed.
                os.kill(fixture, signal.SIGWINCH)
                wait_state(lambda state: state["resizeCount"] == 1, "fixture resize")
                error = helper.call("click", {
                    **owner, "windowId": window_id, "snapshotId": empty["snapshotId"], "x": x, "y": y,
                }, "WINDOW_CHANGED")
                count = json.loads(state_path.read_text())["count"]
                assert count == 2
                report["actions"].append({
                    "path": "resized_window_guard", "error": error,
                    "independently_verified_count": count,
                })
                report["status"] = "success"
            report["official_source"] = subprocess.check_output(
                ["git", "-C", str(native_root), "rev-parse", "HEAD"], text=True
            ).strip()
    finally:
        if fixture is not None:
            stop_application(fixture)
        helper.stop()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
