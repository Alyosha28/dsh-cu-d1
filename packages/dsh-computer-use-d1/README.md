# @dsh-cu/computer-use-d1

D1 macOS Computer Use provider for DeepSeek Harness, using the official CUA application/window API for authorization, observation, and input.

```ts
await ctx.plugin(ComputerD1Provider, {
  helperPath: '/path/to/dsh-cua-native',
  allowedApps: [{ id: executablePathGrant, name: 'TextEdit', executablePath: textEditPath }],
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

Build the helper from the official `deepseek-ai/deepseek-harness` `dsh-v0.2.2-alpha.2` checkout with `swift build --package-path packages/experimental/cua-macos/native --configuration release`.

`computer_subgoal` requires an application, independent `verify` assertions, and an explicit `windowId` when multiple windows are visible. Existing applications and operations remain subject to official CUA consent and Provider policy. Credentials, payments, deletion, messaging, irreversible actions, and unattended production are outside the accepted scope. See the project `results/REAL_APP_ACCEPTANCE.md` and `results/THIRD_PARTY_ACCEPTANCE.md` for measured application and environment boundaries.

Native input supports `CLICK`, `TYPE_TEXT`, `PASTE_TEXT`, semantic increments and decrements, scrolling, waiting, and screenshot-box targets. `PASTE_TEXT` focuses the intended element through relative window coordinates when geometry is available, or uses a visual point, then dispatches one official CUA Paste. `PASTE_NOT_CONSUMED` and clipboard changes trigger independent postcondition readback; an unconfirmed result stops without replaying input or substituting typing. `STALE_APP` permits one fresh application selection before input. When AX omits the writable body, the Provider supplies a window screenshot to the local decision service.

Verified native Skills use exact `appBundleId` scope when available, otherwise exact `windowTitle` scope. Built-in fixture Skills require an explicit `skillId`. Skill replay supports native `paste` steps, structured-input placeholders, independent postconditions, and the same wall-clock and step budgets as D1 execution.

Dynamic execution and Skill replay share a nonactivating macOS indicator helper. It draws a software cursor at the actual action coordinates, follows the authorized window, and provides working pause, stop, and takeover controls. The cursor and status panels do not enter model screenshots. Local input in the controlled window returns `takeover_detected`; an action that requires foreground access returns `foreground_required` without automatic activation. Completion, stop, failure, helper exit, and heartbeat loss remove the indicators.

The indicator helper is compiled from the bundled Swift source into a private temporary directory and removed with the Provider resource. `indicatorHelperPath` can select a prebuilt helper. Only operational metadata, window geometry, and action coordinates cross the helper boundary; typed values and verification content are excluded.
