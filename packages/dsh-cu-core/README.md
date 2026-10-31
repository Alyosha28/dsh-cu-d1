# @alyosha28/dsh-cu-core

Shared contracts, policy, budgets, independent Skill lifecycle, run control, and private audit storage for DSH-CU providers.

The package is used through `@alyosha28/dsh-cu-browser-use-d1` and `@alyosha28/dsh-cu-computer-use-d1`. Its public subpath exports include `activity`, `contract`, `decision`, `skills`, `skill-store`, `skill-builder`, `budget`, `audit`, `run-controller`, and `control-server`.

Audit storage allowlists operational fields, redacts credential-like values, uses private file permissions, and applies the configured retention period on reads and writes. Skill candidates require independent rerun evidence and explicit user approval before immutable publication. Native Skills can be scoped by exact application bundle identifier, and their `paste` steps retain structured-input placeholders through capture, publication, and zero-model replay.
