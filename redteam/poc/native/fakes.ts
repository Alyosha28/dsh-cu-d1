import type { Observation } from '@albaincompleta/dsh-cu-core/types'

/** One recorded native `cua` tool call, exactly as the controller dispatched it. */
export interface RecordedCall {
  method: string
  params: Record<string, unknown>
}

export interface FakeCaller {
  calls: RecordedCall[]
  call(method: string, params: Record<string, unknown>, _signal?: AbortSignal): Promise<any>
  methods(): string[]
  last(method: string): RecordedCall | undefined
}

/**
 * Minimal NativeCaller double. `respond` is keyed by method so a PoC can serve
 * one AX tree and record every dispatched action.
 */
export function fakeCaller(respond: Record<string, (params: Record<string, unknown>) => unknown>): FakeCaller {
  const calls: RecordedCall[] = []
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params })
      const handler = respond[method]
      if (handler === undefined) throw new Error(`fake caller has no handler for ${method}`)
      return handler(params)
    },
    methods() {
      return calls.map(call => call.method)
    },
    last(method) {
      return calls.filter(call => call.method === method).at(-1)
    },
  }
}

export interface TreeState {
  pid?: number
  snapshotId?: string
  windowId?: number
  title?: string
  bounds?: { x: number; y: number; width: number; height: number }
  tree: string
  truncated?: boolean
}

export function stateResponse(state: TreeState): unknown {
  const windowId = state.windowId ?? 2
  return {
    pid: state.pid ?? 4711,
    snapshotId: state.snapshotId ?? 'snap-1',
    focusedWindowId: windowId,
    truncated: state.truncated ?? false,
    tree: state.tree,
    windows: [{
      windowId,
      title: state.title ?? 'Fixture Window',
      isOnScreen: true,
      bounds: state.bounds ?? { x: 100, y: 100, width: 800, height: 600 },
    }],
  }
}

/** Observation builder for the `executeNative` coordinate PoCs. */
export function observation(overrides: Partial<Observation> & Pick<Observation, 'snapshot_id'>): Observation {
  return {
    version: 0,
    url: 'app://4711/2',
    title: 'Fixture Window',
    truncated: false,
    can_scroll_up: false,
    can_scroll_down: false,
    elements: [],
    ...overrides,
  }
}

export interface RecordedActivity {
  phase: string
  operation?: string
  point?: { x: number; y: number }
}

export function recordingIndicator(): { events: RecordedActivity[]; activity(event: RecordedActivity): Promise<void> } {
  const events: RecordedActivity[] = []
  return {
    events,
    async activity(event: RecordedActivity) {
      events.push(event)
    },
  }
}
