# P4 complete: approvals, control, takeover, and audit

## Interactive approval

- Login can be allowed or denied through DSH `userQuestions`.
- Consequential actions require approval; without an approval service the result is explicitly `approval_unavailable` or `confirmation_required` rather than proceeding silently.
- Skill publication uses the same approval path: only the latest independent verification and explicit user approval can publish.
- Denied publication leaves the candidate unverified; approval makes it immutable.

## Run control

Every Provider run now has an execution handle containing:

- Agent identity and run id;
- combined caller/control cancellation signal;
- admission checks for `paused`, `stopped`, and `takeover`;
- route, status, reason, and finish time.

`computer_control` supports `status`, `pause`, `resume`, `stop`, and `takeover`. Control operations run in the exact Agent scope and do not queue behind the run being stopped. Current Provider releases expose the same operations as `browser_control` in the Browser package and `computer_control` in the native package.

## Control page and serialization

- Loopback-only HTTP server with required Bearer token.
- HTML page exposes Pause, Resume, Stop, and Take over.
- API returns run status and recent audit events.
- Control state is serialized without `AbortController` or `undefined` values, preserving DSH lossless JSON output.
- Starting the same control page repeatedly is idempotent.

## Audit

- Ordered JSONL records for run start, finish, pause, resume, stop, and takeover.
- Reads wait for pending writes to become durable.
- Only allowlisted operational fields are persisted; goal text, input values, screenshots, cookies, page content, and credentials are excluded.
- Credential-like values inside allowlisted strings are redacted, and audit files use mode `0600` with private parent directories.
- `auditRetentionDays` is available in both Provider configurations, defaults to 30 days, and is enforced on reads and writes.
- Skill files use mode `0600`; decision and CUA debug logs retain structural metadata without raw goals, inputs, typed values, screenshots, or verification error text.

## Verification

- 21 Python tests passed.
- 18 Browser Use Node/DSH tests passed, including login approval, publication approval, and active-run control.
- 4 native Computer Use Node/DSH tests passed, including native publication and control.
- 6 core Skill/store/control tests passed.
- Real D1 AX, AX-less, and BU e2e passed.
- All three TypeScript packages build successfully.

## P4 boundary

Interactive approval uses a fixture answerer in tests. Real UI presentation and answer routing belong to DSH `userQuestions`; the Provider does not invent a separate approval channel. P5 will expand controlled scenarios and evaluate readiness rather than claim production-wide reliability.
