import { expect, it } from 'vitest'
import type { Verification } from '@albaincompleta/dsh-cu-core/contract'
import {
  createVerificationRegistry, EMPTY_VERIFICATION_REGISTRY, evaluateNativeVerification, parseAxNodes, visibleTextOf,
} from '../src/verification.ts'

const WINDOW = { windowId: 2, title: 'Window', bounds: { x: 100, y: 200, width: 1000, height: 800 } }

async function verify(tree: string, assertions: Verification[], overrides: Partial<Parameters<typeof evaluateNativeVerification>[0]> = {}) {
  return evaluateNativeVerification({
    tree, pid: 77, windowId: 2, window: WINDOW, assertions,
    signal: new AbortController().signal, ...overrides,
  })
}

const TEXT = (text: string): Verification => ({ type: 'text_visible', text })

it('never satisfies text_visible from a container description', async () => {
  const tree = `
- [0] AXWindow "Window" bounds=[100.0,200.0,1000.0,800.0]
  - [1] AXScrollArea description="Transfer complete" bounds=[150.0,260.0,400.0,100.0]
  - AXStaticText = "Transfer failed"`
  const nodes = parseAxNodes(tree)
  expect(visibleTextOf(nodes.find(node => node.role === 'AXScrollArea')!)).toEqual([])
  const result = await verify(tree, [TEXT('Transfer complete')])
  expect(result.ok).toBe(false)
  expect(result.evidence.assertions[0]).toMatchObject({ type: 'text_visible', ok: false, reason: 'text_not_visible' })
})

it('keeps a custom-drawn button title that AppKit reports as its description', async () => {
  // Real AX dumps put Calculator-style button titles in AXDescription.
  const tree = `
- [0] AXWindow "Window" bounds=[100.0,200.0,1000.0,800.0]
  - [1] AXButton description="Import report" actions=["AXPress"] bounds=[150.0,260.0,180.0,40.0]`
  expect((await verify(tree, [TEXT('Import report')])).ok).toBe(true)
})

it('ignores text that is hidden, offscreen, zero-sized or outside the window', async () => {
  const tree = `
- [0] AXWindow "Window" bounds=[100.0,200.0,1000.0,800.0]
  - AXStaticText hidden = "Hidden secret"
  - AXStaticText offscreen = "Offscreen secret"
  - [3] AXStaticText = "Zero secret" bounds=[150.0,260.0,0.0,0.0]
  - [4] AXStaticText = "Far secret" bounds=[4000.0,4000.0,100.0,20.0]`
  for (const text of ['Hidden secret', 'Offscreen secret', 'Zero secret', 'Far secret']) {
    const result = await verify(tree, [TEXT(text)])
    expect(result.ok, text).toBe(false)
  }
})

it('accepts text from a leaf that inherits its frame from a framed ancestor', async () => {
  // AppKit omits bounds on text leaves inside a scroll area (real dumps do this).
  const tree = `
- [0] AXWindow "Window" bounds=[100.0,200.0,1000.0,800.0]
  - [1] AXScrollArea bounds=[150.0,260.0,400.0,100.0]
    - AXStaticText = "Rows: 2 · Total: 300"`
  const result = await verify(tree, [TEXT('Rows: 2 · Total: 300')])
  expect(result.ok).toBe(true)
  expect(result.evidence.assertions[0]!.element).toMatchObject({ visible: true, geometry: 'inherited' })
})

it('treats url_contains as a window address, not a substring of anything', async () => {
  const tree = '- [0] AXWindow "Window" bounds=[100.0,200.0,1000.0,800.0]'
  expect((await verify(tree, [{ type: 'url_contains', value: 'app://77/2' }])).ok).toBe(true)
  for (const value of ['app', 'app://', '77', 'app://77/3', 'app://77']) {
    expect((await verify(tree, [{ type: 'url_contains', value }])).ok, value).toBe(false)
  }
})

it('never satisfies input_value from an invisible or mismatched element', async () => {
  const tree = `
- [0] AXWindow "Window" bounds=[100.0,200.0,1000.0,800.0]
  - [1] AXTextField hidden id="amount" = "10.00" bounds=[150.0,260.0,400.0,36.0]
  - [2] AXTextField id="amount" = "" bounds=[150.0,320.0,400.0,36.0]`
  // The hidden copy must not answer for the visible field: the visible one is
  // read (and mismatches), and the hidden one is never used as evidence.
  const invisible = await verify(tree, [{ type: 'input_value', label: 'amount', value: '10.00' }])
  expect(invisible.ok).toBe(false)
  expect(invisible.evidence.assertions[0]).toMatchObject({
    reason: 'value_mismatch', element: { index: '2', visible: true },
  })

  const hiddenOnly = await verify('- [0] AXWindow "Window" bounds=[100.0,200.0,1000.0,800.0]\n  - [1] AXTextField hidden id="secret" = "x"', [
    { type: 'input_value', label: 'secret', value: 'x' },
  ])
  expect(hiddenOnly.ok).toBe(false)
  expect(hiddenOnly.evidence.assertions[0]!.reason).toBe('element_not_visible')

  const visible = await verify(tree, [{ type: 'input_value', label: 'amount', value: '' }])
  expect(visible.ok).toBe(true)
  expect(visible.evidence.assertions[0]!.element).toMatchObject({ index: '2', visible: true })

  const missing = await verify(tree, [{ type: 'input_value', label: 'other', value: 'x' }])
  expect(missing.evidence.assertions[0]!.reason).toBe('element_not_found')
})

it('reads checkbox state from the visible element', async () => {
  const tree = `
- [0] AXWindow "Window" bounds=[100.0,200.0,1000.0,800.0]
  - [1] AXCheckBox id="nonstop" = "1" bounds=[150.0,260.0,20.0,20.0]`
  expect((await verify(tree, [{ type: 'checkbox', label: 'nonstop', checked: true }])).ok).toBe(true)
  expect((await verify(tree, [{ type: 'checkbox', label: 'nonstop', checked: false }])).ok).toBe(false)
})

it('fails closed for an assertion type it cannot evaluate and for a missing window', async () => {
  const tree = '- [0] AXWindow "Window" bounds=[100.0,200.0,1000.0,800.0]'
  const unsupported = await verify(tree, [{ type: 'workflow_state', name: 'x' } as unknown as Verification])
  expect(unsupported.ok).toBe(false)
  expect(unsupported.evidence.assertions[0]!.reason).toBe('unsupported_assertion')

  const noWindow = await verify(tree, [TEXT('anything')], { windowId: null, window: undefined })
  expect(noWindow.ok).toBe(false)
  expect(noWindow.reason).toBe('window_evidence_missing')

  const offScreen = await verify(tree, [TEXT('anything')], { window: { ...WINDOW, isOnScreen: false } })
  expect(offScreen.reason).toBe('window_not_on_screen')
})

it('runs a custom assertion only through a registry entry built at construction', async () => {
  const tree = '- [0] AXWindow "Window" bounds=[100.0,200.0,1000.0,800.0]'
  const unregistered = await verify(tree, [{ type: 'custom', name: 'workflow_state' }])
  expect(unregistered.ok).toBe(false)
  expect(unregistered.evidence.assertions[0]).toMatchObject({ ok: false, reason: 'custom_handler_unavailable' })

  const seen: Array<{ body: unknown; window: unknown }> = []
  const registry = createVerificationRegistry({
    workflow_state: async (args, context) => {
      seen.push({ body: args, window: context.window })
      return args.statePath === '/tmp/state.json'
    },
  })
  const passed = await verify(tree, [
    { type: 'custom', name: 'workflow_state', args: { statePath: '/tmp/state.json' } },
  ], {
    registry,
    customArgs: { workflow_state: { statePath: '/tmp/state.json' } },
  })
  expect(passed.ok).toBe(true)
  expect(seen).toHaveLength(1)
  expect(seen[0]!.body).toEqual({ statePath: '/tmp/state.json' })
  expect(seen[0]!.window).toMatchObject({ windowId: 2, pid: 77, title: 'Window' })

  const throwing = createVerificationRegistry({ workflow_state: async () => { throw new Error('boom') } })
  const failed = await verify(tree, [{ type: 'custom', name: 'workflow_state' }], { registry: throwing })
  expect(failed.ok).toBe(false)
  expect(failed.evidence.assertions[0]!.reason).toBe('custom_handler_failed')
})

it('exposes no way to mutate a registry after construction', () => {
  const registry = createVerificationRegistry({ a: async () => true })
  expect(Object.isFrozen(registry)).toBe(true)
  expect(Object.isFrozen(registry.names)).toBe(true)
  expect(registry.names).toEqual(['a'])
  expect(() => createVerificationRegistry({ a: async () => true, a2: async () => true } as never)).not.toThrow()
  expect(() => createVerificationRegistry([['a', async () => true], ['a', async () => true]])).toThrow(/duplicate/u)
  expect(() => createVerificationRegistry({ 'Bad Name': async () => true })).toThrow(/invalid/u)
  expect(EMPTY_VERIFICATION_REGISTRY.names).toEqual([])
  expect('registerNativeVerification' in registry).toBe(false)
})
