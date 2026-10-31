import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import type { ActivityEvent, ActivitySink, ControlAction } from '@albaincompleta/dsh-cu-core/activity'
import type { RunStatus } from '@albaincompleta/dsh-cu-core/contract'
import { compileSwiftHelper } from '@albaincompleta/dsh-cu-core/helper-cache'
import { uiStrings, type PanelStrings } from '@albaincompleta/dsh-cu-core/locale'

const helperEvent = z.object({
  type: z.enum(['ready', 'started', 'control', 'expired', 'menu']),
  visible: z.boolean().optional(),
  runId: z.string().optional(),
  action: z.enum(['pause', 'resume', 'stop', 'takeover', 'dismiss']).optional(),
  reason: z.literal('takeover_detected').optional(),
}).strict()

export type NativeControlCallback = (action: ControlAction, reason?: 'takeover_detected') => void

export interface NativeIndicatorTarget {
  pid: number
  windowId: number
  title: string
  appName?: string
  bounds?: { x: number; y: number; width: number; height: number }
}

export interface NativeRunOutcome {
  status: RunStatus | 'failed'
  reason: string
  route?: 'skill' | 'd1' | 'human'
}

export interface NativeIndicator extends ActivitySink {
  start(runId: string, target: NativeIndicatorTarget): Promise<void>
  finish(outcome?: NativeRunOutcome): Promise<void>
  dismiss(): Promise<void>
  close(): Promise<void>
}

export const DEFAULT_PANEL_STRINGS: PanelStrings = uiStrings('zh')

interface Waiter {
  type: string
  runId?: string
  resolve: () => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

async function processExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode
  return new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code))
  })
}

export class NativeControlIndicator implements NativeIndicator {
  private child?: ChildProcess
  private runId?: string
  private heartbeat?: NodeJS.Timeout
  private readonly waiters = new Set<Waiter>()
  private closed = false

  get pid(): number | undefined {
    return this.child?.pid
  }

  private constructor(
    private readonly helperPath: string,
    private readonly strings: PanelStrings,
    private readonly onControl: NativeControlCallback,
    private readonly onUnavailable: () => void,
  ) {}

  static async create(
    helperPath: string | undefined,
    onControl: NativeControlCallback,
    onUnavailable: () => void,
    strings: PanelStrings = DEFAULT_PANEL_STRINGS,
  ): Promise<NativeControlIndicator> {
    if (helperPath !== undefined) return new NativeControlIndicator(helperPath, strings, onControl, onUnavailable)
    const sources = [
      fileURLToPath(new URL('../native/ControlIndicator.swift', import.meta.url)),
      fileURLToPath(new URL('../native/CursorView.swift', import.meta.url)),
    ]
    try {
      const binary = await compileSwiftHelper(sources, 'ControlIndicator')
      return new NativeControlIndicator(binary, strings, onControl, onUnavailable)
    } catch (error) {
      throw new Error('native_indicator_compilation_failed', { cause: error })
    }
  }

  private waitFor(type: string, runId: string | undefined, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        type,
        runId,
        resolve: () => {
          clearTimeout(waiter.timer)
          this.waiters.delete(waiter)
          resolve()
        },
        reject: error => {
          clearTimeout(waiter.timer)
          this.waiters.delete(waiter)
          reject(error)
        },
        timer: setTimeout(() => {
          this.waiters.delete(waiter)
          reject(new Error(`native_indicator_${type}_timeout`))
        }, timeoutMs),
      }
      waiter.timer.unref()
      this.waiters.add(waiter)
    })
  }

  private handleEvent(raw: string): void {
    const parsed = helperEvent.safeParse(JSON.parse(raw))
    if (!parsed.success) return
    const event = parsed.data
    for (const waiter of [...this.waiters]) {
      if (waiter.type === event.type && waiter.runId === event.runId) waiter.resolve()
    }
    if (event.type === 'control' && event.runId === this.runId && event.action !== undefined) {
      if (event.action === 'dismiss') {
        this.runId = undefined
        this.onControl('dismiss')
        return
      }
      this.onControl(event.action, event.reason)
    }
    if (event.type === 'expired' && event.runId === this.runId) {
      this.runId = undefined
      this.onUnavailable()
    }
  }

  private async ensureProcess(): Promise<void> {
    if (this.child !== undefined) return
    if (this.closed) throw new Error('native_indicator_closed')
    const ready = this.waitFor('ready', undefined, 10000)
    const child = spawn(this.helperPath, [], { stdio: ['pipe', 'pipe', 'ignore'] })
    this.child = child
    const lines = createInterface({ input: child.stdout! })
    lines.on('line', line => this.handleEvent(line))
    child.once('error', () => {
      for (const waiter of [...this.waiters]) waiter.reject(new Error('native_indicator_unavailable'))
    })
    child.once('exit', () => {
      if (this.child === child) this.child = undefined
      lines.close()
      for (const waiter of [...this.waiters]) waiter.reject(new Error('native_indicator_unavailable'))
      if (!this.closed && this.runId !== undefined) {
        this.runId = undefined
        this.onUnavailable()
      }
    })
    await ready
  }

  private send(command: Record<string, unknown>): void {
    const stdin = this.child?.stdin
    if (stdin?.writable !== true) throw new Error('native_indicator_unavailable')
    stdin.write(`${JSON.stringify(command)}\n`)
  }

  async start(runId: string, target: NativeIndicatorTarget): Promise<void> {
    z.string().uuid().parse(runId)
    await this.finish()
    await this.ensureProcess()
    const started = this.waitFor('started', runId, 5000)
    this.runId = runId
    try {
      this.send({ type: 'start', runId, labels: this.strings, ...target })
      this.heartbeat = setInterval(() => {
        if (this.runId === runId && this.child?.stdin?.writable === true) {
          this.send({ type: 'heartbeat', runId })
        }
      }, 1000)
      this.heartbeat.unref()
      await started
    } catch (error) {
      await this.finish()
      throw error
    }
  }

  async activity(event: ActivityEvent): Promise<void> {
    if (this.runId === undefined) throw new Error('native_indicator_not_running')
    this.send({
      type: 'activity',
      runId: this.runId,
      phase: event.phase,
      operation: event.operation,
      point: event.point,
      step: event.step,
      maxSteps: event.maxSteps,
      route: event.route,
    })
  }

  async finish(outcome?: NativeRunOutcome): Promise<void> {
    const runId = this.runId
    this.runId = undefined
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    if (runId === undefined || this.child?.stdin?.writable !== true) return
    this.send({
      type: 'finish', runId,
      ...outcome === undefined ? {} : {
        persistent: true, status: outcome.status, reason: outcome.reason, route: outcome.route,
      },
    })
  }

  async dismiss(): Promise<void> {
    if (this.child?.stdin?.writable === true) this.send({ type: 'dismiss' })
  }

  async close(): Promise<void> {
    if (this.closed) return
    await this.finish()
    this.closed = true
    const child = this.child
    if (child !== undefined) {
      const stdin = child.stdin
      if (stdin?.writable === true) {
        stdin.write(`${JSON.stringify({ type: 'stop' })}\n`)
        stdin.end()
      }
      const exited = await Promise.race([
        processExit(child).then(() => true),
        new Promise<false>(resolve => setTimeout(() => resolve(false), 2000).unref()),
      ])
      if (!exited && child.exitCode === null) {
        child.kill('SIGTERM')
        await processExit(child).catch(() => null)
      }
      this.child = undefined
    }
  }
}

/** Keeps the run usable when the optional visual helper cannot be prepared. */
export class NoopNativeIndicator implements NativeIndicator {
  async start(): Promise<void> {}
  async activity(): Promise<void> {}
  async finish(): Promise<void> {}
  async dismiss(): Promise<void> {}
  async close(): Promise<void> {}
}
