import pytest

from dsh_cu_decision.third_party_acceptance import markdown, summarize


def acceptance_round(number=1):
    return {
        'summary': {
            'round': number,
            'runId': f'run-{number}',
            'decisionSource': 'deterministic fixture',
            'total': 5,
            'passed': 5,
            'failed': 0,
            'blocked': 0,
        },
        'cases': [
            {
                'id': 'libreoffice.writer_ax', 'application': 'LibreOffice', 'status': 'passed', 'elapsedMs': 2800 + number,
                'detail': {'independentlyReadBack': True, 'readback': 'ax', 'explicitActivationCalls': 0, 'foregroundPreserved': True},
            },
            {
                'id': 'wps.writer_visual', 'application': 'wpsoffice', 'status': 'passed', 'elapsedMs': 7200 + number,
                'detail': {'independentlyReadBack': True, 'readback': 'screenshot', 'explicitActivationCalls': 0, 'foregroundPreserved': True},
            },
            {
                'id': 'vscode.editor_visual', 'application': 'Visual Studio Code', 'status': 'passed', 'elapsedMs': 6200 + number,
                'detail': {'independentlyReadBack': True, 'readback': 'screenshot', 'explicitActivationCalls': 0, 'foregroundPreserved': True},
            },
            {
                'id': 'chrome.editor_ax', 'application': 'Google Chrome', 'status': 'passed', 'elapsedMs': 5200 + number,
                'detail': {'independentlyReadBack': True, 'readback': 'ax', 'explicitActivationCalls': 0, 'foregroundPreserved': True},
            },
            {
                'id': 'privacy.persisted_stores', 'application': 'Shared', 'status': 'passed', 'elapsedMs': 5,
                'detail': {'allowlistedAudit': True, 'retentionDays': 7},
            },
        ],
    }


def test_accepts_three_aligned_rounds_with_readback_and_activation_evidence():
    result = summarize([acceptance_round(number) for number in (1, 2, 3)])
    assert result['totals'] == {'rounds': 3, 'scenarioRuns': 15, 'passed': 15, 'failed': 0, 'blocked': 0}
    assert result['release']['libreOfficeWriter'] == 'accepted'
    assert result['release']['wpsWriter'] == 'accepted'
    assert result['release']['sensitiveDataRetention'] == 'accepted'
    assert result['release']['foregroundFreeOperation'] == 'accepted'
    assert result['cases']['wps.writer_visual']['explicitActivationCalls'] == [0, 0, 0]
    assert result['cases']['libreoffice.writer_ax']['timing']['medianMs'] == 2802
    assert '9/9' not in markdown(result)


def test_rejects_passed_application_scenario_without_independent_readback():
    rounds = [acceptance_round(number) for number in (1, 2, 3)]
    del rounds[1]['cases'][0]['detail']['independentlyReadBack']
    with pytest.raises(ValueError, match='independent readback'):
        summarize(rounds)


def test_rejects_passed_application_scenario_without_foreground_evidence():
    rounds = [acceptance_round(number) for number in (1, 2, 3)]
    del rounds[1]['cases'][1]['detail']['foregroundPreserved']
    with pytest.raises(ValueError, match='foreground-preservation evidence'):
        summarize(rounds)


def test_rejects_duplicate_or_misaligned_rounds():
    with pytest.raises(ValueError, match='unique'):
        summarize([acceptance_round(1), acceptance_round(1), acceptance_round(2)])
    rounds = [acceptance_round(number) for number in (1, 2, 3)]
    rounds[2]['cases'].pop()
    with pytest.raises(ValueError, match='same scenario matrix'):
        summarize(rounds)


def test_failed_privacy_round_rejects_release_and_withholds_success_prose():
    rounds = [acceptance_round(number) for number in (1, 2, 3)]
    rounds[1]['cases'][4]['status'] = 'failed'
    result = summarize(rounds)
    assert result['release']['sensitiveDataRetention'] == 'rejected'
    assert 'Sensitive-data retention controls: **rejected**' in markdown(result)
    assert 'Audit checks confirm' not in markdown(result)
