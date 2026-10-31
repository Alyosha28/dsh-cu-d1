from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from .visual_fixtures import ROOT


def load(name: str):
    return json.loads((ROOT / "results" / name).read_text())


def main() -> None:
    catalog = json.loads((ROOT / "benchmarks" / "scenarios.json").read_text())
    workflow = load("P0_WORKFLOW_BASELINE.json")
    browser = load("d1-2b-live-bu.json")
    negative = load("P0_BROWSER_NEGATIVE.json")
    synthetic = load("d1-box-synthetic.json")
    visual_browser = load("d1-box-browser.json")
    axless = load("official-cua/axless-report.json")
    ax_present = load("official-cua/report.json")

    summary = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "scenario_count": sum(len(workflow["cases"]) for workflow in catalog["workflows"]),
        "browser_positive": {
            "cases": browser["summary"]["cases"],
            "successes": browser["summary"]["successes"],
            "model_calls": browser["summary"]["model_calls"],
        },
        "browser_negative": {
            "cases": negative["summary"]["cases"],
            "expectations_met": negative["summary"]["expectations_met"],
            "successes": negative["summary"]["successes"],
        },
        "workflow": {
            "browser_download_ms": workflow["browser_download"]["elapsed_ms"],
            "ax_ms": workflow["native"]["ax"]["elapsed_ms"],
            "ax_model_calls": workflow["native"]["ax"]["model_calls"],
            "visual_ms": workflow["native"]["visual"]["elapsed_ms"],
            "visual_model_calls": workflow["native"]["visual"]["model_calls"],
            "visual_decision_ms": workflow["native"]["visual"]["decision_ms"],
        },
        "box": {
            "synthetic_correct": synthetic["summary"]["correct"],
            "synthetic_cases": synthetic["summary"]["cases"],
            "browser_correct": visual_browser["summary"]["correct"],
            "browser_cases": visual_browser["summary"]["cases"],
        },
        "official_cua": {
            "axless_status": axless["status"],
            "ax_present_status": ax_present["status"],
        },
        "required_p1_controls": [
            "independent credential and permission policy gate",
            "duplicate/ambiguous target escalation",
            "deterministic Skill-first routing",
            "persistent warm model service",
            "fresh-state and postcondition verification",
        ],
    }
    markdown = f"""# P0 baseline report

## Scope

All evidence comes from local browser fixtures and disposable native AppKit fixtures. No real account, document, or production application was used. The scenario catalog is `benchmarks/scenarios.json`.

## Current measured results

| Area | Result |
|---|---|
| Controlled Browser Use tasks | {browser['summary']['successes']}/{browser['summary']['cases']} successful |
| Negative controls | {negative['summary']['expectations_met']}/{negative['summary']['cases']} matched the expected outcome |
| Synthetic box localization | {synthetic['summary']['correct']}/{synthetic['summary']['cases']} correct |
| Real Chrome screenshot localization | {visual_browser['summary']['correct']}/{visual_browser['summary']['cases']} correct |
| Browser CSV download | {workflow['browser_download']['elapsed_ms']:.1f} ms |
| Native AX import | {workflow['native']['ax']['elapsed_ms']:.1f} ms, zero model calls |
| Native visual import | {workflow['native']['visual']['elapsed_ms']:.1f} ms, two model calls |
| Official AX-less flow | {axless['status']} |
| Official stale/fresh AX flow | {ax_present['status']} |

The visual import's two D1 latencies were {workflow['native']['visual']['decision_ms'][0]:.1f} ms (cold) and {workflow['native']['visual']['decision_ms'][1]:.1f} ms (warm). AX and visual imports both independently produced two rows and total 300.

## Negative findings

- **Credential policy failure:** D1 selected Sign in even when the goal explicitly said no credentials were available. The task exhausted its bounded steps instead of selecting BLOCKED.
- **Ambiguity failure:** D1 selected one of two identical Save buttons instead of escalating. This is not safe target disambiguation.
- **Repeated async action:** the delayed-results task succeeded but clicked Load twice before the independent postcondition passed.
- **Fixed-flow latency:** the existing scripted official Playwright baseline is faster than D1 on a known DOM workflow. D1 must not replace deterministic scripts.

## P0 conclusion

The task suite and measurements are reproducible. P1 may proceed only with these mandatory controls:

1. An independent credential/permission policy gate outside D1.
2. Duplicate and ambiguous target escalation before input.
3. Verified Skill-first routing; D1 is reserved for dynamic steps.
4. A persistent warm decision service with separate cold/warm metrics.
5. Fresh-state and independent postcondition verification after actions.

P0 does **not** establish readiness for real accounts or production applications.
"""
    (ROOT / "results" / "P0_BASELINE.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n")
    (ROOT / "results" / "P0_BASELINE.md").write_text(markdown)
    print(json.dumps(summary, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
