# @alyosha28/dsh-cu-browser-use-d1

D1 Browser Use provider for DeepSeek Harness. It maps bounded structured decisions to browser actions and requires independent postconditions for success.

```ts
await ctx.plugin(BrowserD1Provider, {
  mode: 'launch',
  headless: false,
  decisionEndpoint: 'http://127.0.0.1:8765',
  decisionToken: process.env.D1_DECISION_TOKEN!,
  maxWallClockMs: 120000,
  maxInputTokens: 100000,
  maxOutputTokens: 10000,
  auditDir: '.dsh-cu/audit',
  auditRetentionDays: 30,
  controlToken: process.env.DSH_CU_CONTROL_TOKEN,
})
```

The decision endpoint must be a loopback HTTP URL. Start the local service with `uv run python -m dsh_cu_decision.server --port 8765 --token "$D1_DECISION_TOKEN" --local-files-only` from the DSH-CU project.

`d1_browser_subgoal` accepts a narrow goal and structured `verify` assertions. `browser_observe` reads the owned page, `browser_extract` reads explicit typed fields, `browser_navigate` opens a URL, `browser_tabs` lists/selects/opens/closes tabs, and `browser_upload` puts local files into one file input after a per-call approval that names every path. `browser_control` exposes status, pause, resume, stop, and takeover. Skill capture is opt-in through `skillStorePath` and `captureSkills`; publication requires independent evidence and user approval.

Visible launch mode (`headless: false`, the default) keeps Chrome in the background and presents the controlled tab in a nonactivating macOS preview panel. The panel continuously displays page frames, the software cursor, the current action, and working pause, stop, and takeover controls. Dynamic D1 execution, zero-model Skill replay, and structured extraction share this lifecycle. Completion, control actions, failure, helper exit, and heartbeat loss remove the panel and release control. `headless: true` is available for controlled tests and headless environments. Attach mode renders the software cursor and control panel inside the explicitly configured controlled tab through a Chrome DevTools isolated world.

The preview helper is compiled from the bundled Swift source into a private temporary directory and removed with the Provider resource. `indicatorHelperPath` can select a prebuilt helper. No input text, verification data, or page goal is sent to the preview process.
