export interface ObservedElement {
  id: string
  role: string
  name: string
  value: string | null
  actions: string[]
  enabled: boolean
  focused: boolean
  inputType?: string
  context?: string
  bounds?: [number, number, number, number]
  identifier?: string
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
