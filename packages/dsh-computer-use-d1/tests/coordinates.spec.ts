import { expect, it } from 'vitest'
import type { Observation } from '@albaincompleta/dsh-cu-core/types'
import {
  basisPoint, boxCenterPoint, executeNative, frameCenter, resolveDispatchPoint, sameWindowFrame, windowRelativePoint,
} from '../src/controller.ts'
import type { NativeCaller } from '../src/controller.ts'

const FRAME = { x: 100, y: 200, width: 1000, height: 800 }

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    snapshot_id: 'snapshot-1', version: 0, url: 'app://1/2', title: 'Window',
    truncated: false, can_scroll_up: false, can_scroll_down: false,
    windowBounds: { ...FRAME },
    elements: [{
      id: '4', role: 'AXTextField', name: 'Amount', value: '', actions: ['click', 'paste'],
      enabled: true, focused: false, bounds: [150, 260, 400, 100],
    }],
    ...overrides,
  }
}

const BOX = { left: 0.1, top: 0.35, right: 0.4, bottom: 0.55 }

it('maps a screenshot box through the window frame, never through pixel dimensions', () => {
  const base = boxCenterPoint(BOX, FRAME)!
  // 2x Retina: the same window, the same box, twice the pixels.
  const retina = boxCenterPoint(BOX, { ...FRAME })
  expect(retina).toEqual(base)
  expect(base).toEqual({ x: 100 + 0.25 * 1000, y: 200 + 0.45 * 800 })

  const point = resolveDispatchPoint(
    observation({
      screenshot: {
        bounds: { ...FRAME }, pixelWidth: 2000, pixelHeight: 1600,
        windowId: 2, coordinateSpace: 'screenshot-pixels',
      },
    }),
    { operation: 'CLICK', target: null, box: BOX },
    FRAME,
  )
  // A pixel-scaled implementation would land at 2x this offset.
  expect(point.relative).toEqual({ x: 250, y: 360 })
})

it('keeps the window-relative point stable when the window moves by a fractional amount', () => {
  const moved = { ...FRAME, x: 100 + 399.6 }
  const before = resolveDispatchPoint(observation(), { operation: 'CLICK', target: null, box: BOX }, FRAME)
  const after = resolveDispatchPoint(observation(), { operation: 'CLICK', target: null, box: BOX }, moved)
  expect(after.relative!.x).toBeCloseTo(before.relative!.x, 5)
  expect(after.relative!.y).toBeCloseTo(before.relative!.y, 5)
  // The on-screen point follows the window; the wire point does not.
  expect(after.ax!.x - before.ax!.x).toBeCloseTo(399.6, 5)
  expect(sameWindowFrame(FRAME, moved)).toBe(false)
})

it('treats sub-point jitter as the same frame but a resized window as a different one', () => {
  expect(sameWindowFrame({ ...FRAME }, { ...FRAME, x: FRAME.x + 0.4 })).toBe(true)
  expect(sameWindowFrame({ ...FRAME }, { ...FRAME, x: FRAME.x + 1.4 })).toBe(false)
  expect(sameWindowFrame({ ...FRAME }, { ...FRAME, width: FRAME.width + 40 })).toBe(false)
  expect(sameWindowFrame(undefined, FRAME)).toBe(false)
})

it('converts AX points to window-relative points and the 0..999 basis', () => {
  expect(windowRelativePoint({ x: 350, y: 310 }, FRAME)).toEqual({ x: 250, y: 110 })
  expect(windowRelativePoint({ x: 99, y: 310 }, FRAME)).toBeUndefined()
  expect(windowRelativePoint({ x: 350, y: 1001 }, FRAME)).toBeUndefined()
  expect(basisPoint({ x: 350, y: 310 }, FRAME)).toEqual({ x: 250, y: 137 })
  expect(frameCenter([150, 260, 400, 100])).toEqual({ x: 350, y: 310 })
  expect(frameCenter([150, 260, 0, 100])).toBeUndefined()
})

it('refuses a coordinate click when the window moved after the screenshot', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const caller = {
    async call(method: string, params: Record<string, unknown>) {
      calls.push({ method, params })
      return { dispatched: true }
    },
  } as unknown as NativeCaller
  await expect(executeNative(
    caller, { appHandle: 'app-1', windowId: 2 },
    observation({
      screenshot: {
        bounds: { ...FRAME }, pixelWidth: 1000, pixelHeight: 800, windowId: 2, coordinateSpace: 'window-points',
      },
    }),
    { operation: 'CLICK', target: null, box: BOX },
    new AbortController().signal, undefined, { ...FRAME, x: FRAME.x + 399.6 },
  )).rejects.toThrow(/WINDOW_GEOMETRY_UNAVAILABLE/u)
  expect(calls).toEqual([])
})

it('falls back to the AX index instead of stale element coordinates', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const caller = {
    async call(method: string, params: Record<string, unknown>) {
      calls.push({ method, params })
      return { dispatched: true }
    },
  } as unknown as NativeCaller
  await executeNative(
    caller, { appHandle: 'app-1', windowId: 2 }, observation(),
    { operation: 'PASTE_TEXT', target: '4', text: 'body' },
    new AbortController().signal, undefined, { ...FRAME, x: FRAME.x + 399.6 },
  )
  expect(calls.map(call => call.method)).toEqual(['click', 'paste'])
  expect(calls[0]!.params).toMatchObject({ elementIndex: 4 })
  expect(calls[0]!.params).not.toHaveProperty('x')
})

it('uses the current frame for an unchanged window', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const caller = {
    async call(method: string, params: Record<string, unknown>) {
      calls.push({ method, params })
      return { dispatched: true }
    },
  } as unknown as NativeCaller
  await executeNative(
    caller, { appHandle: 'app-1', windowId: 2 }, observation(),
    { operation: 'PASTE_TEXT', target: '4', text: 'body' },
    new AbortController().signal, undefined, { ...FRAME },
  )
  expect(calls[0]).toEqual({
    method: 'click',
    params: { appHandle: 'app-1', snapshotId: 'snapshot-1', windowId: 2, x: 250, y: 137, relative: true },
  })
  expect(calls[1]!.method).toBe('paste')
})
