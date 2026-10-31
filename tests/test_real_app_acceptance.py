from __future__ import annotations

import pytest

from dsh_cu_decision.real_app_acceptance import markdown, summarize, timing


def round_fixture(number: int, *, status: str = 'passed', blocked: int = 0) -> dict:
    cases = [
        {'id': 'textedit.dynamic_ax', 'application': 'TextEdit', 'category': 'dynamic', 'status': status, 'elapsedMs': 100 + number},
        {'id': 'textedit.skill_lifecycle', 'application': 'TextEdit', 'category': 'skill', 'status': status, 'elapsedMs': 200 + number},
        {'id': 'calculator.dynamic_ax', 'application': 'Calculator', 'category': 'dynamic', 'status': status, 'elapsedMs': 300 + number},
        {'id': 'calculator.skill_lifecycle', 'application': 'Calculator', 'category': 'skill', 'status': status, 'elapsedMs': 400 + number},
        {'id': 'calculator.stale_recovery', 'application': 'Calculator', 'category': 'stale', 'status': status, 'elapsedMs': 500 + number},
        {'id': 'privacy.persisted_stores', 'application': 'Shared', 'category': 'privacy', 'status': status, 'elapsedMs': 600 + number},
        {'id': 'textedit.stop_active_run', 'application': 'TextEdit', 'category': 'control', 'status': status, 'elapsedMs': 700 + number},
    ]
    for index in range(blocked):
        cases.append({
            'id': f'environment.blocked-{index}', 'application': 'Calculator', 'category': 'windowing',
            'status': 'blocked', 'elapsedMs': 10, 'detail': {'reason': 'environment_unavailable'},
        })
    return {
        'summary': {
            'round': number, 'runId': f'run-{number}', 'decisionSource': 'fixture',
            'passed': sum(case['status'] == 'passed' for case in cases),
            'failed': sum(case['status'] == 'failed' for case in cases),
            'blocked': sum(case['status'] == 'blocked' for case in cases),
        },
        'cases': cases,
    }


def test_computes_repeated_round_statistics_and_release_scope() -> None:
    summary = summarize([round_fixture(1), round_fixture(2), round_fixture(3)])
    assert summary['totals'] == {'rounds': 3, 'scenarioRuns': 21, 'passed': 21, 'failed': 0, 'blocked': 0}
    assert summary['cases']['textedit.dynamic_ax']['timing']['medianMs'] == 102
    assert summary['cases']['textedit.dynamic_ax']['timing']['p95Ms'] == 103
    assert summary['release']['supervisedOwnedSingleWindow'] == 'accepted'
    assert summary['release']['realAppMultiwindow'] == 'not_evaluated'
    assert summary['release']['realAppOcclusion'] == 'not_evaluated'
    assert summary['release']['unattendedProduction'] == 'not_accepted'


def test_preserves_environment_blocks_and_failures() -> None:
    summary = summarize([round_fixture(1, blocked=1), round_fixture(2, blocked=1), round_fixture(3, blocked=1)])
    assert summary['totals']['blocked'] == 3
    assert summary['cases']['environment.blocked-0']['blockedReasons'] == ['environment_unavailable']
    failed = summarize([round_fixture(1), round_fixture(2), round_fixture(3, status='failed')])
    assert failed['release']['supervisedOwnedSingleWindow'] == 'rejected'
    blocked = summarize([round_fixture(1, status='blocked'), round_fixture(2, status='blocked'), round_fixture(3, status='blocked')])
    assert blocked['release']['controlledRealAppExperiments'] == 'rejected'
    assert blocked['release']['sensitiveDataRetention'] == 'rejected'


def test_rejects_failed_optional_window_acceptance() -> None:
    rounds = [round_fixture(1), round_fixture(2), round_fixture(3)]
    for item in rounds:
        item['cases'].append({
            'id': 'textedit.multiwindow_guard', 'application': 'TextEdit', 'category': 'windowing',
            'status': 'failed', 'elapsedMs': 20,
        })
    assert summarize(rounds)['release']['realAppMultiwindow'] == 'rejected'


def test_requires_three_unique_aligned_rounds() -> None:
    with pytest.raises(ValueError, match='At least three'):
        summarize([round_fixture(1), round_fixture(2)])
    with pytest.raises(ValueError, match='unique'):
        summarize([round_fixture(1), round_fixture(1), round_fixture(3)])


def test_omits_environment_prose_for_absent_block_reasons() -> None:
    report = markdown(summarize([round_fixture(1), round_fixture(2), round_fixture(3)]))
    assert 'textedit_font_panel_not_onscreen' not in report
    assert 'textedit_background_window_unavailable' not in report


def test_timing_uses_nearest_rank_p95_and_population_variance() -> None:
    assert timing([10, 20, 30]) == {'minMs': 10, 'medianMs': 20, 'meanMs': 20, 'p95Ms': 30, 'varianceMs2': pytest.approx(200 / 3)}
