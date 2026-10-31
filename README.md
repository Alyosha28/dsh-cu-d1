# DSH CU Decision Lab

Experiments using [LiquidAI/d1-2B](https://huggingface.co/LiquidAI/d1-2B) as a System 1 decision model for DeepSeek Harness Browser Use and Computer Use.

## Repository

[![dsh-plugin](https://img.shields.io/badge/GitHub%20topic-dsh--plugin-2563eb)](https://github.com/topics/dsh-plugin)
[github.com/Alyosha28/dsh-cu-d1](https://github.com/Alyosha28/dsh-cu-d1) · MIT

Published on npm:

[![npm](https://img.shields.io/npm/v/@albaincompleta/dsh-cu-bundle?label=npm)](https://www.npmjs.com/package/@albaincompleta/dsh-cu-bundle)

```bash
dsh plugin --profile <profile> add @albaincompleta/dsh-cu-bundle
```

The bundle depends on `@albaincompleta/dsh-cu-core`, `-browser-use-d1`,
`-computer-use-d1` and `-client`, so one install brings the whole plugin; the
Harness compatibility gate refuses any runtime outside `0.2.1-rc.5 <0.3.0`.

This repository is an installable DSH plugin, not a directory: `@albaincompleta/dsh-cu-bundle`
declares `dsh.bundle.patch`, `@albaincompleta/dsh-cu-client` declares `dsh.client`, and every
package declares `engines.dsh`. The plugin path is a profile, so the concrete
install is:

```bash
git clone https://github.com/Alyosha28/dsh-cu-d1.git
cd dsh-cu
npm install --include=dev && npm run build

# One command: links the packages, mounts @albaincompleta/dsh-cu-bundle, runs the doctor.
npm run install:plugin -- --profile=dsh-cu

# Equivalent by hand:
dsh plugin --profile dsh-cu add \
  link:$PWD/packages/dsh-cu-bundle link:$PWD/packages/dsh-cu-core \
  link:$PWD/packages/dsh-browser-use-d1 link:$PWD/packages/dsh-computer-use-d1 \
  link:$PWD/packages/dsh-cu-client
```

Requires DSH `>=0.2.1-rc.5 <0.3.0`; another runtime is refused by the Harness
compatibility gate with an explicit message.

## Install as a DSH plugin

The packages target DeepSeek Harness **0.2.1-rc.5** (`engines.dsh: >=0.2.1-rc.5 <0.3.0`) and cordis `~4.0.5`, the versions the desktop application runs. A different runtime is refused by the Harness compatibility gate with an explicit message instead of loading a mismatched plugin.

```bash
# Build the packages once.
npm install --include=dev && npm run build

# Install into a profile: links the packages, mounts the bundle, backs up the
# manifest, and runs the doctor. --dry-run prints the steps only.
npm run install:plugin -- --profile=dsh-cu

# Or run each step by hand:
#   dsh plugin --profile dsh-cu add link:$PWD/packages/dsh-cu-bundle ... 
#   add "@albaincompleta/dsh-cu-bundle" to ~/.dsh/profiles/dsh-cu/package.json
#   npm run plugin:doctor -- --profile=dsh-cu
```

The plugin is consumed at the profile level, not inside the desktop application:
any profile that lists `@albaincompleta/dsh-cu-bundle` mounts it, whether that profile is booted
by the CLI (`dsh --profile dsh-cu …`) or shipped another way. Installing into the
Electron-owned `desktop` profile is optional and not required for the plugin to
be a DSH plugin; if you ever do it, quit DSH first so the running app cannot
overwrite the manifest on exit.

`plugin:doctor` composes the profile with `dsh --dump-config`, checks that both entries exist and are enabled, fails on a competing browser provider, and compares the plugin's DSH package version with the host. It never starts a browser, a helper, or a model.

The bundle disables the native provider by default. Enable both native entries only after granting macOS Accessibility and Screen Recording and reading the native section below. When a native run needs a missing grant, the provider opens the macOS privacy dialog once (`promptPermissions`, default true), returns `prompted` plus a deep link to the exact System Settings pane, and the control page's permission button does the same. `npm run plugin:doctor` prints the current Accessibility and Screen Recording state, so the gap is visible before a run fails. `DSH_CU_DECISION_ENDPOINT`, `DSH_CU_DECISION_TOKEN`, `DSH_CU_CONTROL_TOKEN`, and `DSH_CU_HEADLESS` configure the browser entry at profile load; see [`packages/dsh-cu-bundle/README.md`](packages/dsh-cu-bundle/README.md).

Without Playwright's own browser build, the provider launches an installed Google Chrome or Edge and reports `browser_unavailable` with a recovery step when neither exists, so a fresh machine does not need `npx playwright install` first.

## Reuse-first execution

Use the official execution providers for general automation instead of reimplementing their capabilities:

- **Browser:** `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` supplies the upstream Playwright MCP tools, including tabs, upload/drop, snapshots, and attach-mode access to an existing browser's tabs and login state.
- **Native macOS:** `@deepseek-ai/dsh-cua/api` supplies the authorized application/window object API. `getApp` owns consent, launch, and initial AX observation; callers must not poll it as an application launcher.

The D1 providers below remain experimental decision and Verified Skill layers. Deterministic workflows should use the official tools directly. The D1 Browser provider is not a replacement for Playwright MCP's broader browser surface.

Opt-in live checks use real installed applications and no accounts:

```bash
npm run test:live:browser
DSH_CU_REAL_APPS=1 npm run test:live:native

# D1 comparison only; requires the local decision service.
D1_DECISION_TOKEN=test-token npm run test:live:d1
```

`test:live:native` refuses to touch an existing TextEdit process and tests only a new unsaved document. The broader matrices below use newly launched controlled applications and reversible synthetic state.

The real ordinary application matrix covers fresh TextEdit documents and a resettable Calculator, including dynamic AX actions, Skill capture/rerun/approval/replay, stale-input recovery, multiwindow and occlusion availability, active-run stop, and sensitive-data persistence. Run three independent rounds and aggregate their timing evidence:

```bash
DSH_CU_REAL_APPS=1 DSH_CU_REAL_APP_ROUND=1 npm run test:e2e --workspace @albaincompleta/dsh-cu-computer-use-d1 -- tests/real-app-matrix.e2e.ts
DSH_CU_REAL_APPS=1 DSH_CU_REAL_APP_ROUND=2 npm run test:e2e --workspace @albaincompleta/dsh-cu-computer-use-d1 -- tests/real-app-matrix.e2e.ts
DSH_CU_REAL_APPS=1 DSH_CU_REAL_APP_ROUND=3 npm run test:e2e --workspace @albaincompleta/dsh-cu-computer-use-d1 -- tests/real-app-matrix.e2e.ts
uv run python -m dsh_cu_decision.real_app_acceptance
```

These rounds use a deterministic decision fixture through the D1 Provider contract to isolate execution and lifecycle reliability; they do not measure real-model decision quality. Existing TextEdit or Calculator processes cause an immediate refusal, including localized process names. Reports are written to `results/real-apps/` and `results/REAL_APP_ACCEPTANCE.md`. The current release accepts all nine scenarios in each round, including real multiwindow selection guards, overlapping-window occlusion, Skill lifecycle, active-run stop, and sensitive-data retention.

The third-party matrix covers LibreOffice Writer, WPS Writer, Visual Studio Code, and Chrome. LibreOffice and Chrome use independent AX readback; WPS and Visual Studio Code use independent macOS Vision OCR readback. A controlled foreground anchor and a 20 ms process monitor verify that execution does not switch the frontmost application. Run three independent rounds and aggregate their evidence:

```bash
DSH_CU_THIRD_PARTY_APPS=1 DSH_CU_THIRD_PARTY_ROUND=1 npm run test:e2e --workspace @albaincompleta/dsh-cu-computer-use-d1 -- tests/third-party-apps.e2e.ts
DSH_CU_THIRD_PARTY_APPS=1 DSH_CU_THIRD_PARTY_ROUND=2 npm run test:e2e --workspace @albaincompleta/dsh-cu-computer-use-d1 -- tests/third-party-apps.e2e.ts
DSH_CU_THIRD_PARTY_APPS=1 DSH_CU_THIRD_PARTY_ROUND=3 npm run test:e2e --workspace @albaincompleta/dsh-cu-computer-use-d1 -- tests/third-party-apps.e2e.ts
uv run python -m dsh_cu_decision.third_party_acceptance
```

Reports are written to `results/third-party/` and `results/THIRD_PARTY_ACCEPTANCE.md`. Acceptance covers all four measured applications and foreground-preserving execution. Existing LibreOffice or WPS processes cause an immediate refusal. VS Code and Chrome use isolated profiles and exact child-PID attachment, so existing user instances remain outside the run. Locked-session execution and unattended production remain outside the accepted scope.

## Current capabilities

- Offline browser/desktop operation and target benchmarks.
- Local Browser Use control with real Chrome DOM snapshots and Playwright.
- A TypeScript DSH Browser Use Provider using official `SessionResources`, with standard direct-tool execution and independent structured verification.
- A read-only `browser_observe` path that returns the current element table for planning and postcondition writing without D1 or input.
- DSH-CU tools render as first-class cards inside the DSH client: `@albaincompleta/dsh-cu-client` declares `dsh.client`, the client module scanner serves its bundle, and each tool result shows a status chip, a one-line summary, and an expandable payload in the transcript.
- The controlled tab is marked while a run is active: a title prefix (`● DSH-CU 控制中 · `) and a favicon dot stay visible in the browser tab strip, survive navigation, and clear on finish, stop, failure, and takeover.
- A menu-bar item (`◉ DSH-CU`) appears for the duration of a native run and of a visible browser run, with the target in its tooltip and a localized "stop" action. It is an accessory status item: no Dock icon, no activation, no focus change.
- Direct `browser_navigate`, `browser_tabs`, `browser_upload`, and `browser_downloads` tools: open a URL, list/select/open/close tabs, upload local files into one file input, and collect page downloads without a decision call. Selecting a tab moves the provider's owned page, its indicator, and every later subgoal to that tab. Upload requires a per-call approval naming every path and refuses relative paths, missing files, directories, and non-file inputs before prompting.
- Deterministic, typed DOM extraction through `browser_extract`, with explicit locators, per-field evidence, and zero decision-model calls.
- A localized run-control page with status, pause/resume, stop, takeover, system permissions, Verified Skill management, and an audit timeline.
- Synthetic and real-browser D1 `box` localization benchmarks.
- Official macOS CUA evaluations covering AX-first actions, AX-less screenshot fallback, Retina/window-point conversion, stale snapshots, resize guards, and independent fixture-state verification.

The visual work is an experimental research prototype. It controls only newly launched, explicitly authorized applications and does not use existing user processes or online accounts.

## Python setup

```bash
uv sync --extra dev
uv run pytest
```

The model loader pins revision `cfe5760ff5d5998f91d9ac56bd4b2dbd96996d41` because `trust_remote_code=True` executes the model repository's custom Python code. The first run downloads approximately 3.84 GB of weights.

## Browser benchmarks

```bash
uv run python -m dsh_cu_decision.benchmark --local-files-only
uv run python -m dsh_cu_decision.browser_benchmark --local-files-only
```

Both runners accept `--text-strategy speculative|on-demand`. The A/B evidence is in [`results/TEXT_STRATEGY_AB.md`](results/TEXT_STRATEGY_AB.md).

The browser runner serves only checked-in fixtures over loopback HTTP and uses an isolated Chrome instance. Successful status requires independent DOM postconditions.

## DSH Browser Use Provider

```bash
npm install --include=dev
npm run build
npm test
npm run test:plugin
```

`npm run test:plugin` loads the built provider through the cordis loader with the real DSH services, then calls `browser_extract`, `browser_observe`, and `browser_control` on a loopback fixture in headless Chromium. It is the plugin-level check; see [`results/PLUGIN_DSH_TEST.md`](results/PLUGIN_DSH_TEST.md).

The provider packages are `packages/dsh-browser-use-d1` and `packages/dsh-computer-use-d1`, with shared contracts in `packages/dsh-cu-core`. They expose `d1_browser_subgoal`, `browser_observe`, `browser_navigate`, `browser_tabs`, `browser_upload`, `browser_downloads`, `computer_subgoal`, and control/publication tools. Subgoals require a narrow goal and structured `verify` assertions. `browser_observe` returns the owned page's current element table without a decision call or input. Browser resources belong to the exact live Agent through the official runtime; PTC is not required. Native actions use official CUA application authorization and AX snapshots. `TYPE_TEXT` uses `setValue` for compatible fields; `PASTE_TEXT` focuses the selected element through relative window coordinates when geometry is available, or uses a screenshot box, then issues one official Paste. Clipboard uncertainty triggers independent readback and stops without automatic input replay. `STALE_APP` permits one fresh application selection before any input. Screenshot fallback uses explicit pixel/window-point mapping.

### Visible control without foreground interruption

Visible Browser launch mode uses a background Chrome session and a nonactivating macOS preview panel. The panel displays the controlled tab, live page title, software cursor, current phase and step, and pause/resume, stop, takeover, and close controls. Pause suspends the active run without aborting it; resume continues the same step. Completion, failure, and takeover keep a result card until it is dismissed. On takeover in launch mode, the provider opens a headed browser with the current cookies, local storage, session storage, scroll position, and typed form values so the user can continue in a real window; attach mode brings the existing owned tab forward. Restored fields are matched by id or name first, and a control whose identity disappeared is left empty instead of receiving another field's value. Native execution uses a nonactivating `NSPanel` cursor and status overlay that follows the authorized window, with the application name and window title. Dynamic D1 execution and zero-model Skill replay share the same activity events and cleanup lifecycle. `headless: true` disables the Browser preview and the takeover window for controlled tests and headless environments.

The Browser Provider accepts `tabUrl` or `tabTitle` in attach mode. A missing or duplicate match, or several open tabs with no selector, fails with `tab_selection_required` instead of silently controlling the first tab. Both providers accept `locale: zh | en` for panel and approval text; model-facing guidance stays English. Visible helpers are compiled once per source build and reused from a private temporary cache.

### Decision latency

The decision service downscales screenshots wider than 800 pixels before vision encoding and leaves normalized boxes untouched. Measured on a 2508-wide window, one decision falls from 879 ms to 310 ms, while six consecutive trials keep selecting `CLICK` on a dense article list. `DSH_CU_VISION_WIDTH` overrides the threshold for interfaces with small targets. `scripts/cua-session.mts` is a resident execution session that reuses the CUA connection, window handles, and indicator across commands, so repeated steps pay only capture and inference. Start the service with `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`; without them the first load retries a model-repository request and stalls for minutes. Screenshot capture costs 350–970 ms depending on window content and is not reducible through the official capture interface. Measurements and boundaries are recorded in [`results/CU_PERFORMANCE.md`](results/CU_PERFORMANCE.md).

The indicators are driven by execution adapters rather than model output. Local input in a native controlled window returns `takeover_detected`; an operation that needs foreground access returns `foreground_required` without automatic activation. Stop, completion, failure, helper exit, and heartbeat loss release input and remove the indicators. Helper processes are compiled into private temporary directories unless `indicatorHelperPath` selects a prebuilt binary.

Run the focused visible-control checks:

```bash
npm test --workspace @albaincompleta/dsh-cu-browser-use-d1 -- tests/indicator.spec.ts
npm run test:e2e --workspace @albaincompleta/dsh-cu-browser-use-d1 -- tests/visible-browser.e2e.ts
npm run test:e2e --workspace @albaincompleta/dsh-cu-computer-use-d1 -- tests/indicator.e2e.ts
npm test --workspace @albaincompleta/dsh-cu-computer-use-d1 -- tests/provider.spec.ts -t "preserves continuous foreground input"
```

These checks inspect real macOS windows, exercise all three controls through Accessibility, verify foreground and system-pointer preservation, confirm continuous foreground typing during dynamic and Skill execution, and cover normal cleanup and forced helper termination. Evidence is recorded in [`results/VISIBLE_CONTROL_ACCEPTANCE.md`](results/VISIBLE_CONTROL_ACCEPTANCE.md).

The Browser Provider also exposes `browser_extract`, a read-only structured extraction tool. It accepts 1–40 fields with explicit `label`, `role`, `text`, or `css` locators and `string`, `number`, `boolean`, or `url` result types. `all: true` returns an array (capped at 200 values), `attribute` reads an attribute instead of element content, and `required: false` records an absent element in `missing`. An element that exists with a blank value is data, not absence: a `string` field returns `""` and is listed in `empty`, while `number`, `boolean`, and `url` fields reject a blank value as `empty_value`. Required fields whose element is absent, ambiguous locators, and values that cannot be coerced to the requested type fail closed. Results include the source URL, page title, per-field match counts, and `trusted: false`; extracted page content remains untrusted data. Extraction does not call D1 or dispatch input. Fields are read sequentially rather than as an atomic multi-field snapshot. Cancellation stops the caller's wait, but a Playwright navigation or read already in progress may still complete in the background.

```json
{
  "url": "http://127.0.0.1:8080/filters.html",
  "fields": [
    { "name": "adults", "type": "number", "locator": { "kind": "label", "text": "Adults" } },
    { "name": "nonstop", "type": "boolean", "locator": { "kind": "label", "text": "Nonstop only" } }
  ]
}
```

Browser control and publication tools are `browser_control` and `browser_skill_publish`; navigation, tab, upload, and download tools are `browser_navigate`, `browser_tabs`, `browser_upload`, and `browser_downloads`; native equivalents are `computer_control` and `computer_skill_publish`. The defaults are disjoint, so both providers can be mounted in one composition. `toolPrefix` changes every browser tool name (for example, `web` produces `web_extract`, `web_observe`, `web_navigate`, `web_tabs`, `web_upload`, `web_control`, and `web_skill_publish`).

Verified URL Skills are pinned to an exact HTTP(S) origin and path; built-in fixture Skills only match loopback URLs. Explicit replay at another origin stops with `skill_origin_mismatch`, and the origin is rechecked before every replay action and every successful return. Same-origin path navigation remains allowed. Every publishable Skill carries independent postconditions. Before persistence, captured input values in those assertions are replaced with `{{inputs:...}}` placeholders; replay hydrates them with the current structured inputs and checks both the Skill's assertions and the caller's `verify` assertions. Candidates whose URL, window title, or step metadata contains raw captured input are not created. Repeated text-entry steps receive collision-free per-step input keys, so redaction and replay preserve every value in order. Conflicting structured/captured values and URL-encoded representations of captured input also prevent candidate creation. Legacy records without an origin or persisted postconditions can be read for migration, but cannot be published or replayed. Native Skills use an exact `appBundleId` scope when the application supplies it, with exact `windowTitle` matching as the fallback. Built-in fixture Skills require an explicit `skillId`. Native `paste` steps preserve structured-input placeholders and use the same bounded replay path as other Skill actions.

The control page URL returned by `*_control` carries a per-server page token in a fragment; the fragment itself is not sent to the server, and the configured `controlToken` never enters a tool result. The page stores the page token in session storage and sends it as a bearer credential. The page shows current and last run state, system permission rows with settings shortcuts, Verified Skill records with removal, and the audit timeline. `browser_observe` and `browser_extract` results remain untrusted data.

The shared subgoal and safety contract is `benchmarks/computer-subgoal-v1.schema.json`. Runtime controls include credential/login gates, consequential-action confirmation, duplicate-target escalation, pending-UI waits, stale-input rejection, independent postconditions, and per-run wall-clock/input-token/output-token budgets covering model decisions, input, Skill replay, and waits. P2 adds Verified Skill → D1 → DeepSeek/human routing; every result records `route`, `skillId`, and `fallbackReason`. P3 adds candidate generation, independent rerun verification, explicit user approval, immutable publication, persistent Skill stores, and versioned evolution through `evolvedFrom` after a bounded repair. P4 adds DSH `userQuestions` approval, run control, pause/resume/stop/takeover, a localized loopback control page, and durable audit. Action approvals name the operation, target, and scope, and cover one action; login approval triggers on credential input or a sign-in click, not on merely observing a password field. Thrown permission and stale-state errors carry a stable reason and recovery text. `auditRetentionDays` configures audit retention with a 30-day default; audit and Skill files use private permissions, while decision and CUA debug logs retain structural metadata without raw goals, inputs, typed values, or screenshots. P5 completes the scenario matrix and scope decision. See `results/REAL_APP_ACCEPTANCE.md`, `results/THIRD_PARTY_ACCEPTANCE.md`, `results/P5_EVALUATION.md`, `results/P4_CONTROL.md`, `results/P3_SKILLS.md`, and `results/P2_ROUTING.md`.

Run the real-model e2e after starting the loopback decision service:

```bash
uv run python -m dsh_cu_decision.server \
  --port 8765 --token test-token --local-files-only

D1_DECISION_TOKEN=test-token npm run test:e2e
```

The comparison suite uses the same local flight task with scripted official Playwright MCP and the D1 Provider. Its scope is a control-layer comparison, not a DeepSeek planner comparison.

## D1 box benchmarks

```bash
uv run python -m dsh_cu_decision.visual_benchmark --local-files-only
uv run python -m dsh_cu_decision.visual_browser_benchmark --local-files-only
```

Reports:

- `results/d1-box-synthetic.json`
- `results/d1-box-browser.json`

## Official macOS CUA visual prototype

Checkout `deepseek-ai/deepseek-harness` at `dsh-v0.2.2-alpha.2`, then build the native helper:

```bash
swift build \
  --package-path /tmp/dsh-official-alpha2/packages/experimental/cua-macos/native \
  --configuration release
```

Run the AX-present visual evaluation and the true AX-less fallback:

```bash
uv run python -m dsh_cu_decision.official_cua_visual \
  --execute --local-files-only

uv run python -m dsh_cu_decision.official_cua_axless_visual \
  --local-files-only
```

These commands compile and control only disposable official AppKit fixtures. They require macOS Accessibility and Screen Recording permissions and an unlocked session. They do not change system permissions, select user applications, or use user data.

See [`results/VISUAL_DECISION_REPORT.md`](results/VISUAL_DECISION_REPORT.md) for raw metrics, native outcomes, and the bounded integration verdict.

## P0 task suite and baseline

```bash
uv run python -m dsh_cu_decision.workflow_e2e --local-files-only
uv run python -m dsh_cu_decision.browser_benchmark \
  --case login-blocked --case ambiguous-save --case delayed-results \
  --local-files-only --output results/P0_BROWSER_NEGATIVE.json
uv run python -m dsh_cu_decision.p0_report
```

The reproducible scenario catalog is `benchmarks/scenarios.json`. The generated baseline is `results/P0_BASELINE.md`; it preserves the current credential, ambiguity, and repeated-action failures instead of treating all controlled successes as production readiness.

## Agent Skill evaluation

The repository root is also an Agent Skill (`SKILL.md`) with a 12-case skill-up routing suite in `evals/`. It evaluates tool selection, control, publication, and refusal behavior, not live browser or native execution.

```bash
skill-up validate evals/eval.yaml
skill-up run evals/eval.yaml
skill-up run evals/eval.yaml --iteration 3
```

Results and limitations are in [`results/SKILL_EVAL.md`](results/SKILL_EVAL.md).

## Safety and model license

D1 is not a permission or completion authority. Fresh-state checks, application ownership, verification, and escalation remain outside the model. Current results do not justify unattended desktop control.

`d1-2B` uses the LFM Open License v1.0, not Apache-2.0 or MIT. Review the [license](https://huggingface.co/LiquidAI/d1-2B/blob/main/LICENSE) before redistribution or commercial use; it includes a commercial-use revenue threshold condition.
