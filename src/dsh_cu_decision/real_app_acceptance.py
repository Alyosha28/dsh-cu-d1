from __future__ import annotations

import argparse
import json
import math
import os
import re
import statistics
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .visual_fixtures import ROOT


def timing(values: list[int]) -> dict[str, float | int]:
    ordered = sorted(values)
    return {
        'minMs': ordered[0],
        'medianMs': statistics.median(ordered),
        'meanMs': statistics.mean(ordered),
        'p95Ms': ordered[math.ceil(len(ordered) * 0.95) - 1],
        'varianceMs2': statistics.pvariance(ordered),
    }


def summarize(rounds: list[dict[str, Any]]) -> dict[str, Any]:
    if len(rounds) < 3:
        raise ValueError('At least three real-app acceptance rounds are required')
    round_numbers = [item['summary']['round'] for item in rounds]
    run_ids = [item['summary']['runId'] for item in rounds]
    if len(set(round_numbers)) != len(rounds) or len(set(run_ids)) != len(rounds):
        raise ValueError('Acceptance rounds and run IDs must be unique')
    case_ids = [{case['id'] for case in item['cases']} for item in rounds]
    if any(ids != case_ids[0] for ids in case_ids[1:]):
        raise ValueError('Every acceptance round must contain the same scenario matrix')

    cases: dict[str, dict[str, Any]] = {}
    for case_id in sorted(case_ids[0]):
        entries = [next(case for case in item['cases'] if case['id'] == case_id) for item in rounds]
        statuses = [entry['status'] for entry in entries]
        blocked_reasons = sorted({
            entry.get('detail', {}).get('reason', 'unspecified')
            for entry in entries if entry['status'] == 'blocked'
        })
        cases[case_id] = {
            'application': entries[0]['application'],
            'category': entries[0]['category'],
            'statuses': statuses,
            'passed': statuses.count('passed'),
            'failed': statuses.count('failed'),
            'blocked': statuses.count('blocked'),
            'blockedReasons': [
                reason if isinstance(reason, str) and re.fullmatch(r'[a-z][a-z0-9_:-]{0,99}', reason) else 'unspecified'
                for reason in blocked_reasons
            ],
            'timing': timing([entry['elapsedMs'] for entry in entries]),
        }

    required = [
        'textedit.dynamic_ax', 'textedit.skill_lifecycle',
        'calculator.dynamic_ax', 'calculator.skill_lifecycle', 'calculator.stale_recovery',
        'privacy.persisted_stores', 'textedit.stop_active_run',
    ]
    supported = all(cases.get(case_id, {}).get('passed') == len(rounds) for case_id in required)

    def optional_acceptance(case_id: str) -> str:
        case = cases.get(case_id)
        if case is None:
            return 'not_evaluated'
        if case['failed'] > 0:
            return 'rejected'
        if case['blocked'] > 0:
            return 'blocked'
        return 'accepted' if case['passed'] == len(rounds) else 'not_evaluated'

    failed = sum(item['failed'] for item in cases.values())
    blocked = sum(item['blocked'] for item in cases.values())
    return {
        'createdAt': datetime.now(timezone.utc).isoformat(),
        'decisionSource': rounds[0]['summary']['decisionSource'],
        'rounds': [
            {
                **item['summary'],
                'elapsedMs': sum(case['elapsedMs'] for case in item['cases']),
            }
            for item in rounds
        ],
        'cases': cases,
        'totals': {
            'rounds': len(rounds),
            'scenarioRuns': len(rounds) * len(cases),
            'passed': sum(item['passed'] for item in cases.values()),
            'failed': failed,
            'blocked': blocked,
        },
        'release': {
            'controlledRealAppExperiments': 'accepted' if supported else 'rejected',
            'supervisedOwnedSingleWindow': 'accepted' if supported else 'rejected',
            'realAppMultiwindow': optional_acceptance('textedit.multiwindow_guard'),
            'realAppOcclusion': optional_acceptance('textedit.occluded_window'),
            'sensitiveDataRetention': 'accepted' if cases.get('privacy.persisted_stores', {}).get('passed') == len(rounds) else 'rejected',
            'unattendedProduction': 'not_accepted',
            'generalNativeReliability': 'not_accepted',
        },
    }


def markdown(summary: dict[str, Any]) -> str:
    round_count = summary['totals']['rounds']
    privacy_accepted = summary['cases'].get('privacy.persisted_stores', {}).get('passed') == round_count
    blocked_reasons = {
        reason
        for case in summary['cases'].values()
        for reason in case.get('blockedReasons', [])
    }
    skills_accepted = all(
        summary['cases'].get(case_id, {}).get('passed') == round_count
        for case_id in ['textedit.skill_lifecycle', 'calculator.skill_lifecycle']
    )
    lines = [
        '# Real ordinary application acceptance',
        '',
        '## Release decision',
        '',
        f"- Controlled real-application experiments: **{summary['release']['controlledRealAppExperiments']}**.",
        f"- Supervised, owned, single-window operation: **{summary['release']['supervisedOwnedSingleWindow']}**.",
        f"- Sensitive-data retention controls: **{summary['release']['sensitiveDataRetention']}**.",
        f"- Real-application multiwindow acceptance: **{summary['release']['realAppMultiwindow']}**.",
        f"- Real-application occlusion acceptance: **{summary['release']['realAppOcclusion']}**.",
        '- Unattended production and general native reliability: **not accepted**.',
        '',
        'The live rounds use a deterministic decision fixture through the D1 provider contract. They validate official CUA execution, independent readback, Skill lifecycle, run control, and persistence boundaries; they do not measure real-model decision quality.',
        '',
        '## Repeated rounds',
        '',
        '| Round | Run ID | Passed | Failed | Environment blocked | Scenario elapsed ms |',
        '|---|---|---:|---:|---:|---:|',
    ]
    for item in summary['rounds']:
        lines.append(f"| {item['round']} | `{item['runId']}` | {item['passed']} | {item['failed']} | {item['blocked']} | {item['elapsedMs']} |")
    lines.extend([
        '',
        '## Scenario evidence',
        '',
        '| Scenario | Passed | Failed | Blocked | Median ms | p95 ms | Variance ms² |',
        '|---|---:|---:|---:|---:|---:|---:|',
    ])
    for case_id, item in summary['cases'].items():
        stats = item['timing']
        lines.append(
            f"| `{case_id}` | {item['passed']}/{summary['totals']['rounds']} | {item['failed']} | {item['blocked']} | "
            f"{stats['medianMs']:.1f} | {stats['p95Ms']} | {stats['varianceMs2']:.1f} |"
        )
    lines.extend([
        '',
        '## Environment boundaries',
        '',
    ])
    if 'textedit_font_panel_not_onscreen' in blocked_reasons:
        lines.append('- `textedit_font_panel_not_onscreen`: CUA does not expose the TextEdit font panel as a visible second window, so real multiwindow acceptance remains blocked. The independent-window AppKit fixture retains the executable multiwindow guard regression.')
    if 'textedit_background_window_unavailable' in blocked_reasons:
        lines.append('- `textedit_background_window_unavailable`: the background document cannot be observed with usable geometry, so the occlusion scenario is recorded as blocked rather than passed.')
    if summary['release']['realAppMultiwindow'] == 'accepted':
        lines.append('- Real multiwindow acceptance uses a separate controlled TextEdit instance with a process-scoped tabbing preference. Multiple visible document windows trigger `window_selection_required` before any input.')
    lines.extend([
        '',
        '## Privacy and lifecycle evidence',
        '',
    ])
    if privacy_accepted:
        lines.extend([
            '- Audit events retain allowlisted operational fields only, use mode `0600`, and were run with a seven-day retention configuration.',
            '- Skill files use mode `0600`; captured text is stored as structured-input placeholders.',
            '- Persisted audit and Skill files contain neither the per-run sensitive marker nor the decision token.',
        ])
    else:
        lines.append('- Sensitive-data retention controls are not accepted by these rounds.')
    if skills_accepted:
        lines.append('- TextEdit and Calculator each completed candidate capture, independent rerun, user-approved publication, and zero-model replay in every round.')
    else:
        lines.append('- Skill lifecycle acceptance was not established in every round.')
    lines.extend([
        '',
        '## Authorized scope',
        '',
        'Use is accepted for supervised experiments with newly launched, explicitly owned applications and reversible operations. Existing user processes are refused. Credentials, payments, deletion, messaging, irreversible actions, unattended production, and claims of general native reliability remain outside the accepted scope.',
        '',
    ])
    return '\n'.join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description='Aggregate three real ordinary application acceptance rounds')
    parser.add_argument('--rounds', type=int, nargs='+', default=[1, 2, 3])
    args = parser.parse_args()
    rounds = [json.loads((ROOT / f'results/real-apps/round-{number}.json').read_text()) for number in args.rounds]
    summary = summarize(rounds)
    json_path = ROOT / 'results/REAL_APP_ACCEPTANCE.json'
    markdown_path = ROOT / 'results/REAL_APP_ACCEPTANCE.md'
    json_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    markdown_path.write_text(markdown(summary))
    os.chmod(json_path, 0o600)
    os.chmod(markdown_path, 0o600)
    print(json.dumps({'totals': summary['totals'], 'release': summary['release']}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
