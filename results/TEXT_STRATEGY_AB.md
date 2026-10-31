# D1 text extraction strategy A/B

## Scope

Compare two ways to supply literal input text to the bounded D1 browser controller:

- **speculative**: one forward pass answers the operation, all compatible target heads, and one target-specific text extraction head per typeable element. Only the selected target's text is executable.
- **on-demand**: the first forward pass answers operation and targets. Only after `TYPE_TEXT` selects a target does a second forward pass extract text for that target.

Both strategies constrain text to values extracted from the supplied goal/state; neither permits free text generation. These are small controlled experiments, not general reliability benchmarks.

## Offline observations

Twelve hand-written cases, three warm rounds per case, MPS, pinned `LiquidAI/d1-2B` revision.

| Metric | Speculative | On-demand |
|---|---:|---:|
| Joint operation/target accuracy | 10/12 | 10/12 |
| Valid decisions | 12/12 | 12/12 |
| Mean total forward latency | 137.9 ms | 138.0 ms |
| Median total forward latency | 138.5 ms | 115.3 ms |
| Mean forward calls per case | 1.0 | 1.33 |
| Mean input tokens per case | 515.1 | 513.6 |

Raw reports:

- `d1-2b-offline.json`
- `d1-2b-offline-on-demand.json`

The no-credentials case fails under both strategies. On-demand therefore does not remove the need for external policy and escalation.

## Live local Browser Use

Five controlled Chrome tasks: decomposed flights, decomposed filters, already-complete results, whole-goal flights, and whole-goal filters.

| Metric | Speculative | On-demand |
|---|---:|---:|
| Successful tasks | **5/5** | **4/5** |
| Total model forward calls | **14** | **18** |
| Text-only forward calls | 0 | 5 |
| Browser actions | 14 | 12 |

Raw reports:

- `d1-2b-live-bu.json`
- `d1-2b-live-bu-on-demand.json`

Under on-demand, decomposed flights needed an extra click and whole-goal flights stopped safely when the newly selected target had no confidently extractable literal value. No unsafe fallback or invented text was used.

The whole-goal and decomposed timings are not a clean planner comparison: incomplete whole-goal steps spend additional time in postcondition polling.

## Decision

Keep **speculative** as the default for the first DSH provider integration because it produced higher controlled-task success with fewer total forward calls. Keep on-demand available as an experimental option and regression case.

Before broader claims, repeat the comparison on more forms, larger candidate sets, ambiguous goals, delayed updates, and failure-heavy tasks. The current sample is too small to infer a universal latency or accuracy ranking.
