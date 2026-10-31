from __future__ import annotations

import argparse
import base64
import io
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image
from playwright.sync_api import sync_playwright

from .browser_benchmark import local_server
from .d1 import DEFAULT_MODEL_ID, DEFAULT_REVISION, D1Model
from .official_cua_axless_visual import point_in_box
from .official_cua_visual import DEFAULT_NATIVE_ROOT, OUTPUT_ROOT, prediction_center_in_window_points
from .visual_fixtures import ROOT


CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
FIXTURE_SOURCE = ROOT / "fixtures" / "native" / "WorkflowFixture.swift"


def wait_state(state_path: Path, predicate, description: str) -> dict[str, Any]:
    deadline = time.monotonic() + 5
    while True:
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        if state and predicate(state):
            return state
        if time.monotonic() >= deadline:
            raise AssertionError(f"{description}: {state}")
        time.sleep(0.025)


def wait_import(state_path: Path) -> dict[str, Any]:
    return wait_state(
        state_path,
        lambda state: state.get("status") == "Import complete" and state.get("rows") == 2 and state.get("total") == 300,
        "CSV import was not independently verified",
    )


def download_report(workdir: Path) -> dict[str, Any]:
    started = time.perf_counter()
    with local_server() as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=CHROME, headless=True)
        try:
            page = browser.new_page()
            page.goto(f"{base_url}/report.html", wait_until="domcontentloaded")
            with page.expect_download() as pending:
                page.get_by_role("button", name="Download report").click()
            download = pending.value
            target = workdir / "report.csv"
            download.save_as(target)
            content = target.read_text()
            assert content == "city,amount\nZürich,100\nLondon,200\n"
            return {
                "status": "success",
                "elapsed_ms": (time.perf_counter() - started) * 1000,
                "rows": 2,
                "total": 300,
            }
        finally:
            browser.close()


def start_fixture(helper, native_root: Path, workdir: Path, name: str):
    binary = workdir / f"{name}-fixture"
    state_path = workdir / f"{name}-state.json"
    subprocess.run(["swiftc", str(FIXTURE_SOURCE), "-o", str(binary)], check=True)
    process = subprocess.Popen([str(binary), str(state_path)], stdout=subprocess.PIPE, text=True)
    from native_test_support import line
    assert line(process).strip() == "READY"
    app = helper.call("getApp", {"selector": str(process.pid)})
    owner = {"appHandle": app["appHandle"]}
    windows = helper.call("listWindows", owner)
    window = next(item for item in windows if item["title"] == "DSH Workflow Fixture")
    return process, state_path, owner, window


def import_with_ax(helper, owner, window, state_path: Path, report_path: Path) -> dict[str, Any]:
    started = time.perf_counter()
    params = {**owner, "windowId": window["windowId"], "maxElements": 100, "maxDepth": 15}
    observed = helper.call("getState", params)
    field = next(element for element in observed["elements"] if element.get("identifier") == "dsh-workflow-path")
    helper.call("click", {**owner, "snapshotId": observed["snapshotId"], "elementIndex": field["index"]})
    helper.call("typeText", {**owner, "text": str(report_path)})
    observed = helper.call("getState", params)
    assert any(element.get("identifier") == "dsh-workflow-path" and element.get("value") == str(report_path)
               for element in observed["elements"]), "Report path was not verified before import"
    button = next(element for element in observed["elements"] if element.get("identifier") == "dsh-workflow-import")
    dispatch = helper.call("click", {**owner, "snapshotId": observed["snapshotId"], "elementIndex": button["index"]})
    state = wait_import(state_path)
    return {
        "path": "ax_first",
        "model_calls": 0,
        "dispatch": dispatch,
        "verified": {"rows": state["rows"], "total": state["total"], "status": state["status"]},
        "elapsed_ms": (time.perf_counter() - started) * 1000,
    }


def visual_target(helper, model: D1Model, owner, window, state_path: Path, instruction: str, point_key: str):
    screenshot = helper.call("screenshot", {**owner, "windowId": window["windowId"]})
    image_bytes = base64.b64decode(screenshot["data"], validate=True)
    with Image.open(io.BytesIO(image_bytes)) as source:
        image = source.convert("RGB")
    output, latency_ms = model.system_one(
        None, {"target": {"type": "box", "instructions": instruction}}, media=[image]
    )
    answer = output["answers"]["target"]
    actual = json.loads(state_path.read_text())
    ground_truth = tuple(actual[point_key])
    accepted = bool(
        answer.get("found", 0) >= 0.5
        and answer.get("box") is not None
        and point_in_box(ground_truth, answer["box"], (screenshot["bounds"]["width"], screenshot["bounds"]["height"]))
    )
    if not accepted:
        raise RuntimeError(f"D1 box did not contain the fixture ground-truth point for {instruction}")
    x, y = prediction_center_in_window_points(answer["box"], screenshot)
    return screenshot, answer, (x, y), ground_truth, latency_ms, output["usage"]


def import_with_visual(helper, model: D1Model, owner, window, state_path: Path, report_path: Path) -> dict[str, Any]:
    started = time.perf_counter()
    params = {**owner, "windowId": window["windowId"], "maxElements": 100, "maxDepth": 15}
    fixture_pid = json.loads(state_path.read_text())["pid"]
    os.kill(fixture_pid, signal.SIGUSR1)
    wait_state(state_path, lambda state: state.get("hiddenAX") is True, "AX removal")
    empty = helper.call("getState", params)
    assert empty["elements"] == []

    screenshot, answer, (x, y), truth, first_ms, usage = visual_target(
        helper, model, owner, window, state_path, "Where is the Report path input field?", "fieldPoint"
    )
    helper.call("click", {**owner, "windowId": window["windowId"], "snapshotId": empty["snapshotId"], "x": x, "y": y})
    helper.call("typeText", {**owner, "text": str(report_path)})

    screenshot, answer, (x, y), truth, second_ms, usage = visual_target(
        helper, model, owner, window, state_path, "Where is the Import report button?", "buttonPoint"
    )
    dispatch = helper.call("click", {**owner, "windowId": window["windowId"], "snapshotId": empty["snapshotId"], "x": x, "y": y})
    state = wait_import(state_path)
    return {
        "path": "visual_fallback",
        "model_calls": 2,
        "dispatch": dispatch,
        "decision_ms": [first_ms, second_ms],
        "verified": {"rows": state["rows"], "total": state["total"], "status": state["status"]},
        "elapsed_ms": (time.perf_counter() - started) * 1000,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--native-root", type=Path, default=DEFAULT_NATIVE_ROOT)
    parser.add_argument("--mode", choices=["ax", "visual", "all"], default="all")
    parser.add_argument("--local-files-only", action="store_true")
    parser.add_argument("--output", type=Path, default=ROOT / "results" / "P0_WORKFLOW_BASELINE.json")
    args = parser.parse_args()
    native_root = args.native_root.resolve()
    sys.path.insert(0, str(native_root / "tests"))
    from native_test_support import NativeHelper, stop

    report: dict[str, Any] = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "scope": "Synthetic browser CSV download and disposable native CSV importer; no user files or accounts",
        "model": {"id": DEFAULT_MODEL_ID, "revision": DEFAULT_REVISION},
    }
    with tempfile.TemporaryDirectory(prefix="dsh-p0-workflow-") as directory:
        workdir = Path(directory)
        report["browser_download"] = download_report(workdir)
        helper = NativeHelper([], native_root / ".build" / "release" / "dsh-cua-native")
        processes = []
        try:
            capabilities = helper.call("getCapabilities", {})
            if capabilities["permissions"] != {"accessibility": True, "screenRecording": True} or capabilities.get("sessionLocked"):
                raise RuntimeError(f"Unsafe or unavailable CUA environment: {capabilities}")
            report["capabilities"] = capabilities
            report["native"] = {}
            if args.mode in {"ax", "all"}:
                process, state_path, owner, window = start_fixture(helper, native_root, workdir, "ax")
                processes.append(process)
                report["native"]["ax"] = import_with_ax(helper, owner, window, state_path, workdir / "report.csv")
            if args.mode in {"visual", "all"}:
                process, state_path, owner, window = start_fixture(helper, native_root, workdir, "visual")
                processes.append(process)
                model = D1Model(local_files_only=args.local_files_only)
                report["native"]["visual"] = import_with_visual(
                    helper, model, owner, window, state_path, workdir / "report.csv"
                )
            report["status"] = "success"
        finally:
            for process in processes:
                stop(process)
            helper.stop()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
