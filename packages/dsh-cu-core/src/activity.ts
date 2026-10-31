export type ControlAction = 'pause' | 'resume' | 'stop' | 'takeover' | 'dismiss'

export type ActivityPhase =
  | 'running'
  | 'observing'
  | 'deciding'
  | 'awaiting_approval'
  | 'skill'
  | 'acting'
  | 'waiting'
  | 'verifying'
  | 'paused'
  | 'stopped'
  | 'takeover'
  | 'blocked'
  | 'completed'
  | 'failed'

export interface ActivityPoint {
  x: number
  y: number
}

export interface ActivityEvent {
  phase: ActivityPhase
  operation?: string
  point?: ActivityPoint
  step?: number
  maxSteps?: number
  route?: 'skill' | 'd1' | 'human'
  detail?: string
}

export interface ActivitySink {
  activity(event: ActivityEvent): Promise<void>
}
