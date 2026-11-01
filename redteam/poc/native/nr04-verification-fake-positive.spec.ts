/**
 * NR-04 — the native verifier accepts evidence that is not evidence.
 *
 * ARCHITECTURE_PLAN.md §6.3 requires "未知断言、无法求值和证据不足均失败关闭" and a
 * regression suite that ignores "元素编号、内部标识和不可见元数据". The cases below
 * show verification succeeding with zero-size elements, description-only text,
 * duplicate labels and a `selected` marker the parser never reads.
 */
import { describe, expect, it } from 'vitest'
import { parseAxElements, verifyNative, visibleAxText } from '../../../packages/dsh-computer-use-d1/src/controller.ts'
import { fakeCaller, stateResponse } from './fakes.ts'

const params = { appHandle: 'app-1', windowId: 2, details: true }
const signal = new AbortController().signal
const window = { windowId: 2, title: 'Fixture Window' }

function tree(body: string[]): string {
  return body.join('\n')
}

describe('NR-04 native verification fake positives', () => {
  it('accepts input_value from a zero-size, offscreen duplicate field', async () => {
    // The visible field still holds the wrong value; a 0x0 duplicate wins.
    const treeText = tree([
      '- [1] AXWindow "Fixture Window"',
      '  - [2] AXTextField placeholder="Report path" = "/tmp/wrong.csv" bounds=[40,80,300,24]',
      '  - [3] AXTextField placeholder="Report path" = "/tmp/report.csv" bounds=[0,0,0,0]',
    ])
    const caller = fakeCaller({ getState: () => stateResponse({ tree: treeText }) })
    const elements = parseAxElements(treeText, window)
    expect(elements.find(element => element.id === '3')!.bounds).toEqual([0, 0, 0, 0])
    const verified = await verifyNative(caller, params, [
      { type: 'input_value', label: 'Report path', value: '/tmp/report.csv' },
    ], signal)
    expect(verified).toBe(true)
  })

  it('accepts text_visible from an invisible element description', async () => {
    const treeText = tree([
      '- [1] AXWindow "Fixture Window"',
      '  - [5] AXStaticText description="Import complete" bounds=[0,0,0,0]',
    ])
    const caller = fakeCaller({ getState: () => stateResponse({ tree: treeText }) })
    // The words are never rendered: they live in the description of a 0x0 node.
    expect(visibleAxText(treeText)).toContain('Import complete')
    const verified = await verifyNative(caller, params, [
      { type: 'text_visible', text: 'Import complete' },
    ], signal)
    expect(verified).toBe(true)
  })

  it('accepts checkbox checked=false for any element with a matching label and no value', async () => {
    const treeText = tree([
      '- [1] AXWindow "Fixture Window"',
      '  - [6] AXStaticText "Remember me" bounds=[40,80,120,20]',
      '  - [7] AXButton "Save" actions=["AXPress"] bounds=[40,120,80,24]',
    ])
    const caller = fakeCaller({ getState: () => stateResponse({ tree: treeText }) })
    // No checkbox exists at all, yet "unchecked" is satisfied by a static label.
    const verified = await verifyNative(caller, params, [
      { type: 'checkbox', label: 'Remember me', checked: false },
    ], signal)
    expect(verified).toBe(true)
  })

  it('ignores the tree selected marker, so checkbox checked=true cannot pass', async () => {
    const treeText = tree([
      '- [1] AXWindow "Fixture Window"',
      '  - [8] AXMenuItem "Dark mode" selected bounds=[40,80,200,20]',
    ])
    const elements = parseAxElements(treeText, window)
    // The parser never reads the bare `selected` token the formatter emits.
    expect(elements[0].selected).toBeUndefined()
    expect(elements[0].focused).toBe(false)
    const caller = fakeCaller({ getState: () => stateResponse({ tree: treeText }) })
    const verified = await verifyNative(caller, params, [
      { type: 'checkbox', label: 'Dark mode', checked: true },
    ], signal)
    expect(verified).toBe(false)
  })

  it('accepts a vacuous url_contains assertion without reading application state', async () => {
    const caller = fakeCaller({ getState: () => stateResponse({ tree: '- [1] AXWindow "Fixture Window"' }) })
    const verified = await verifyNative(caller, params, [
      { type: 'url_contains', value: 'app://' },
    ], signal)
    expect(verified).toBe(true)
    // The 'URL' is synthesised from the pid and windowId, never from the target.
    expect(caller.methods()).toEqual(['getState'])
  })
})
