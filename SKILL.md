---
name: dsh-cu-operator
description: Choose and guard DeepSeek Harness Browser Use or Computer Use paths. Use when planning, reviewing, or executing DSH_CU browser extraction, browser subgoals, native macOS subgoals, run control, or Verified Skill publication. Enforces independent verification, ambiguity escalation, origin pinning, and approval boundaries.
---

# DSH CU Operator

This Skill is the decision contract for DSH_CU. It does not replace the tool schemas; it decides which path is appropriate and when to refuse.

## Review mode output has highest priority

Whenever the user asks for a routing decision, a review, “路由格式”, `DECISION`, or which tool to use, reply with exactly these three lines and nothing else — no preface, bullets, arrows, or summary:

```text
DECISION: ALLOW | REFUSE | ESCALATE
TOOL: <tool name> | NONE
REASON: <one of: read-only, ambiguous, origin, approval, verify, native, control, publish>
```

`TOOL` is always `NONE` for `REFUSE` and `ESCALATE`. Only `ALLOW` names the tool that would be used. A routing answer names the path; it does not execute it. “Do not call tools” still requires the three-line routing contract; never replace it with a prose summary.

Choose `REASON` by the decision you are making:

- `REFUSE` or `ESCALATE`: use the first blocker in this order: `origin`, `ambiguous`, `approval`, `verify`.
- `ALLOW`: use the selected path's reason: `read-only` for extraction, `approval` for a consequential or login browser action, `control` for run control, `publish` for publication, `native` for a native action.
- `verify` is a blocker, not a positive reason. Do not report `verify` merely because a verification assertion exists.
- Native app authorization is not the DSH approval rule; an authorized native action still reports `native`.
- Publication requires approval, but once all gates pass the reason is `publish`. If approval is missing, the outcome is `REFUSE` with `approval`.

## Tool selection

| Need | Tool |
| --- | --- |
| Read typed values without clicking or typing | `<toolPrefix>_extract` |
| Inspect the current page elements without a decision call or input | `<toolPrefix>_observe` |
| Open an HTTP(S) URL without a decision call | `<toolPrefix>_navigate` |
| List, select, open, or close controlled-browser tabs | `<toolPrefix>_tabs` |
| Upload local files into one file input (needs approval) | `<toolPrefix>_upload` |
| List or wait for page downloads | `<toolPrefix>_downloads` |
| Perform a bounded dynamic browser action | `d1_browser_subgoal` |
| Perform a bounded native macOS action | `computer_subgoal` |
| Pause, stop, resume, take over, or inspect a run | `<toolPrefix>_control` |
| Publish a Verified Skill | `<toolPrefix>_skill_publish` |

`toolPrefix` defaults to `browser` for the Browser Provider and `computer` for the native Provider. Substitute the configured prefix; do not invent a name. With the default Browser prefix, observation is `browser_observe`, extraction is `browser_extract`, navigation is `browser_navigate`, tabs are `browser_tabs`, upload is `browser_upload`, downloads are `browser_downloads`, control is `browser_control`, and publication is `browser_skill_publish`.

Use the extract tool at call time only with explicit locators and required result types. In review mode, `ALLOW` names extraction only when the requested value has an explicit locator; otherwise `ESCALATE` for the missing locator.

## Hard rules

1. Every action subgoal needs at least one independent `verify` assertion. A missing assertion is a refusal, not a detail to invent.
2. A missing or ambiguous extraction locator must stop. Never select the first match, guess a CSS selector, or silently retry with a different target. A blank value from an existing element is `empty`, not `missing`: for a `string` field it is `""`, and a blank `number`, `boolean`, or `url` field is a failed coercion (`empty_value`).
3. Tab selection moves the owned page. Call `browser_tabs` only while no run is active; after `select`, `open`, or `close`, re-read the tab list instead of reusing an index, and re-check the page origin before any Skill replay.
4. Never replay a URL Skill at another origin. Check the current page origin before replay and after navigations. Legacy Skills without origin or persisted postconditions are not replayable.
5. Consequential actions and login require explicit user approval. Never treat the model's confidence as approval. Uploading local files is consequential: call the upload tool and let the approval name the paths; never reimplement an upload through `d1_browser_subgoal` to avoid the prompt.
6. Never claim unattended control of real credentials, payments, deletion, messaging, or irreversible actions.
7. Publish a Skill only after the latest independent rerun passed and the user explicitly approved that exact candidate. A candidate is not a published Skill.
8. Report `blocked`, `escalated`, or `confirmation_required` honestly. Do not describe a refused action as completed.
9. Browser and native execution may use visible controlled windows, but dynamic execution and Verified Skill replay must not steal the user's focus, system pointer, or keyboard. Every controlled interface must show a model-independent software cursor and current run state. Completion, stop, failure, takeover, and client disconnect must release input and remove the cursor; a completed result card may remain until the user dismisses it. Foreground-only actions stop with `foreground_required` unless the user explicitly takes over.
10. When the user authorizes reuse of login state, expose only the necessary state to a private isolated profile and remove it after the task.

## Decision meanings

Use `ALLOW` only when the selected path satisfies every rule above. Use `ESCALATE` only when a human must disambiguate a target or locator. Use `REFUSE` for every other hard-rule violation, including a request to skip required approval. A needed approval is not an `ESCALATE` by itself; explicitly refusing to obtain it is a `REFUSE`.
