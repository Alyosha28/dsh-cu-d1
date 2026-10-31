# Real ordinary application acceptance

## Release decision

- Controlled real-application experiments: **accepted**.
- Supervised, owned, single-window operation: **accepted**.
- Sensitive-data retention controls: **accepted**.
- Real-application multiwindow acceptance: **accepted**.
- Real-application occlusion acceptance: **accepted**.
- Unattended production and general native reliability: **not accepted**.

The live rounds use a deterministic decision fixture through the D1 provider contract. They validate official CUA execution, independent readback, Skill lifecycle, run control, and persistence boundaries; they do not measure real-model decision quality.

## Repeated rounds

| Round | Run ID | Passed | Failed | Environment blocked | Scenario elapsed ms |
|---|---|---:|---:|---:|---:|
| 1 | `1-1793308016275` | 9 | 0 | 0 | 19029 |
| 2 | `2-1793308041647` | 9 | 0 | 0 | 18630 |
| 3 | `3-1793308066517` | 9 | 0 | 0 | 18952 |

## Scenario evidence

| Scenario | Passed | Failed | Blocked | Median ms | p95 ms | Variance ms² |
|---|---:|---:|---:|---:|---:|---:|
| `calculator.dynamic_ax` | 3/3 | 0 | 0 | 2894.0 | 2897 | 1514.0 |
| `calculator.skill_lifecycle` | 3/3 | 0 | 0 | 4393.0 | 4399 | 262.9 |
| `calculator.stale_recovery` | 3/3 | 0 | 0 | 526.0 | 533 | 304.2 |
| `privacy.persisted_stores` | 3/3 | 0 | 0 | 6.0 | 6 | 0.0 |
| `textedit.dynamic_ax` | 3/3 | 0 | 0 | 1077.0 | 1100 | 400.7 |
| `textedit.multiwindow_guard` | 3/3 | 0 | 0 | 6899.0 | 6913 | 1832.7 |
| `textedit.occluded_window` | 3/3 | 0 | 0 | 1084.0 | 1090 | 62.9 |
| `textedit.skill_lifecycle` | 3/3 | 0 | 0 | 1376.0 | 1400 | 586.9 |
| `textedit.stop_active_run` | 3/3 | 0 | 0 | 691.0 | 697 | 70.2 |

## Environment boundaries

- Real multiwindow acceptance uses a separate controlled TextEdit instance with a process-scoped tabbing preference. Multiple visible document windows trigger `window_selection_required` before any input.

## Privacy and lifecycle evidence

- Audit events retain allowlisted operational fields only, use mode `0600`, and were run with a seven-day retention configuration.
- Skill files use mode `0600`; captured text is stored as structured-input placeholders.
- Persisted audit and Skill files contain neither the per-run sensitive marker nor the decision token.
- TextEdit and Calculator each completed candidate capture, independent rerun, user-approved publication, and zero-model replay in every round.

## Authorized scope

Use is accepted for supervised experiments with newly launched, explicitly owned applications and reversible operations. Existing user processes are refused. Credentials, payments, deletion, messaging, irreversible actions, unattended production, and claims of general native reliability remain outside the accepted scope.
