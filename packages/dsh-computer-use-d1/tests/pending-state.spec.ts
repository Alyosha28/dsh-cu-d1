import { expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import type { NativeCaller } from '../src/controller.ts'
import { hasPendingState, PENDING_PROBE_MAX_MS, PENDING_PROBE_MAX_READS, runComputerSubgoal } from '../src/controller.ts'

const WINDOW = { windowId: 2, title: 'Fixture', isOnScreen: true, bounds: { x: 0, y: 0, width: 500, height: 400 } }

it('recognises pending work only from structural indicators', () => {
  expect(hasPendingState({ tree: '- [1] AXProgressIndicator bounds=[0.0,0.0,20.0,20.0]' })).toBe(true)
  expect(hasPendingState({ tree: '- [1] AXButton busy=true "Save"' })).toBe(true)
  expect(hasPendingState({ tree: '- [1] AXButton busy="true" "Save"' })).toBe(true)
  // Content is not an indicator: a document, a chat transcript or a log window
  // that merely contains the word "waiting" must not stall every step.
  expect(hasPendingState({ tree: '- AXStaticText = "Waiting for the export to finish"' })).toBe(false)
  expect(hasPendingState({ tree: '- AXStaticText = "Loading complete"' })).toBe(false)
  expect(hasPendingState({ tree: '- AXStaticText = "加载中"' })).toBe(false)
  expect(hasPendingState({ tree: '- [1] AXButton "Waiting…" actions=["AXPress"]' })).toBe(false)
  expect(hasPendingState({})).toBe(false)
})

interface ProbeResult { elapsedMs: number; stateReads: number; result: Record<string, unknown> }

async function runWithTree(tree: string): Promise<ProbeResult> {
  let stateReads = 0
  const caller = {
    async call(method: string) {
      if (method === 'getCapabilities') return { sessionLocked: false, permissions: { accessibility: true, screenRecording: true } }
      if (method === 'getApp') return { appHandle: 'app-1', pid: 42, bundleId: 'fixture.app' }
      if (method === 'listWindows') return [WINDOW]
      if (method === 'getState') { stateReads += 1; return { pid: 42, snapshotId: `snapshot-${stateReads}`, truncated: false, windows: [WINDOW], tree } }
      if (method === 'screenshot') return { bounds: WINDOW.bounds, pixelWidth: 500, pixelHeight: 400, windowId: 2, coordinateSpace: 'window-points', data: '', mimeType: 'image/png' }
      return { dispatched: true }
    },
  } as unknown as NativeCaller
  const decisionClient = {
    async decide() {
      return {
        decision: { operation: 'CLICK', target: '1' },
        usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, textExtractionCalls: 0,
      }
    },
  } as never
  const started = Date.now()
  const result = await runComputerSubgoal(
    // A 5 s async budget with an instant verification window isolates the probe.
    caller, decisionClient, Config({ decisionToken: 'test-token', asyncTimeoutMs: 5000, verificationTimeoutMs: 0 }),
    { goal: 'Click once', app: '42', windowId: 2, verify: [{ type: 'text_visible', text: 'Never present' }], maxSteps: 1 },
    new AbortController().signal,
  )
  return { elapsedMs: Date.now() - started, stateReads, result: result as unknown as Record<string, unknown> }
}

it('bounds a pending probe instead of stalling for the full async budget', async () => {
  const pending = await runWithTree('- [1] AXButton "Run" actions=["AXPress"] bounds=[10.0,20.0,100.0,40.0]\n- [2] AXProgressIndicator bounds=[10.0,80.0,20.0,20.0]')
  expect(pending.result.status).toBe('escalated')
  // Config allows 5 s; the probe is capped by PENDING_PROBE_MAX_MS and the read budget.
  expect(pending.elapsedMs).toBeLessThan(PENDING_PROBE_MAX_MS + 1200)
  // Each probe iteration costs at most one verification read plus one state read.
  expect(pending.stateReads).toBeLessThanOrEqual(PENDING_PROBE_MAX_READS * 3 + 4)
})

it('does not wait at all when the tree only contains the word "Waiting"', async () => {
  const chatty = await runWithTree('- [1] AXButton "Run" actions=["AXPress"] bounds=[10.0,20.0,100.0,40.0]\n- AXStaticText = "Waiting for the export to finish"')
  expect(chatty.result.status).toBe('escalated')
  expect(chatty.elapsedMs).toBeLessThan(1500)
})
