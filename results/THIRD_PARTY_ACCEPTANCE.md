# Third-party application acceptance

## Release decision

- LibreOffice Writer body input with AX readback: **accepted**.
- WPS Writer body input with independent screenshot OCR readback: **accepted**.
- Visual Studio Code editor input with independent screenshot OCR readback: **accepted**.
- Chrome local-page editor input with independent AX readback: **accepted**.
- Sensitive-data retention controls: **accepted**.
- Foreground-free operation: **accepted**.
- Unattended production and general third-party reliability: **not accepted**.

The live rounds use a deterministic decision fixture through the D1 provider contract. They validate official CUA execution, application-specific document creation, independent readback, and persistence boundaries; they do not measure real-model decision quality.

## Repeated rounds

| Round | Run ID | Passed | Failed | Environment blocked | Scenario elapsed ms |
|---|---|---:|---:|---:|---:|
| 1 | `1-1793307430933` | 5 | 0 | 0 | 23004 |
| 2 | `2-1793307455819` | 5 | 0 | 0 | 23088 |
| 3 | `3-1793307480806` | 5 | 0 | 0 | 23171 |

## Scenario evidence

| Scenario | Passed | Readback | Explicit activations | Foreground preserved | Median ms | p95 ms | Variance ms² |
|---|---:|---|---:|---|---:|---:|---:|
| `chrome.editor_ax` | 3/3 | ax | 0, 0, 0 | yes, yes, yes | 5733.0 | 5756 | 148.7 |
| `libreoffice.writer_ax` | 3/3 | ax | 0, 0, 0 | yes, yes, yes | 3157.0 | 3220 | 1162.9 |
| `privacy.persisted_stores` | 3/3 | operational | 0, 0, 0 | no, no, no | 4.0 | 4 | 0.0 |
| `vscode.editor_visual` | 3/3 | screenshot | 0, 0, 0 | yes, yes, yes | 7434.0 | 7467 | 1694.0 |
| `wps.writer_visual` | 3/3 | screenshot | 0, 0, 0 | yes, yes, yes | 6780.0 | 6819 | 5354.0 |

## Execution boundaries

- LibreOffice Writer uses an AX document target and official CUA Paste; the document text is independently read through AX.
- WPS Writer uses a controlled blank-document template, a screenshot box for the body, and official CUA Paste; macOS Vision independently recognizes the complete marker from a fresh window screenshot.
- Visual Studio Code uses an isolated profile, controlled onboarding dismissal, and official CUA text input; macOS Vision independently recognizes the complete editor marker.
- Chrome uses an isolated profile and a local HTML editor; official CUA text input is independently read through AX.
- A 20 ms foreground monitor recorded no target-application activation during any measured execution phase.
- Audit checks confirm that the per-run marker, decision token, and screenshot field names are absent from persisted audit events; the audit retention configuration is seven days.
- Existing LibreOffice and WPS processes cause an immediate refusal. VS Code and Chrome use exact child-PID attachment with isolated profiles, leaving any existing user instances outside the run. Every scenario uses newly launched controlled processes and synthetic documents.
