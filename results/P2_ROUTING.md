# P2 complete: Verified Skill → D1 → DeepSeek/human routing

## Routing contract

Every BU/CU result now records `route`, optional `skillId`, and optional `fallbackReason`.

1. **Verified Skill** executes deterministic typed steps with zero model calls.
2. **D1** handles dynamic observations and action/target selection.
3. **DeepSeek or a human** receives structured escalation instead of a nested autonomous agent loop.

Skills resolve targets by accessible name or identifier on every step. They reuse policy, ambiguity, snapshot, native input, and independent verification semantics; they do not replay hardcoded element indices.

## Safe fallback rules

- A unique URL match or explicit `skillId` selects a verified Skill.
- Missing structured input, an unavailable first target, or a stale first observation may fall back to D1 only before any side effect.
- Failures after an action has been dispatched escalate to a human; they do not blindly replay input.
- Unknown skill IDs escalate instead of silently running another path.
- `DONE` still requires independent postconditions.

## Verified paths

- Browser filters: Skill with 3 actions and 0 model calls.
- Browser flights: Skill with 4 actions and 0 model calls when structured inputs are present; safe D1 fallback otherwise.
- Delayed results: one Skill action, then independent async verification.
- Native CSV import: official `setValue` plus AX click, 2 actions and 0 model calls.

## Three-arm comparison

Same local flight task, warm decision service, no DeepSeek planner in any arm:

| Arm | Elapsed time | Model forward calls | Actions |
|---|---:|---:|---:|
| Scripted official Playwright MCP | **899 ms** | 0 | 11 tool calls |
| D1 fallback without structured inputs | **2,101 ms** | 4 | 4 |
| Verified Skill with structured inputs | **1,024 ms** | **0** | 4 |

Text/numeric actions now use at most a 100 ms initial verification window when no pending UI exists. Click/scroll/WAIT retain the full window, and pending UI still enters the longer async wait. This removed fixed 500 ms delays without weakening independent verification.

Raw result: `results/dsh-provider-comparison.json`.

## Verification

- 21 Python tests passed.
- 14 Browser Use Node/DSH tests passed.
- 4 native Computer Use Node/DSH tests passed.
- 2 core Skill tests passed.
- Real D1 AX and AX-less native e2e passed.
- Real D1 Browser Use e2e and the three-arm comparison passed.

## P2 boundary

The measured Skill is a controlled fixture, not evidence that arbitrary user-authored workflows are safe or reusable. P3 must create, validate, and persist Skills from successful trajectories with independent verification and explicit publication rules.
