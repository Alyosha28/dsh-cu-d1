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
  type: z.enum(['ready', 'started', 'control', 'expired', 'menu', 'unavailable']),
  visible: z.boolean().optional(),
  runId: z.string().optional(),
  action: z.enum(['pause', 'resume', 'stop', 'takeover', 'dismiss']).optional(),
  reason: z.string().min(1).optional(),
}).strict()

export type NativeControlCallback = (action: ControlAction, reason?: 'takeover_detected') => void

/**
 * Why the indicator stopped being a truthful view of the run (NR-02). Any of
 * these means the cursor/state panel is no longer on screen, so the run must
 * lose input authority instead of continuing invisibly.
 */
export type IndicatorUnavailableReason =
  | 'window_gone'
  | 'window_offscreen'
  | 'panel_dismissed'
  | 'heartbeat_expired'
  | 'helper_exited'
  | 'helper_unavailable'

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
  /**
   * Set when the indicator is running without any visible cursor or panel, so
   * the caller can mark the result instead of reporting an unimpaired run
   * (NR-08). Absent means the indicator is fully live.
   */
  readonly degraded?: { reason: string }
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
  /** True only between `started` and the moment the helper lost the panel. */
  private observedVisible = false
  /** Reported at most once per run: the first reason wins. */
  private unavailableReason?: string
  readonly degraded: { reason: string } | undefined = undefined

  get pid(): number | undefined {
    return this.child?.pid
  }

  private constructor(
    private readonly helperPath: string,
    private readonly strings: PanelStrings,
    private readonly onControl: NativeControlCallback,
    private readonly onUnavailable: (reason: IndicatorUnavailableReason) => void,
  ) {}

  static async create(
    helperPath: string | undefined,
    onControl: NativeControlCallback,
    onUnavailable: (reason: IndicatorUnavailableReason) => void,
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

  /**
   * One stdout line from the helper. Malformed or unknown lines are dropped
   * instead of becoming an uncaught exception in the host process (NR-08): the
   * helper owns its own stdout, and a stray `print` must never kill a run.
   */
  private parseLine(raw: string): z.infer<typeof helperEvent> | undefined {
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      if (process.env.DEBUG_CUA === '1') console.error('CUA_INDICATOR_LINE_DROPPED', raw.slice(0, 120))
      return undefined
    }
    const parsed = helperEvent.safeParse(value)
    return parsed.success ? parsed.data : undefined
  }

  /**
   * The indicator stopped being a truthful view of this run: revoke the run's
   * input authority once, and make every later `activity()` fail closed.
   */
  private reportUnavailable(reason: IndicatorUnavailableReason | string): void {
    if (this.unavailableReason !== undefined) return
    this.unavailableReason = reason
    this.observedVisible = false
    this.runId = undefined
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    // A pending start/finish must observe the loss immediately instead of timing out.
    for (const waiter of [...this.waiters]) waiter.reject(new Error(`native_indicator_unavailable: ${reason}`))
    this.onUnavailable(reason as IndicatorUnavailableReason)
  }

  private handleEvent(raw: string): void {
    const event = this.parseLine(raw)
    if (event === undefined) return
    for (const waiter of [...this.waiters]) {
      if (waiter.type === event.type && waiter.runId === event.runId) waiter.resolve()
    }
    if (event.type === 'started' && event.runId === this.runId) {
      this.observedVisible = true
      return
    }
    if (event.type === 'unavailable') {
      // A reason for another run is stale; the helper must name this run or none.
      if (event.runId !== undefined && event.runId !== this.runId) return
      this.reportUnavailable(event.reason ?? 'helper_unavailable')
      return
    }
    if (event.type === 'control' && event.runId === this.runId && event.action !== undefined) {
      if (event.action === 'dismiss') {
        // A dismissed panel is no longer a visible run: stop, then keep the legacy
        // callback so old helpers still clear their own panel.
        this.reportUnavailable('panel_dismissed')
        this.onControl('dismiss')
        return
      }
      this.onControl(event.action, event.reason === 'takeover_detected' ? 'takeover_detected' : undefined)
      return
    }
    if (event.type === 'expired' && event.runId === this.runId) {
      this.reportUnavailable('heartbeat_expired')
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
      if (!this.closed && this.runId !== undefined) this.reportUnavailable('helper_exited')
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
    this.observedVisible = false
    this.unavailableReason = undefined
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
    // Fail closed: no live, visibly indicated run means no activity to report.
    if (this.unavailableReason !== undefined) throw new Error(`native_indicator_unavailable: ${this.unavailableReason}`)
    if (this.runId === undefined) throw new Error('native_indicator_not_running')
    if (!this.observedVisible) throw new Error('native_indicator_not_visible')
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
    this.observedVisible = false
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

/**
 * Keeps the run usable when the optional visual helper cannot be prepared, and
 * never pretends a cursor exists (NR-08). `degraded` is mandatory reading for
 * callers: a run that executed without it must be reported as indicated=false,
 * never as a fully visible run.
 */
export class NoopNativeIndicator implements NativeIndicator {
  readonly degraded: { reason: string }

  constructor(reason = 'native_indicator_unavailable') {
    this.degraded = { reason }
  }

  async start(): Promise<void> {}
  async activity(): Promise<void> {}
  async finish(): Promise<void> {}
  async dismiss(): Promise<void> {}
  async close(): Promise<void> {}
}
