# P3 complete: verified, approved, persistent Skills

## Lifecycle delivered

1. A successful D1 trajectory can produce a **candidate** with `candidateId`.
2. The candidate is rerun in a fresh browser context through the normal Skill runner.
3. Independent verification evidence is appended to the Skill history.
4. Publication requires both the latest passing independent verification and explicit user approval.
5. Only `verified` records are loaded by `selectSkill`; candidates and rejected records never execute.
6. Published Skills persist across store reloads and can execute with zero model calls.

## Safety and privacy

- Actual input text is not persisted. Steps retain only target names and structured input keys; postconditions store placeholders rather than captured values. Candidates are not created when URL, window-title, or step metadata contains a captured input value. Repeated text entry uses collision-free per-step keys, including special names such as `__proto__`. Conflicting structured/captured values and URL-encoded captured values are rejected rather than persisted.
- Custom URL Skills require an exact canonical HTTP(S) `origin` plus `urlPath`. Explicit replay at another origin fails before input; built-in path-only fixtures only match loopback URLs. Origin is rechecked before every replay action and successful return, while same-origin path navigation remains valid.
- Publication and replay require persisted postconditions. Replay hydrates the Skill's verification templates with current inputs and checks both Skill and caller assertions.
- Legacy records without an origin or postconditions remain readable for migration but cannot be published or replayed.
- Verified Skills are immutable; later changes require a new candidate/version.
- Unknown skill IDs, failed verification, missing approval, and stale evidence are rejected.
- A single user-verified match takes precedence over built-in fixtures; multiple custom matches remain ambiguous and fall back rather than guessing.
- Native and browser result traces include target names only when available, preserving lossless JSON output.

## Skill evolution

A published Skill whose replay fails can be repaired through a bounded D1 run and re-enter the lifecycle as a new versioned candidate:

1. When a verified Skill from the store fails to replay and falls back to D1 before any side effect, the runtime records the originating Skill as `evolvedFromSkillId`.
2. If the D1 repair succeeds and Skill capture is enabled, the repaired trajectory produces a candidate whose `version` is the parent version + 1 and whose `evolvedFrom` references the parent Skill.
3. The repaired candidate is a fresh `candidate` record; it is not replayable until it passes the standard independent rerun and explicit user approval gate.
4. The original published Skill remains `verified` and immutable. Both versions coexist as independent records.
5. Built-in fixture Skills never trigger evolution; only store-published Skills carry an evolution lineage.

`SkillStore.createCandidate` accepts an `evolveFrom` option that resolves the parent, increments the version, and folds the lineage into the candidate hash so each repaired version has a distinct identity. Evolution from an unknown parent is rejected.

## Full lifecycle evidence

The browser lifecycle test proves:

- D1 completes a flight task and creates a candidate.
- Candidate steps are `From`, `To`, `Departure date`, and `Search flights`.
- The candidate has no verified status before publication.
- A fresh page independently reruns the candidate successfully.
- `system` approval is rejected.
- `user` approval publishes the candidate.
- A reloaded store selects the published Skill, and the next task completes with **zero model calls**.
- Explicit replay of the same Skill at a different origin stops with `skill_origin_mismatch` and zero dispatched actions.
- A replay that clicks through to a second origin is rejected after the navigation instead of accepting matching postconditions on the new origin.
- Candidate verification contains `{{inputs:...}}` placeholders; replay succeeds even when the caller supplies only an initially satisfied assertion, proving the Skill's own postconditions are evaluated.
- A real DSH + Chrome + decision-service + SkillStore run types two different values into the same `__proto__` field; both replay keys persist without either raw value.
- A published Skill with a stale target fails replay before any side effect, falls back to a bounded D1 repair, and produces a version 2 candidate carrying `evolvedFrom`; the original stays verified and immutable.
- The native provider regression proves the same lineage through official CUA and the AppKit fixture, including capture of the repaired native trajectory and `candidateId` returned as lossless JSON.
- Real TextEdit and Calculator runs complete capture, independent rerun, approval, and zero-model replay in three acceptance rounds; see `results/REAL_APP_ACCEPTANCE.md`.
- Persisted JSON contains neither `Zürich` nor `London`.

Core store tests also cover unsupported trajectories, explicit rejection, immutable verified records, missing verification, stale evidence, and rejection of system-only approval.

## Verification

- 21 Python tests passed.
- 15 Browser Use Node/DSH tests passed, including the full lifecycle.
- 4 native Computer Use Node/DSH tests passed.
- 4 core Skill/store tests passed.
- Real D1 AX, AX-less, and BU e2e passed.
- All three TypeScript packages build successfully.

## P3 boundary

Only successful D1 trajectories with supported typed operations and named targets become candidates. Visual coordinate-only or unsupported actions do not silently become reusable Skills. Publication semantics are enforced in code; interactive approval UX belongs to P4.
