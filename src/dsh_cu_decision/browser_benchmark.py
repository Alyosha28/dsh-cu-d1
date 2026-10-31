from __future__ import annotations

import argparse
import functools
import json
import statistics
import threading
import time
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import Page, sync_playwright

from .browser import BrowserDriver, StaleSnapshot
from .d1 import DEFAULT_MODEL_ID, DEFAULT_REVISION, D1Model
from .policy import (
    DecisionError,
    apply_text_value,
    build_questions,
    parse_decision,
    text_question_for_target,
)


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


@dataclass(frozen=True)
class Subgoal:
    id: str
    goal: str
    verifier: Callable[[Page], bool]
    max_steps: int = 4


@dataclass(frozen=True)
class BrowserCase:
    id: str
    path: str
    subgoals: tuple[Subgoal, ...]
    expected_status: str = "success"


def flights_verified(page: Page) -> bool:
    results = page.locator("#results")
    if not results.is_visible() or page.locator("#loading").is_visible():
        return False
    heading = page.locator("#route-heading").inner_text()
    return (
        "Zürich" in heading
        and "London" in heading
        and "2026-11-01" in heading
        and results.locator("[data-result]").count() >= 1
    )


def filters_verified(page: Page) -> bool:
    summary = page.locator("#summary")
    return summary.is_visible() and summary.locator("#summary-text").inner_text() == "3 adults · Nonstop only"


def input_value(id: str, expected: str) -> Callable[[Page], bool]:
    return lambda page: page.locator(f"#{id}").input_value() == expected


def checkbox_checked(id: str) -> Callable[[Page], bool]:
    return lambda page: page.locator(f"#{id}").is_checked()


FLIGHT_GOAL = (
    "Find one-way flights from Zürich to London on 2026-11-01. "
    "Use the visible form and stop only when matching flight results are visible."
)
FILTER_GOAL = (
    "Show available flights for exactly 3 adults with nonstop only. Apply the filters and stop only "
    "when the results summary confirms both 3 adults and Nonstop only."
)


CASES = {
    "flights": BrowserCase(
        id="flights",
        path="flights.html",
        subgoals=(
            Subgoal("origin", "Enter Zürich into the From field.", input_value("from", "Zürich")),
            Subgoal("destination", "Enter London into the To field.", input_value("to", "London")),
            Subgoal("date", "Enter 2026-11-01 into the Departure date field.", input_value("date", "2026-11-01")),
            Subgoal("search", FLIGHT_GOAL, flights_verified, max_steps=6),
        ),
    ),
    "filters": BrowserCase(
        id="filters",
        path="filters.html",
        subgoals=(
            Subgoal("adults", "Change the Adults value from 2 to exactly 3.", input_value("adults", "3")),
            Subgoal("nonstop", "Enable the Nonstop only checkbox.", checkbox_checked("nonstop")),
            Subgoal("apply", FILTER_GOAL, filters_verified),
        ),
    ),
    "flights-whole": BrowserCase(
        id="flights-whole", path="flights.html", subgoals=(Subgoal("whole", FLIGHT_GOAL, flights_verified, 15),)
    ),
    "filters-whole": BrowserCase(
        id="filters-whole", path="filters.html", subgoals=(Subgoal("whole", FILTER_GOAL, filters_verified, 15),)
    ),
    "already-done": BrowserCase(
        id="already-done",
        path="already-done.html",
        subgoals=(
            Subgoal("done", "Stop when the visible results summary confirms 3 adults and Nonstop only.", filters_verified),
        ),
    ),
    "login-blocked": BrowserCase(
        id="login-blocked",
        path="login-required.html",
        subgoals=(
            Subgoal(
                "blocked",
                "Download the private invoice. You are logged out and no credentials are available.",
                lambda page: False,
                max_steps=2,
            ),
        ),
        expected_status="blocked",
    ),
    "ambiguous-save": BrowserCase(
        id="ambiguous-save",
        path="ambiguous.html",
        subgoals=(
            Subgoal(
                "ambiguous",
                "Click Save without choosing either the Document or Workspace section.",
                lambda page: False,
                max_steps=2,
            ),
        ),
        expected_status="blocked",
    ),
    "delayed-results": BrowserCase(
        id="delayed-results",
        path="delayed-results.html",
        subgoals=(
            Subgoal(
                "delayed",
                "Load the results and stop only when the text Delayed results are ready is visible.",
                lambda page: page.get_by_text("Delayed results are ready", exact=True).is_visible(),
                max_steps=6,
            ),
        ),
    ),
    "delayed-timeout": BrowserCase(
        id="delayed-timeout",
        path="slow-results.html",
        subgoals=(
            Subgoal(
                "timeout",
                "Load the results and stop only when the text Delayed results are ready is visible.",
                lambda page: page.get_by_text("Delayed results are ready", exact=True).is_visible(),
                max_steps=2,
            ),
        ),
        expected_status="escalated",
    ),
    "workspace-save": BrowserCase(
        id="workspace-save",
        path="ambiguous.html",
        subgoals=(
            Subgoal(
                "workspace",
                "Click Save in Workspace.",
                lambda page: page.get_by_text("Workspace saved", exact=True).is_visible(),
                max_steps=3,
            ),
        ),
    ),
}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        pass


@contextmanager
def local_server():
    handler = functools.partial(QuietHandler, directory=str(ROOT / "fixtures" / "web"))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


def state_signature(snapshot: dict[str, Any]) -> str:
    return json.dumps(
        {
            "url": snapshot["url"],
            "elements": snapshot["elements"],
            "scroll": [snapshot.get("can_scroll_up"), snapshot.get("can_scroll_down")],
        },
        sort_keys=True,
    )


def has_pending_state(snapshot: dict[str, Any]) -> bool:
    import re
    return any(
        element.get("role") in {"status", "alert"}
        and re.search(r"loading|waiting|please wait|加载|等待", element.get("name", ""), re.I)
        for element in snapshot.get("elements", [])
    )


def run_subgoal(
    driver: BrowserDriver, model: D1Model, subgoal: Subgoal, text_strategy: str = "speculative"
) -> dict[str, Any]:
    page = driver.page
    trace = []
    decision_times = []
    model_calls = 0
    text_extraction_calls = 0
    actions_executed = 0
    stale_decisions = 0
    repeated = 0
    previous_fingerprint = None
    status = "escalated"
    reason = "step_budget_exhausted"
    last_snapshot = None

    if subgoal.verifier(page):
        status, reason = "success", "independently_verified_before_first_decision"
    else:
        for _ in range(subgoal.max_steps):
            if subgoal.verifier(page):
                status, reason = "success", "independently_verified_before_decision"
                break
            snapshot = driver.snapshot()
            last_snapshot = snapshot
            state = {"goal": subgoal.goal, "observation": snapshot}
            questions = build_questions(snapshot, text_strategy=text_strategy)
            output, elapsed_ms = model.system_one(state, questions)
            model_calls += 1
            try:
                decision = parse_decision(snapshot, output["answers"], text_strategy=text_strategy)
                if text_strategy == "on-demand" and decision["operation"] == "TYPE_TEXT":
                    text_output, text_ms = model.system_one(
                        state,
                        {"type_text_value": text_question_for_target(snapshot, decision["target"])},
                    )
                    model_calls += 1
                    text_extraction_calls += 1
                    elapsed_ms += text_ms
                    apply_text_value(decision, text_output["answers"]["type_text_value"])
            except (DecisionError, KeyError, TypeError, ValueError) as exc:
                reason = f"invalid_decision: {type(exc).__name__}: {exc}"
                break
            decision_times.append(elapsed_ms)

            operation = decision["operation"]
            print(
                f"    step {model_calls}: {operation} target={decision.get('target')} "
                f"text={decision.get('text')!r} confidence={decision.get('confidence'):.3f} "
                f"({elapsed_ms:.1f}ms)"
            )
            trace.append(
                {
                    "snapshot_id": snapshot["snapshot_id"],
                    "snapshot_version": snapshot["version"],
                    "element_count": len(snapshot["elements"]),
                    "decision": decision,
                    "decision_ms": elapsed_ms,
                }
            )
            if operation == "DONE":
                if subgoal.verifier(page):
                    status, reason = "success", "independently_verified"
                else:
                    reason = "premature_done_rejected_by_verifier"
                break
            if operation == "BLOCKED":
                status, reason = "blocked", "model_selected_blocked"
                break

            fingerprint = json.dumps(
                [state_signature(snapshot), operation, decision.get("target"), decision.get("text")],
                sort_keys=True,
            )
            repeated = repeated + 1 if fingerprint == previous_fingerprint else 0
            previous_fingerprint = fingerprint
            if repeated >= 2:
                reason = "no_progress_same_decision_repeated"
                break

            try:
                result = driver.execute(snapshot, decision)
                actions_executed += 1
                trace[-1]["execution"] = result
            except StaleSnapshot as exc:
                stale_decisions += 1
                trace[-1]["execution"] = {"dispatched": False, "stale": str(exc)}
                continue
            except (PlaywrightError, ValueError) as exc:
                trace[-1]["execution"] = {"dispatched": False, "error": str(exc)}
                reason = f"execution_failed: {type(exc).__name__}: {exc}"
                break

            verification_deadline = time.perf_counter() + 0.5
            while time.perf_counter() < verification_deadline:
                if subgoal.verifier(page):
                    status, reason = "success", "independently_verified_after_action"
                    break
                page.wait_for_timeout(50)
            if status == "success":
                break

            current = driver.snapshot()
            if has_pending_state(current):
                async_deadline = time.perf_counter() + 5.0
                while True:
                    if subgoal.verifier(page):
                        status, reason = "success", "independently_verified_after_async_update"
                        break
                    current = driver.snapshot()
                    if not has_pending_state(current):
                        break
                    if time.perf_counter() >= async_deadline:
                        status, reason = "escalated", "async_result_timeout"
                        break
                    page.wait_for_timeout(100)
                if status in {"success", "escalated"}:
                    break

    return {
        "id": subgoal.id,
        "goal": subgoal.goal,
        "status": status,
        "reason": reason,
        "model_calls": model_calls,
        "text_extraction_calls": text_extraction_calls,
        "actions_executed": actions_executed,
        "stale_decisions": stale_decisions,
        "decision_times_ms": decision_times,
        "trace": trace,
        "last_snapshot": last_snapshot if status != "success" else None,
    }


def run_case(
    browser, model: D1Model, base_url: str, case: BrowserCase, text_strategy: str = "speculative"
) -> dict[str, Any]:
    context = browser.new_context(viewport={"width": 1280, "height": 900})
    page = context.new_page()
    driver = BrowserDriver(page)
    started = time.perf_counter()
    page.goto(f"{base_url}/{case.path}", wait_until="domcontentloaded")
    control_started = time.perf_counter()
    subgoal_results = []
    status, reason = "success", "all_subgoals_independently_verified"

    try:
        for subgoal in case.subgoals:
            print(f"  Subgoal {subgoal.id}: {subgoal.goal}")
            result = run_subgoal(driver, model, subgoal, text_strategy=text_strategy)
            subgoal_results.append(result)
            print(f"    => {result['status']}: {result['reason']}")
            if result["status"] != "success":
                status, reason = result["status"], f"{subgoal.id}: {result['reason']}"
                break
    finally:
        control_seconds = time.perf_counter() - control_started
        total_seconds = time.perf_counter() - started
        context.close()

    decision_times = [value for result in subgoal_results for value in result["decision_times_ms"]]
    return {
        "id": case.id,
        "status": status,
        "expected_status": case.expected_status,
        "expectation_met": status == case.expected_status,
        "reason": reason,
        "model_calls": sum(result["model_calls"] for result in subgoal_results),
        "text_extraction_calls": sum(result["text_extraction_calls"] for result in subgoal_results),
        "actions_executed": sum(result["actions_executed"] for result in subgoal_results),
        "stale_decisions": sum(result["stale_decisions"] for result in subgoal_results),
        "control_seconds": control_seconds,
        "total_seconds_including_navigation": total_seconds,
        "decision_latency_ms": {
            "total": sum(decision_times),
            "mean": statistics.mean(decision_times) if decision_times else None,
            "median": statistics.median(decision_times) if decision_times else None,
            "max": max(decision_times) if decision_times else None,
        },
        "subgoals": subgoal_results,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", action="append", choices=sorted(CASES), help="Run only this case")
    parser.add_argument("--browser", default=DEFAULT_CHROME if Path(DEFAULT_CHROME).exists() else None)
    parser.add_argument("--headed", action="store_true", help="Show the isolated test browser")
    parser.add_argument("--max-steps", type=int, default=15)
    parser.add_argument("--text-strategy", choices=["speculative", "on-demand"], default="speculative")
    parser.add_argument("--local-files-only", action="store_true")
    parser.add_argument("--output", type=Path, default=ROOT / "results" / "d1-2b-live-bu.json")
    args = parser.parse_args()

    selected = [CASES[name] for name in args.case] if args.case else [CASES[name] for name in ["flights", "filters", "already-done"]]
    if args.max_steps < 1:
        parser.error("--max-steps must be positive")
    selected = [
        BrowserCase(
            case.id,
            case.path,
            tuple(Subgoal(s.id, s.goal, s.verifier, min(s.max_steps, args.max_steps)) for s in case.subgoals),
            case.expected_status,
        )
        for case in selected
    ]

    model = D1Model(local_files_only=args.local_files_only)
    warmup_observation = {
        "elements": [{"id": "search", "role": "button", "name": "Search", "actions": ["click"]}]
    }
    _, cold_ms = model.system_one(
        {"goal": "Click Search", "observation": warmup_observation},
        build_questions(warmup_observation, text_strategy=args.text_strategy),
    )
    print(f"Model ready on {model.device}; cold decision {cold_ms:.1f}ms")

    records = []
    with local_server() as base_url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=args.browser, headless=not args.headed, args=["--disable-background-networking"]
        )
        try:
            for case in selected:
                print(f"\nCase {case.id}")
                record = run_case(browser, model, base_url, case, text_strategy=args.text_strategy)
                records.append(record)
                print(
                    f"  => {record['status']}: {record['reason']}; calls={record['model_calls']}, "
                    f"actions={record['actions_executed']}, control={record['control_seconds']:.2f}s"
                )
        finally:
            browser.close()

    report = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "model": {"id": DEFAULT_MODEL_ID, "revision": DEFAULT_REVISION, "device": model.device},
        "scope": "Local isolated Chromium pages only; no real accounts, no desktop control",
        "cold_decision_ms": cold_ms,
        "config": {"text_strategy": args.text_strategy},
        "summary": {
            "cases": len(records),
            "successes": sum(record["status"] == "success" for record in records),
            "expectations_met": sum(record["expectation_met"] for record in records),
            "model_calls": sum(record["model_calls"] for record in records),
            "text_extraction_calls": sum(record["text_extraction_calls"] for record in records),
            "actions_executed": sum(record["actions_executed"] for record in records),
            "stale_decisions": sum(record["stale_decisions"] for record in records),
        },
        "cases": records,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print("\n" + json.dumps(report["summary"], indent=2))
    print(f"Saved report to {args.output}")


if __name__ == "__main__":
    main()
