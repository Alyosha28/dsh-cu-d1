# P5 evaluation and acceptance

## Outcome

**P0–P5 are accepted for an experimental, controlled Computer Use prototype.** This is not approval for unattended production use.

## Scenario matrix

The catalog contains **15** cases across browser-to-native workflows, repeated forms, and AX-less native UI.

| Evidence | Result |
|---|---|
| Controlled Browser Use | 5/5 successful |
| Historical negative controls | 1/3 matched expected outcomes |
| New ambiguity/workspace cases | 2/2 matched expected outcomes |
| Async timeout | `timeout: async_result_timeout` with one triggering click and no repeat |
| Synthetic box localization | 11/11 correct |
| Real Chrome screenshot localization | 7/7 correct |
| Official AX-less path | success |
| Multi-window guard | `window_selection_required` |

## Timing

- Official scripted Playwright: **960 ms**.
- D1 fallback: **2326 ms** with 4 model forward calls.
- Verified Skill: **1031 ms** with **zero** model calls.

The timing evidence supports Skill-first execution, not replacing deterministic automation with D1.

## Verification

- 21 Python tests.
- 18 Browser Use Node/DSH tests.
- 5 native Computer Use Node/DSH tests.
- 6 core tests.
- Two consecutive native real-D1 e2e passes and a Browser real-D1 e2e pass.

## Acceptance criteria

- Positive controlled scenarios pass with independent outcome evidence.
- Negative scenarios stop without stale replay, infinite retry, or unapproved consequential actions.
- AX is preferred when available; screenshot box fallback respects window geometry and pixel mapping.
- Verified Skills require independent rerun and explicit user approval before immutable publication.
- Pause, stop, and takeover cancel active work and block subsequent input.

## Scope decision

### Allowed next

- Experimental standard-preset deployments with owned windows and reversible operations.
- More native fixtures and app-specific independent verifiers.
- Verified Skill generation with independent rerun and user approval.

### Required before real applications

- Validate the production approval UX with real `userQuestions` routing.
- Add third-party application, dynamic, occluded, and failure-heavy UI matrices.
- Establish repeated-run latency and reliability objectives.
- Review screenshot retention and sensitive-data redaction.

### Not authorized

- Unattended production Computer Use.
- Real credentials, payments, deletion, messaging, or irreversible actions.
- Claims of general native-app, remote-desktop, or video-stream reliability.
