# Changelog

## Unreleased — 供应链与文档契约修正

Security and documentation corrections from the supply-chain audit
(`redteam/findings/supply.md`, blue-team fixes SR-01…SR-06, SR-08, SR-09, SR-11).
No runtime behavior of the tools changed.

- **Publish gate (SR-01).** New `scripts/verify-dist.mts` checks that `main`,
  `types`, and every `exports` target exist on disk and in the `npm pack`
  listing, and that a tarball holds more than two files. Every published package
  runs it through `prepublishOnly`; `publish:plugin` runs the same gate before
  each `npm publish`, so a publish from a clean checkout can no longer ship a
  two-file package.
- **Internal dependency gate (SR-02).** `publish:plugin` matched internal
  dependencies with a hard-coded `@dsh-cu/` prefix, which stopped matching when
  the packages were renamed to `@albaincompleta/dsh-cu-*`; the gate could never
  fire. It now matches the repository's own workspace package names and refuses
  a downstream package whose internal dependency is not on the registry.
- **Doctor tells the truth (SR-03 / SR-04).** `plugin:doctor` resolves and
  imports the bundle, core, the browser provider and the browser-use registry
  from the profile: a missing or unimportable package is a FAIL, not a green
  run. A version mismatch is a FAIL instead of a WARN that still exited 0.
  Duplicate `- id:` rows are reported (the parser no longer lets a later row
  overwrite an earlier one), entry counts are real `- id:` line counts, and a
  `decisionToken`/`controlToken` that resolves to the bundle's published
  defaults is a FAIL with the variables to set instead.
- **Installer containment and rollback (SR-05 / SR-06).** `install:plugin
  --profile` accepts only `^[a-z0-9][a-z0-9._-]{0,63}$` and must resolve under
  `DSH_HOME/profiles/` after `realpath`, so `../..` and symlinked profiles are
  refused before anything is written. The manifest is written through a
  temporary file and renamed, exactly one `package.json.bak` is kept, and a
  failed install or doctor restores the backup. `install:desktop-profile` gets
  the same rollback, a single backup, and an atomic manifest write; its
  `--dry-run` now prints the plan before the app-running guard and the missing
  manifest guard.
- **Plugin acceptance (SR-08).** `npm run test:plugin` asserted the literal
  `true` for "plugin entry imports"; it now imports the built entry and asserts
  `apply` is a function. The JSON report goes to a temporary directory unless
  `--report=<path>` is passed, so a test run no longer rewrites a tracked file
  under `results/`.
- **Publish token (SR-11).** The temporary npmrc that carries `NPM_TOKEN` lives
  in a private `mkdtemp` directory and is removed on every exit path, including
  `process.exit` and SIGINT/SIGTERM, instead of leaking a token file when a
  publish fails.
- **Decision service limits (SR-09).** `Image.MAX_IMAGE_PIXELS` is capped at 40
  million pixels with an explicit header check, a decoded screenshot above
  8 MiB is refused (the unreachable 8 MiB branch behind a 1 MiB body cap is
  gone), the handler has a 15 s socket timeout, and failures are logged through
  a real logger instead of the `hasattr` no-op.
- **Bundle entry.** `packages/dsh-cu-bundle/index.js` contained a TypeScript
  return annotation (`apply(): void`) in a file shipped as plain JavaScript, so
  `import()` of the package failed with `SyntaxError: Unexpected token ':'`.
  Fixed; the doctor's import check now catches this class of defect.
- **Docs.** `README.md` states what the doctor actually checks and does not
  check, what the installer and publish gates guarantee, that a model cannot
  pre-authorize a consequential action through tool arguments, and that the
  bundle's built-in tokens are public. `results/MATURITY.md` no longer cites
  incompatible denominators or a fixed unit-test count.

## 0.2.8 — 2026-10-31

- Rename every package from `@dsh-cu/*` to `@alyosha28/dsh-cu-*` so the packages
  can be published under a personal npm scope without creating an organization:
  `@albaincompleta/dsh-cu-core`, `-browser-use-d1`, `-computer-use-d1`, `-client`,
  `-bundle` (and the private `-testkit`). Imports, manifests, the bundle patch,
  tests and docs follow; profiles were re-linked to the new names.
- `@albaincompleta/dsh-cu-bundle` now depends on the other four packages, so a single
  `dsh plugin add @albaincompleta/dsh-cu-bundle` installs the whole plugin.
- Add `scripts/publish-packages.mts` (dry run by default, dependency order,
  registry checks, NPM_TOKEN support) and `scripts/rename-scope.mts`.
- Published to npm at 0.2.8: `@albaincompleta/dsh-cu-core`, `-browser-use-d1`,
  `-computer-use-d1`, `-client`, `-bundle`. Verified by installing
  `@albaincompleta/dsh-cu-bundle` from the registry into an empty profile and
  running `browser_tabs` end to end.

## 0.2.7 — 2026-10-31

- Add the client half, `@albaincompleta/dsh-cu-client`: a Loader entry whose package declares
  `dsh.client`, so the DSH client module scanner serves its browser bundle and
  the transcript renders DSH-CU tools as first-class cards instead of raw JSON.
  Cards cover every browser and native tool, show status, route, a one-line
  summary (element count, tab count, extracted fields, uploaded files), and an
  expandable payload.
- The client module is plain `window.__ModuleLoader__.load({ id, factory })`
  JavaScript with no bundler step, and registers through
  `ctx.slots.register({ name: 'tool.call.toolview', key, ... }, Card)`.
- The bundle patch now mounts the client entry next to the registries, and the
  installer links `@albaincompleta/dsh-cu-client` too.
- Verified in a real `dsh web` session: the model called `browser_tabs`, and the
  transcript rendered `标签页 · 完成 · 1 个标签页` with `data-dsh-cu-status`
  reflecting the tool result.

## 0.2.6 — 2026-10-31

- Native runs now ask macOS for a missing grant instead of only reporting it:
  `PermissionPrompt.swift` calls `AXIsProcessTrustedWithOptions` (Accessibility)
  and `CGRequestScreenCaptureAccess` (Screen Recording) once per process, and
  the tool result carries `prompted`, a deep link to the exact System Settings
  pane, and recovery text that says the dialog appeared.
- `promptPermissions` (default `true`) controls whether the dialog is shown.
- The control page's permission button now requests the grant and opens the
  matching pane, rather than only opening System Settings.
- `plugin:doctor` reads the real privacy state through the same helper and
  reports Accessibility and Screen Recording as PASS/WARN with the settings URL,
  so the gap is visible before the first failing run.
- Preflight (`status` mode) never shows a dialog; only an explicit request does.

## 0.2.5 — 2026-10-31

- Add `npm run install:plugin -- --profile=<name>`: installs the four packages by
  link, mounts `@albaincompleta/dsh-cu-bundle` in `dsh.profile.bundles`, backs the manifest up
  first, warns when the profile lists no app bundle, and finishes with the
  doctor. `--dry-run` prints every step without changing anything.
- Verified on a profile created from scratch: install → doctor → headless run
  calling `browser_tabs` end to end.

## 0.2.4 — 2026-10-31

- A menu-bar item marks an active run system-wide: the native helper and the
  macOS browser preview helper each show `◉ DSH-CU` with the target in its
  tooltip and a localized "停止" menu action, and remove it on finish, stop,
  takeover, or helper exit. The item never activates the app or steals focus.
- Both helpers report the item's real `NSStatusItem.isVisible` state, so a test
  can prove it appeared and disappeared rather than merely that code ran.

## 0.2.3 — 2026-10-31

- Mark the controlled tab itself while a run is active: the page title gets a
  `● DSH-CU 控制中 · ` prefix and the favicon a colored dot, so the browser tab
  strip shows which tab is being driven even when the page overlay is out of
  view. The marker survives page renames and navigations, and is removed on
  finish, stop, failure, and takeover. Titles the provider reports back
  (observe, extract, navigate, tabs, subgoal decisions) strip the marker, so it
  never becomes page content or Skill text.
- Add `browser_downloads`: list files the page downloaded, or wait for the
  latest download to finish. Each entry carries a sanitized name, an absolute
  path, and a byte count; downloads land in `downloadDir` or a private temp
  directory.
- Root `npm run build` now builds `core` and `testkit` before the providers, so
  a clean checkout compiles in one pass.

## 0.2.2 — 2026-10-31

- Add `browser_upload`: uploads local files into one file input after an
  explicit per-call approval that names every path. Refuses relative paths,
  missing files, directories, non-file inputs, and more than 50 MB per call
  before the approval prompt appears.
- Share one locator resolver between extraction and upload so both resolve
  `label`, `role`, `text`, and `css` locators identically.

## 0.2.1 — 2026-10-31

- Add `browser_navigate`: opens an HTTP(S) URL in the owned page with no decision
  call, refuses other schemes and embedded credentials, and returns the final URL
  and page title as untrusted data.
- Add `browser_tabs`: list, select, open, and close tabs of the controlled
  browser. Selecting or closing rebinds the owned page, the run indicator, and
  every later subgoal; the tools refuse while a run is active and refuse to close
  the last tab.
- Both tools honour the configured `toolPrefix` and are wrapped by the same
  exact-Agent ownership check as the other browser tools.

## 0.2.0 — 2026-10-31

Runtime alignment and installability.

- Target `@deepseek-ai/*` 0.2.1-rc.5 and `@deepseek-ai/cordis` 4.0.5, the versions
  the DeepSeek Harness desktop application runs. 0.1.0 was built against
  0.2.2-alpha.2, which the Harness compatibility gate refuses to load.
- Add `@albaincompleta/dsh-cu-bundle`: a profile bundle whose `dsh.bundle.patch` inserts the
  browser-use registry, the D1 Browser provider, and the disabled-by-default
  native pair. Install it with `dsh plugin --profile <name> add` and list
  `@albaincompleta/dsh-cu-bundle` in `dsh.profile.bundles`.
- Declare `engines.dsh` on every package so a profile reports an explicit,
  readable compatibility failure instead of silently skipping the provider.
- Add `npm run plugin:doctor`, which composes a profile, verifies the plugin
  entries are present and enabled, detects a competing browser provider, and
  compares the plugin's DSH package version with the host's.
- `@albaincompleta/dsh-cu-testkit` replaces the DSH 0.2.2-only `dsh-tool-testkit`; tests call
  the production tool registry directly.
- The native CUA caller uses the 0.2.1 single-call `tools.execute` contract.
- Browser launch falls back to an installed Chrome or Edge when Playwright's own
  build is absent, and reports `browser_unavailable` with a recovery step
  instead of a raw Playwright stack.
- `browser_extract` distinguishes an absent element from a present but empty
  value: `""` for strings, `empty_value` for typed fields, `empty` in evidence.
- Launch-mode takeover transfers session storage, scroll position, and typed
  form values, matching fields by id, unique name, then position.

## 0.1.0 — 2026-10-31

Initial provider packages: D1 Browser Use and native Computer Use providers,
Verified Skill lifecycle, run control, approvals, control page, localization,
and the browser/native acceptance suites.
