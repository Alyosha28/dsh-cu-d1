import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_scenario_catalog_has_six_workflows_and_unique_cases():
    catalog = json.loads((ROOT / "benchmarks" / "scenarios.json").read_text())
    assert {workflow["id"] for workflow in catalog["workflows"]} == {
        "browser-to-native", "forms", "axless-native", "real-native-apps", "third-party-native-apps",
        "visible-noninterrupting-control",
    }
    ids = [case["id"] for workflow in catalog["workflows"] for case in workflow["cases"]]
    assert len(ids) == len(set(ids))
    for workflow in catalog["workflows"]:
        for case in workflow["cases"]:
            evidence_file = case["evidence"].split("#", 1)[0]
            assert (ROOT / evidence_file).exists(), evidence_file


def test_p0_baseline_preserves_negative_findings():
    report = json.loads((ROOT / "results" / "P0_BROWSER_NEGATIVE.json").read_text())
    assert report["summary"]["cases"] == 3
    assert report["summary"]["expectations_met"] == 1
    outcomes = {case["id"]: case["status"] for case in report["cases"]}
    assert outcomes == {
        "login-blocked": "escalated",
        "ambiguous-save": "escalated",
        "delayed-results": "success",
    }
