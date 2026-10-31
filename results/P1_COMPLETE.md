# P1 complete: unified task and Provider runtime

## Delivered

- `@alyosha28/dsh-cu-core` now owns shared observation, decision, action validation, task policy, subgoal input, and the loopback decision client.
- `@alyosha28/dsh-cu-browser-use-d1` provides standard-preset Browser Use subgoals with bounded loops and independent verification.
- `@alyosha28/dsh-cu-computer-use-d1` provides standard-preset macOS subgoals through the **official CUA tool**, official application authorization, native snapshots, and per-Agent operation serialization.
- Shared contract: `benchmarks/computer-subgoal-v1.schema.json`, including `goal`, `verify`, `maxSteps`, `policy`, and structured `inputs`.

## Native execution

- Official `getState` AX text is parsed into shared indexed elements, including accessible names, actual values, identifiers, actions, focus, and bounds.
- Editable fields use official `setValue` rather than append-only typing.
- Native `computer_subgoal` enforces application/window selection, credential policy, ambiguity checks, stale snapshots, bounded steps, and independent postconditions.
- AX-less screenshots use D1 `box` decisions. Coordinate mapping explicitly respects `coordinateSpace`:
  - `window-points` uses native point dimensions;
  - `screenshot-pixels` uses screenshot pixel dimensions.
- Custom native verification handlers allow AX-less outcomes to be proven by application-specific evidence instead of an empty AX tree. The fixture verifies CSV import through its own state file.

## Safety and robustness

- Credential-blocked pages stop before model inference.
- Password UI requires explicit login approval.
- Consequential tasks require approval.
- Ambiguous targets and ambiguous windows stop before input.
- Pending UI waits do not re-trigger the same action.
- Stale snapshots and window changes do not replay input.
- Structured `inputs` prevent D1 from inventing field values and avoid low-confidence text extraction from long AX states.
- Each native e2e test uses a separate temporary CSV path, eliminating cross-test file races.

## Verification evidence

- **21 Python tests passed.**
- **13 Browser Use Node/DSH tests passed.**
- **3 native Computer Use Node/DSH tests passed.**
- Real D1 AX import through official CUA passed.
- Real D1 AX-less screenshot-box import passed.
- Browser Use real-model e2e and official Playwright comparison passed.
- All three TypeScript packages build successfully.

## P1 boundary

P1 proves the unified execution and verification layers, not general multi-step planning. Real D1 can still choose an inefficient or incorrect order for a multi-step visual goal. P2 must therefore implement **Verified Skill → D1 → DeepSeek/human routing** instead of asking D1 to own long-horizon planning.
