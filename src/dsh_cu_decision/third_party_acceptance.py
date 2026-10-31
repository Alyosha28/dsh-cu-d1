from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from typing import Any

from .real_app_acceptance import timing
from .visual_fixtures import ROOT


APPLICATION_CASES = ('libreoffice.writer_ax', 'wps.writer_visual', 'vscode.editor_visual', 'chrome.editor_ax')
REQUIRED_CASES = (*APPLICATION_CASES, 'privacy.persisted_stores')


def summarize(rounds: list[dict[str, Any]]) -> dict[str, Any]:
    if len(rounds) < 3:
        raise ValueError('At least three third-party acceptance rounds are required')
    round_numbers = [item['summary']['round'] for item in rounds]
    run_ids = [item['summary']['runId'] for item in rounds]
    if len(set(round_numbers)) != len(rounds) or len(set(run_ids)) != len(rounds):
        raise ValueError('Acceptance rounds and run IDs must be unique')
    case_ids = [{case['id'] for case in item['cases']} for item in rounds]
    if any(ids != case_ids[0] for ids in case_ids[1:]):
        raise ValueError('Every acceptance round must contain the same scenario matrix')
    if any(case_id not in case_ids[0] for case_id in REQUIRED_CASES):
        raise ValueError('The required third-party scenario matrix is incomplete')

    cases: dict[str, dict[str, Any]] = {}
    for case_id in sorted(case_ids[0]):
        entries = [next(case for case in item['cases'] if case['id'] == case_id) for item in rounds]
        if case_id in APPLICATION_CASES and any(
            entry['status'] == 'passed' and entry.get('detail', {}).get('independentlyReadBack') is not True
            for entry in entries
        ):
            raise ValueError(f'Passed application scenario lacks independent readback: {case_id}')
        if case_id in APPLICATION_CASES and any(
            entry['status'] == 'passed' and entry.get('detail', {}).get('foregroundPreserved') is not True
            for entry in entries
        ):
            raise ValueError(f'Passed application scenario lacks foreground-preservation evidence: {case_id}')
        statuses = [entry['status'] for entry in entries]
        details = [entry.get('detail', {}) for entry in entries]
        cases[case_id] = {
            'application': entries[0]['application'],
            'statuses': statuses,
            'passed': statuses.count('passed'),
            'failed': statuses.count('failed'),
            'blocked': statuses.count('blocked'),
            'timing': timing([entry['elapsedMs'] for entry in entries]),
            'readback': sorted({detail.get('readback', 'operational') for detail in details}),
            'explicitActivationCalls': [detail.get('explicitActivationCalls', 0) for detail in details],
            'foregroundPreserved': [detail.get('foregroundPreserved') is True for detail in details],
        }

    def accepted(case_id: str) -> str:
        return 'accepted' if cases[case_id]['passed'] == len(rounds) else 'rejected'

    foreground_free = all(cases[case_id]['passed'] == len(rounds) for case_id in APPLICATION_CASES) and all(
        activation == 0
        for case_id in APPLICATION_CASES
        for activation in cases[case_id]['explicitActivationCalls']
    )
    return {
        'createdAt': datetime.now(timezone.utc).isoformat(),
        'decisionSource': rounds[0]['summary']['decisionSource'],
        'rounds': [
            {**item['summary'], 'elapsedMs': sum(case['elapsedMs'] for case in item['cases'])}
            for item in rounds
        ],
        'cases': cases,
        'totals': {
            'rounds': len(rounds),
            'scenarioRuns': len(rounds) * len(cases),
            'passed': sum(item['passed'] for item in cases.values()),
            'failed': sum(item['failed'] for item in cases.values()),
            'blocked': sum(item['blocked'] for item in cases.values()),
        },
        'release': {
            'libreOfficeWriter': accepted('libreoffice.writer_ax'),
            'wpsWriter': accepted('wps.writer_visual'),
            'vsCodeEditor': accepted('vscode.editor_visual'),
            'chromeEditor': accepted('chrome.editor_ax'),
            'sensitiveDataRetention': accepted('privacy.persisted_stores'),
            'foregroundFreeOperation': 'accepted' if foreground_free else 'not_accepted',
            'unattendedProduction': 'not_accepted',
            'generalThirdPartyReliability': 'not_accepted',
        },
    }


def markdown(summary: dict[str, Any]) -> str:
    round_count = summary['totals']['rounds']
    lines = [
        '# Third-party application acceptance',
        '',
        '## Release decision',
        '',
        f"- LibreOffice Writer body input with AX readback: **{summary['release']['libreOfficeWriter']}**.",
        f"- WPS Writer body input with independent screenshot OCR readback: **{summary['release']['wpsWriter']}**.",
        f"- Visual Studio Code editor input with independent screenshot OCR readback: **{summary['release']['vsCodeEditor']}**.",
        f"- Chrome local-page editor input with independent AX readback: **{summary['release']['chromeEditor']}**.",
        f"- Sensitive-data retention controls: **{summary['release']['sensitiveDataRetention']}**.",
        f"- Foreground-free operation: **{summary['release']['foregroundFreeOperation']}**.",
        '- Unattended production and general third-party reliability: **not accepted**.',
        '',
        'The live rounds use a deterministic decision fixture through the D1 provider contract. They validate official CUA execution, application-specific document creation, independent readback, and persistence boundaries; they do not measure real-model decision quality.',
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
        '| Scenario | Passed | Readback | Explicit activations | Foreground preserved | Median ms | p95 ms | Variance ms² |',
        '|---|---:|---|---:|---|---:|---:|---:|',
    ])
    for case_id, item in summary['cases'].items():
        stats = item['timing']
        activations = ', '.join(str(value) for value in item['explicitActivationCalls'])
        readback = ', '.join(item['readback'])
        foreground = ', '.join('yes' if value else 'no' for value in item['foregroundPreserved'])
        lines.append(
            f"| `{case_id}` | {item['passed']}/{round_count} | {readback} | {activations} | {foreground} | "
            f"{stats['medianMs']:.1f} | {stats['p95Ms']} | {stats['varianceMs2']:.1f} |"
        )
    lines.extend(['', '## Execution boundaries', ''])
    if summary['release']['libreOfficeWriter'] == 'accepted':
        lines.append('- LibreOffice Writer uses an AX document target and official CUA Paste; the document text is independently read through AX.')
    else:
        lines.append('- LibreOffice Writer body input is not accepted by these rounds.')
    if summary['release']['wpsWriter'] == 'accepted':
        lines.append('- WPS Writer uses a controlled blank-document template, a screenshot box for the body, and official CUA Paste; macOS Vision independently recognizes the complete marker from a fresh window screenshot.')
    else:
        lines.append('- WPS Writer body input is not accepted by these rounds.')
    if summary['release']['vsCodeEditor'] == 'accepted':
        lines.append('- Visual Studio Code uses an isolated profile, controlled onboarding dismissal, and official CUA text input; macOS Vision independently recognizes the complete editor marker.')
    else:
        lines.append('- Visual Studio Code editor input is not accepted by these rounds.')
    if summary['release']['chromeEditor'] == 'accepted':
        lines.append('- Chrome uses an isolated profile and a local HTML editor; official CUA text input is independently read through AX.')
    else:
        lines.append('- Chrome local-page editor input is not accepted by these rounds.')
    if summary['release']['foregroundFreeOperation'] == 'accepted':
        lines.append('- A 20 ms foreground monitor recorded no target-application activation during any measured execution phase.')
    else:
        lines.append('- Explicit application activation is required in the measured document-creation and visual-input paths. The rounds do not establish foreground-free or lock-session operation.')
    if summary['release']['sensitiveDataRetention'] == 'accepted':
        lines.append('- Audit checks confirm that the per-run marker, decision token, and screenshot field names are absent from persisted audit events; the audit retention configuration is seven days.')
    else:
        lines.append('- Sensitive-data retention controls are not accepted by these rounds.')
    lines.extend([
        '- Existing LibreOffice and WPS processes cause an immediate refusal. VS Code and Chrome use exact child-PID attachment with isolated profiles, leaving any existing user instances outside the run. Every scenario uses newly launched controlled processes and synthetic documents.',
        '',
    ])
    return '\n'.join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description='Aggregate three third-party application acceptance rounds')
    parser.add_argument('--rounds', type=int, nargs='+', default=[1, 2, 3])
    args = parser.parse_args()
    rounds = [json.loads((ROOT / f'results/third-party/round-{number}.json').read_text()) for number in args.rounds]
    summary = summarize(rounds)
    json_path = ROOT / 'results/THIRD_PARTY_ACCEPTANCE.json'
    markdown_path = ROOT / 'results/THIRD_PARTY_ACCEPTANCE.md'
    json_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    markdown_path.write_text(markdown(summary))
    os.chmod(json_path, 0o600)
    os.chmod(markdown_path, 0o600)
    print(json.dumps({'totals': summary['totals'], 'release': summary['release']}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
