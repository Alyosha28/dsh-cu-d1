# D1 AX + screenshot visual decision report

## Scope and verdict

This evaluation used only generated images, isolated local Chrome fixtures, and newly compiled disposable AppKit fixtures from the official DeepSeek Harness CUA tests. No user application, account, document, browser profile, or irreversible action was involved.

**Verdict:** D1-2B is suitable for a **limited AX-first, screenshot-box-fallback Computer Use Provider prototype**. The evidence supports controlled integration with owned windows and independent outcome verification. It does not support unattended general desktop control, nor does it establish reliability on real third-party applications, remote desktops, video streams, or heavily occluded interfaces.

## 1. Synthetic box benchmark

Eleven generated images covered simple and retina-scaled buttons, dialogs, a small checkbox, similar destination options, Chinese labels, dense toolbars, a canvas-like chart, duplicate Save buttons in different sections, and two absent-target cases.

| Metric | Result |
|---|---:|
| Total correct | **11/11** |
| Present-target centers inside ground truth | **9/9** |
| Present targets with IoU ≥ 0.5 | **9/9** |
| Correct absent-target rejection | **2/2** |
| Median IoU | **0.9759** |
| Median center error | **0.781 px** |
| Median inference latency | **368.9 ms** |
| p95 latency, including first-use cold work | **751.0 ms** |

Raw evidence: `results/d1-box-synthetic.json` and `fixtures/visual/`.

## 2. Real Chrome screenshot benchmark

D1 received only pixels. Playwright was used solely to render safe local fixtures and produce independent ground-truth boxes. Cases included form fields, a small checkbox, similar options, a missing payment action, and a 2× screenshot.

| Metric | Result |
|---|---:|
| Total correct | **7/7** |
| Present-target centers inside ground truth | **6/6** |
| Present targets with IoU ≥ 0.5 | **6/6** |
| Correct absent-target rejection | **1/1** |
| Median IoU | **0.9560** |
| Median inference latency | **386.4 ms** |
| Retina case median latency | **643.0 ms** |

Raw evidence: `results/d1-box-browser.json` and `fixtures/visual-browser/`.

## 3. Official CUA AX-present visual evaluation

The official native helper reported Accessibility and Screen Recording as granted and the macOS session as unlocked. A disposable AppKit fixture supplied the target's AX bounds and independently recorded clicks.

- Screenshot: **840×1064 px**; window: **420×532 points**, confirming 2× scaling.
- D1 confidence: **0.9937**.
- Predicted center error: **0.437 px**.
- IoU: **0.6814**—the predicted box was tighter than the AX box, but its center remained inside the target.
- Visual coordinate click changed the fixture count to **1**.
- Reusing an old AX snapshot returned `STALE_SNAPSHOT`; the count stayed **1**.
- A fresh AX click then changed the count to **2**.

Raw evidence: `results/official-cua/report.json`, `results/official-cua/primary.png`, and `results/official-cua-run.log`.

## 4. Official AX-less fallback and resize guard

This run used the official `AxlessFixture.swift` rather than a user application.

1. **AX-first:** a fresh AX element click succeeded with **zero model calls**, independently changing the count to 1.
2. **AX removed:** `getState` returned an empty element list. D1 received only the window screenshot.
3. **Visual fallback:** D1 confidence was **0.9846**. Its box contained the fixture-provided true button point, with **0.306 point** center error. The click independently changed the count to 2.
4. **Resize:** after the fixture resized, replaying the old visual coordinates returned `WINDOW_CHANGED`; the count remained 2.

The screenshot was **720×424 px** for a **360×212 point** window, again validating the 2× coordinate conversion.

Raw evidence: `results/official-cua/axless-report.json`, `results/official-cua/axless.png`, and `results/official-cua-axless-run.log`.

## Engineering rules supported by the evidence

- Use AX elements whenever a fresh, authorized AX path exists; avoid a model call.
- Use screenshot box decisions only when semantic observation is absent or insufficient.
- Convert normalized visual coordinates to native **window points**, not screenshot pixels.
- Reject stale snapshots and changed window geometry; never replay uncertain input automatically.
- Treat `dispatched: true` as unverified until fresh application-specific state confirms the outcome.
- Keep permissions, application ownership, safety policy, and completion assertions outside D1.
- Run the model in a persistent warm process for latency measurements and future integration. Cold native visual calls in these runs took approximately **5.3–5.6 seconds**.

## Remaining limits

The fixtures are small and controlled. They do not measure third-party native app complexity, video compression, remote-desktop latency, dynamic occlusion, unusual themes, tiny icon recognition, or long-horizon recovery. The AX-present IoU result also shows that high confidence and a valid click center do not imply a tight bounding box.

A standard-preset CU Provider should therefore remain experimental and constrained to explicitly owned windows, reversible test operations, fresh-state validation, and user-visible escalation.
