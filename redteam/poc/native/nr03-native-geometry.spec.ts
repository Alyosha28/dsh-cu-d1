/**
 * NR-03 — the indicator and the native dispatch disagree about where the click is.
 *
 * §5.4: "软件光标由动作适配器根据实际即将执行的坐标和动作驱动". The controller builds
 * the software-cursor point from screenshot *pixels* while the provider converts the
 * click from pixels to window *points* (dsh-cua CuaCoordinates.parameters). On a 2x
 * display the cursor is drawn at twice the real offset.
 *
 * The second case shows the observation carrying the window rectangle captured by the
 * first listWindows call, so every AX-element click is computed against a stale origin.
 */
import { describe, expect, it } from 'vitest'
import { executeNative } from '../../../packages/dsh-computer-use-d1/src/controller.ts'
import { fakeCaller, observation, recordingIndicator } from './fakes.ts'

const params = { appHandle: 'app-1', windowId: 2, details: true }
const signal = new AbortController().signal

describe('NR-03 native coordinate integrity', () => {
  it('draws the software cursor in screenshot pixels instead of window points', async () => {
    // 800x600 pt window captured as a 1600x1200 px image (2x display).
    const caller = fakeCaller({ click: () => ({ ok: true }), paste: () => ({ ok: true }) })
    const indicator = recordingIndicator()
    const obs = observation({
      snapshot_id: 'snap-1',
      windowBounds: { x: 100, y: 100, width: 800, height: 600 },
      screenshot: {
        bounds: { x: 100, y: 100, width: 800, height: 600 },
        pixelWidth: 1600, pixelHeight: 1200, windowId: 2, coordinateSpace: 'screenshot-pixels',
      },
    })
    await executeNative(caller, params, obs, {
      operation: 'CLICK', target: null, box: { left: 0.25, top: 0.25, right: 0.75, bottom: 0.75 },
    }, signal, indicator)

    const click = caller.last('click')!
    const acting = indicator.events.find(event => event.phase === 'acting')!
    // What the controller dispatched: absolute screenshot pixels.
    expect(click.params.x).toBe(800)
    expect(click.params.y).toBe(600)
    // What the provider turns that into: window points (800*800/1600, 600*600/1200).
    const trueScreen = { x: 100 + 800 * 800 / 1600, y: 100 + 600 * 600 / 1200 }
    // What the software cursor shows: window origin plus the raw pixel offsets.
    const cursorScreen = { x: acting.point!.x, y: acting.point!.y }
    expect(trueScreen).toEqual({ x: 500, y: 400 })
    expect(cursorScreen).toEqual({ x: 900, y: 700 })
    expect(cursorScreen).not.toEqual(trueScreen)
  })

  it('clicks from a stale window rectangle when the window moved mid-run', async () => {
    const caller = fakeCaller({ click: () => ({ ok: true }), paste: () => ({ ok: true }) })
    // AX bounds are absolute and fresh: the window now sits at x=500. The observation
    // still carries the rectangle from the first listWindows call (x=100).
    const obs = observation({
      snapshot_id: 'snap-2',
      windowBounds: { x: 100, y: 100, width: 800, height: 600 },
      elements: [{
        id: '7', role: 'AXTextField', name: 'Report path', value: '', actions: ['type', 'paste'],
        enabled: true, focused: false, context: 'Fixture Window',
        bounds: [500, 300, 100, 20], declaredActions: [],
      }],
    })
    await executeNative(caller, params, obs, {
      operation: 'PASTE_TEXT', target: '7', text: '/tmp/report.csv',
    }, signal)

    const click = caller.last('click')!
    // 450 = (500 + 100/2) - staleOrigin(100); 210 = (300 + 20/2) - staleOrigin(100).
    expect(click.params).toMatchObject({ x: 562, y: 350, relative: true })
    // Provider converts 562/1000 * 800 = 449.6 pt from the *current* window origin.
    const deliveredScreenX = 500 + 562 / 1000 * 800
    const elementCenterX = 500 + 100 / 2
    expect(deliveredScreenX).toBeCloseTo(949.6, 1)
    expect(deliveredScreenX - elementCenterX).toBeCloseTo(399.6, 1)
    // No WINDOW_CHANGED is raised: the dispatch already happened.
    expect(caller.methods()).toContain('paste')
  })

  it('mixes three coordinate conventions in one action table', async () => {
    const caller = fakeCaller({ click: () => ({ ok: true }), scroll: () => ({ ok: true }) })
    const obs = observation({
      snapshot_id: 'snap-3',
      windowBounds: { x: 100, y: 100, width: 800, height: 600 },
      elements: [{
        id: '9', role: 'AXScrollArea', name: 'List', value: null, actions: [],
        enabled: true, focused: false, context: 'Fixture Window',
        bounds: [140, 180, 400, 300], declaredActions: [],
      }],
    })
    await executeNative(caller, params, obs, { operation: 'SCROLL_DOWN', target: '9' }, signal)
    const scroll = caller.last('scroll')!
    // Absolute screen coordinates, while PASTE_TEXT above used 0-999 window permille
    // and CLICK used absolute screenshot pixels.
    expect(scroll.params).toMatchObject({ x: 340, y: 330, windowId: 2 })
    expect(scroll.params).not.toHaveProperty('relative')
  })
})
