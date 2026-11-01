export interface ObservedElement {
  id: string
  role: string
  /** DOM-derived: `null` at runtime for elements without an accessible name. */
  name: string | null
  value: string | null
  actions: string[]
  enabled: boolean
  focused: boolean
  /** `null` for non-input elements: the snapshot never omits this field. */
  inputType?: string | null
  context?: string | null
  bounds?: [number, number, number, number]
  identifier?: string | null
  selected?: boolean | string | number | null
  declaredActions?: string[]
}

export interface Observation {
  snapshot_id: string
  version: number
  url: string
  title: string
  elements: ObservedElement[]
  truncated: boolean
  can_scroll_up: boolean
  can_scroll_down: boolean
  windowBounds?: { x: number; y: number; width: number; height: number }
  screenshot?: {
    bounds: { x: number; y: number; width: number; height: number }
    pixelWidth: number
    pixelHeight: number
    windowId: number
    coordinateSpace?: string
  }
}

export type { Decision } from './decision.ts'
