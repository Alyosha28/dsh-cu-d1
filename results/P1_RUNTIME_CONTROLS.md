# P1 runtime controls evidence

## Implemented in this round

- Added the shared task contract `benchmarks/computer-subgoal-v1.schema.json` for narrow goals, independent postconditions, decision budgets, and structured safety policy.
- Added an independent page-policy gate in the DSH Browser Use Provider:
  - `credentials_unavailable` blocks before model inference;
  - password UI defaults to `login_requires_approval`;
  - unapproved consequential tasks stop before input.
- Added duplicate-target escalation using role, accessible name, and section context. A duplicate is allowed only when distinct contexts uniquely disambiguate the goal.
- Added asynchronous pending-UI handling. While a loading state is visible, the runtime waits for independent completion or timeout instead of asking D1 for another click.
- Preserved bounded loops, stale-input rejection, repeated-action detection, independent verification, and exact live-Agent ownership.
- Kept the authenticated loopback D1 service warm for real-model DSH e2e runs.

## Verification

- TypeScript build passed.
- **13 Node/DSH tests passed**, including real Agent/tool-pipeline checks and focused policy tests.
- **19 Python tests passed**.
- Real D1 DSH e2e and the official Playwright comparison both passed.

Specific safety checks now prove:

- no model request is made for an explicitly credential-blocked page;
- no input is sent for an ambiguous target;
- a delayed result completes with one decision request and one triggering click;
- stale snapshots dispatch no input.

## Remaining work

P1 is not complete yet. The same contract and stop semantics still need to be mounted in the native macOS CUA task runtime. P2 then needs Verified Skill-first routing and DeepSeek/human escalation.

The current real-model comparison also remains unfavorable to D1 on a fixed DOM flow: the scripted official Provider took about 0.97 seconds, while the D1 Provider took about 3.41 seconds. This is evidence for deterministic Skill-first routing, not for using D1 on every step.
