import { afterEach, expect, it, vi } from 'vitest'
import { executeNative, getNativeApp, NativeCaller, parseAxElements, runComputerSubgoal, verifyNative } from '../src/controller.ts'
import { Config } from '../src/config.ts'

const tree = `AX scope=window offsets=UTF-16 bounds=global-points
- [0] AXWindow "DSH Workflow Fixture" actions=["AXRaise"] bounds=[221.0,510.0,520.0,332.0]
  - [1] AXTextField focused valueWritable=true = "/tmp/report.csv" placeholder="Report path" id="dsh-workflow-path" actions=["AXShowMenu","AXConfirm"] bounds=[250.0,640.0,462.0,38.0]
  - [2] AXButton "Import report" id="dsh-workflow-import" actions=["AXPress"] bounds=[250.0,706.0,182.0,42.0]
  - [3] AXButton subrole=AXZoomButton disabled actions=["AXPress"]`

it('parses actual values, placeholders, actions, identifiers and bounds from official AX text', () => {
  const elements = parseAxElements(tree, { title: 'DSH Workflow Fixture' })
  const field = elements.find(element => element.id === '1')!
  expect(field).toMatchObject({
    role: 'AXTextField', name: 'Report path', value: '/tmp/report.csv',
    identifier: 'dsh-workflow-path', focused: true, bounds: [250, 640, 462, 38],
  })
  expect(field.actions).toContain('type')
  expect(field.actions).toContain('paste')
  const button = elements.find(element => element.id === '2')!
  expect(button.name).toBe('Import report')
  expect(button.actions).toContain('click')
  expect(elements.find(element => element.id === '3')?.enabled).toBe(false)
  expect(parseAxElements('- [4] AXDocument "Body" = ""', { title: 'Document' })[0]?.actions).toContain('paste')
})

it('verifies visible AX text without matching element indices or metadata', async () => {
  async function visible(tree: string, text: string): Promise<boolean> {
    const caller = {
      async call() { return { tree, windows: [], pid: 1, truncated: false } },
    } as unknown as NativeCaller
    return verifyNative(caller, { windowId: 1 }, [{ type: 'text_visible', text }], new AbortController().signal)
  }

  expect(await visible('- [15] AXButton description="Two" id="Two" actions=["AXPress"]', '15')).toBe(false)
  expect(await visible('- AXStaticText selectionWritable=false = "15"', '15')).toBe(true)
})

it('verifies the explicitly selected native window rather than the focused window', async () => {
  const caller = {
    async call() {
      return { pid: 77, focusedWindowId: 3, tree: '- AXStaticText = "idle"', windows: [], truncated: false }
    },
  } as unknown as NativeCaller
  expect(await verifyNative(caller, { windowId: 2 }, [{ type: 'url_contains', value: 'app://77/3' }], new AbortController().signal)).toBe(false)
  expect(await verifyNative(caller, { windowId: 2 }, [{ type: 'url_contains', value: 'app://77/2' }], new AbortController().signal)).toBe(true)
})

it('keeps native input values and verification errors out of debug logs', async () => {
  process.env.DEBUG_CUA = '1'
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const ctx = {
    tools: {
      async execute() {
        return { results: [{ result: { isError: false, value: { dispatched: true } } }] }
      },
    },
  } as any
  const caller = new NativeCaller(ctx, { id: 'agent-1' } as any)
  await caller.call('setValue', { value: 'private-native-input', snapshotId: 'snapshot-1' }, new AbortController().signal)
  const failing = { async call() { throw new Error('private-verification-error') } } as unknown as NativeCaller
  expect(await verifyNative(failing, {}, [{ type: 'text_visible', text: 'Done' }], new AbortController().signal)).toBe(false)
  const logs = errors.mock.calls.map(call => call.map(String).join(' ')).join('\n')
  expect(logs).toContain('CUA_CALL')
  expect(logs).toContain('CUA_VERIFY_ERROR')
  expect(logs).not.toContain('private-native-input')
  expect(logs).not.toContain('private-verification-error')
})

it('maps native paste to one target focus and one official Paste call', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const caller = {
    async call(method: string, params: Record<string, unknown>) {
      calls.push({ method, params })
      return { dispatched: true }
    },
  } as unknown as NativeCaller
  await executeNative(caller, { appHandle: 'app-1', windowId: 2, details: true }, {
    snapshot_id: 'snapshot-1', version: 0, url: 'app://1/2', title: 'Document',
    truncated: false, can_scroll_up: false, can_scroll_down: false,
    windowBounds: { x: 100, y: 200, width: 1000, height: 800 },
    elements: [{ id: '4', role: 'AXDocument', name: 'Body', value: '', actions: ['paste'], enabled: true, focused: false, bounds: [150, 260, 400, 100] }],
  }, { operation: 'PASTE_TEXT', target: '4', text: 'Literal document body' }, new AbortController().signal,
  // The frame re-read right before dispatch: unchanged, so the fractional
  // screenshot-space mapping is valid and the click is window-relative.
  undefined, { x: 100, y: 200, width: 1000, height: 800 })
  expect(calls).toEqual([
    { method: 'click', params: { appHandle: 'app-1', snapshotId: 'snapshot-1', windowId: 2, x: 250, y: 137, relative: true } },
    { method: 'paste', params: { appHandle: 'app-1', text: 'Literal document body' } },
  ])
})

it('does not replay paste or substitute typing after an uncertain clipboard result', async () => {
  const calls: string[] = []
  const caller = {
    async call(method: string) {
      calls.push(method)
      if (method === 'paste') throw new Error('PASTE_NOT_CONSUMED: inspect before retrying')
      return { dispatched: true }
    },
  } as unknown as NativeCaller
  await expect(executeNative(caller, { appHandle: 'app-1', windowId: 2 }, {
    snapshot_id: 'snapshot-1', version: 0, url: 'app://1/2', title: 'Document',
    truncated: false, can_scroll_up: false, can_scroll_down: false,
    elements: [{ id: '4', role: 'AXDocument', name: 'Body', value: '', actions: ['paste'], enabled: true, focused: false }],
  }, { operation: 'PASTE_TEXT', target: '4', text: 'Literal document body' }, new AbortController().signal))
    .rejects.toThrow('PASTE_NOT_CONSUMED')
  expect(calls).toEqual(['click', 'paste'])
})

it('reselects a stale application once before any input', async () => {
  let attempts = 0
  const caller = {
    async call() {
      attempts += 1
      if (attempts === 1) throw new Error('STALE_APP: select the application again')
      return { appHandle: 'app-fresh', pid: 42 }
    },
  } as unknown as NativeCaller
  await expect(getNativeApp(caller, '42', new AbortController().signal)).resolves.toMatchObject({ appHandle: 'app-fresh' })
  expect(attempts).toBe(2)
})

it('returns a structured foreground requirement without retrying input', async () => {
  let clicks = 0
  const window = { windowId: 2, title: 'Fixture', isOnScreen: true, bounds: { x: 0, y: 0, width: 500, height: 400 } }
  const caller = {
    async call(method: string) {
      if (method === 'getCapabilities') return { sessionLocked: false, permissions: { accessibility: true } }
      if (method === 'getApp') return { appHandle: 'app-1', pid: 42, bundleId: 'fixture.app' }
      if (method === 'listWindows') return [window]
      if (method === 'getState') return {
        pid: 42, snapshotId: 'snapshot-1', truncated: false, windows: [window],
        tree: '- [1] AXButton "Run" actions=["AXPress"] bounds=[10,20,100,40]',
      }
      if (method === 'screenshot') return {
        bounds: window.bounds, pixelWidth: 500, pixelHeight: 400, windowId: 2,
        coordinateSpace: 'window-points', data: '', mimeType: 'image/png',
      }
      if (method === 'click') {
        clicks += 1
        throw new Error('FOREGROUND_REQUIRED: explicit activation is required')
      }
      throw new Error(`Unexpected method ${method}`)
    },
  } as unknown as NativeCaller
  const decisionClient = {
    async decide() {
      return {
        decision: { operation: 'CLICK', target: '1' },
        usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, textExtractionCalls: 0,
      }
    },
  } as any
  const result = await runComputerSubgoal(caller, decisionClient, Config({ decisionToken: 'test-token' }), {
    goal: 'Run the controlled action', app: '42', windowId: 2,
    verify: [{ type: 'text_visible', text: 'Done' }],
  }, new AbortController().signal)
  expect(result).toMatchObject({ status: 'escalated', route: 'human', reason: 'foreground_required', actionsExecuted: 0 })
  expect(clicks).toBe(1)
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.DEBUG_CUA
})
