import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AuditStore } from './audit.ts'


export type ControlStop = {
  status: 'paused' | 'stopped' | 'takeover'
  reason: string
}

export interface ExecutionHandle {
  id: string
  agent: Agent
  signal: AbortSignal
  /** Returns a terminal control stop; pauses are handled by waitWhilePaused. */
  admit: () => ControlStop | null
  /** Waits while the user has paused this run and wakes on resume, stop, takeover, or caller cancellation. */
  waitWhilePaused: (signal?: AbortSignal) => Promise<ControlStop | null>
  /** User-initiated pause time for the current run, excluded from the wall clock budget. */
  pausedMs: () => number
}

interface RunRecord {
  id: string
  kind: string
  status: 'running' | 'success' | 'blocked' | 'escalated' | 'confirmation_required' | 'paused' | 'stopped' | 'takeover'
  controller: AbortController
  startedAt: string
  finishedAt?: string
  route?: string
  reason?: string
  pausedMs: number
  pausedAt?: number
}

interface AgentState {
  paused: boolean
  stopped: boolean
  stopReason?: 'stopped_by_user' | 'indicator_unavailable'
  takeover: boolean
  takeoverReason?: 'human_takeover' | 'takeover_detected'
  active?: RunRecord
  last?: RunRecord
  pauseWaiters: Set<() => void>
}

interface PublicRunRecord {
  id: string
  kind: string
  status: RunRecord['status']
  startedAt: string
  finishedAt?: string
  route?: string
  reason?: string
}

interface PublicAgentState {
  paused: boolean
  stopped: boolean
  takeover: boolean
  active?: PublicRunRecord
  last?: PublicRunRecord
}

function publicRun(record: RunRecord | undefined): PublicRunRecord | undefined {
  if (record === undefined) return undefined
  const { controller: _controller, pausedMs: _pausedMs, pausedAt: _pausedAt, ...view } = record
  return Object.fromEntries(Object.entries(view).filter(([, value]) => value !== undefined) as Array<[string, unknown]>) as unknown as PublicRunRecord
}

export class RunController {
  private readonly states = new Map<string, AgentState>()
  private pending: Promise<void> = Promise.resolve()

  constructor(
    private readonly audit?: AuditStore,
    private readonly now: () => number = Date.now,
  ) {}

  private state(agent: Agent): AgentState {
    let state = this.states.get(agent.id)
    if (state === undefined) {
      state = { paused: false, stopped: false, takeover: false, pauseWaiters: new Set() }
      this.states.set(agent.id, state)
    }
    return state
  }

  private record(event: Parameters<AuditStore['append']>[0]): void {
    if (this.audit === undefined) return
    this.pending = this.pending.then(() => this.audit!.append(event).then(() => undefined))
  }

  private wake(state: AgentState): void {
    for (const resolve of [...state.pauseWaiters]) resolve()
    state.pauseWaiters.clear()
  }

  private pausedMs(record: RunRecord): number {
    return record.pausedMs + (record.pausedAt === undefined ? 0 : Math.max(0, this.now() - record.pausedAt))
  }

  start(agent: Agent, kind: string): ExecutionHandle {
    const state = this.state(agent)
    if (state.active?.status === 'running' || state.active?.status === 'paused') {
      throw new Error('another Computer Use run is already active for this Agent')
    }
    if (state.stopped) return this.inactive(agent, { status: 'stopped', reason: state.stopReason ?? 'stopped_by_user' })
    if (state.takeover) return this.inactive(agent, { status: 'takeover', reason: state.takeoverReason ?? 'human_takeover' })
    if (state.paused) return this.inactive(agent, { status: 'paused', reason: 'paused_by_user' })
    const controller = new AbortController()
    const run: RunRecord = {
      id: randomUUID(), kind, status: 'running', controller,
      startedAt: new Date().toISOString(), pausedMs: 0,
    }
    state.active = run
    this.record({ agentId: agent.id, runId: run.id, kind: 'run_started', detail: { kind } })
    return {
      id: run.id,
      agent,
      signal: controller.signal,
      admit: () => this.admit(agent),
      waitWhilePaused: signal => this.waitWhilePaused(agent, signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, signal])),
      pausedMs: () => this.pausedMs(run),
    }
  }

  private inactive(agent: Agent, stop: ControlStop): ExecutionHandle {
    return {
      id: '',
      agent,
      signal: AbortSignal.abort(stop.status),
      admit: () => stop,
      waitWhilePaused: async () => stop,
      pausedMs: () => 0,
    }
  }

  private async waitWhilePaused(agent: Agent, signal: AbortSignal): Promise<ControlStop | null> {
    const state = this.state(agent)
    while (state.paused) {
      const stop = this.admit(agent)
      if (stop !== null) return stop
      await new Promise<void>(resolve => {
        const done = (): void => {
          state.pauseWaiters.delete(done)
          signal.removeEventListener('abort', done)
          resolve()
        }
        state.pauseWaiters.add(done)
        signal.addEventListener('abort', done, { once: true })
        if (signal.aborted) done()
      })
    }
    return this.admit(agent)
  }

  admit(agent: Agent): ControlStop | null {
    const state = this.state(agent)
    if (state.stopped) return { status: 'stopped', reason: state.stopReason ?? 'stopped_by_user' }
    if (state.takeover) return { status: 'takeover', reason: state.takeoverReason ?? 'human_takeover' }
    return null
  }

  /** Suspends the active run without aborting it. The loop waits at the next checkpoint. */
  pause(agent: Agent): void {
    const state = this.state(agent)
    const active = state.active
    if (active === undefined || active.status !== 'running') return
    state.paused = true
    active.status = 'paused'
    active.pausedAt = this.now()
    this.record({ agentId: agent.id, runId: active.id, kind: 'run_paused' })
  }

  private finalize(agent: Agent, status: 'stopped' | 'takeover'): void {
    const state = this.state(agent)
    const active = state.active
    if (active !== undefined) {
      if (active.pausedAt !== undefined) {
        active.pausedMs = this.pausedMs(active)
        active.pausedAt = undefined
      }
      active.status = status
      active.finishedAt = new Date().toISOString()
      active.reason = status === 'takeover' ? state.takeoverReason ?? 'human_takeover'
        : state.stopReason ?? 'stopped_by_user'
      active.controller.abort(new Error(status))
      state.last = active
      state.active = undefined
    }
    state.paused = false
    this.wake(state)
    this.record({ agentId: agent.id, runId: active?.id, kind: `run_${status}` })
  }

  stop(agent: Agent, reason: 'stopped_by_user' | 'indicator_unavailable' = 'stopped_by_user'): void {
    this.state(agent).stopReason = reason
    this.state(agent).stopped = true
    this.finalize(agent, 'stopped')
  }

  takeover(agent: Agent, reason: 'human_takeover' | 'takeover_detected' = 'human_takeover'): void {
    this.state(agent).takeoverReason = reason
    this.state(agent).takeover = true
    this.finalize(agent, 'takeover')
  }

  resume(agent: Agent): void {
    const state = this.state(agent)
    const active = state.active
    if (active !== undefined && active.pausedAt !== undefined) {
      active.pausedMs = this.pausedMs(active)
      active.pausedAt = undefined
      active.status = 'running'
    }
    state.paused = false
    state.stopped = false
    state.stopReason = undefined
    state.takeover = false
    state.takeoverReason = undefined
    this.wake(state)
    this.record({ agentId: agent.id, kind: 'run_resumed' })
  }

  finish(agent: Agent, status: RunRecord['status'], reason: string, route?: string): void {
    const state = this.state(agent)
    const active = state.active
    if (active === undefined) return
    // Control APIs and audit records carry stable operational codes, never raw exception text.
    const operationalReason = /^[a-z][a-z0-9_:-]{0,99}$/u.test(reason) ? reason : 'tool_execution_failed'
    active.status = status
    active.finishedAt = new Date().toISOString()
    active.reason = operationalReason
    active.route = route
    state.last = active
    state.active = undefined
    state.paused = false
    this.wake(state)
    this.record({ agentId: agent.id, runId: active.id, kind: 'run_finished', detail: { status, reason: operationalReason, ...route === undefined ? {} : { route } } })
  }

  status(agent: Agent): PublicAgentState {
    const state = this.state(agent)
    return {
      paused: state.paused,
      stopped: state.stopped,
      takeover: state.takeover,
      ...state.active === undefined ? {} : { active: publicRun(state.active) },
      ...state.last === undefined ? {} : { last: publicRun(state.last) },
    }
  }

  async auditEvents(limit = 50) {
    await this.pending
    return this.audit?.list(limit) ?? []
  }
}
