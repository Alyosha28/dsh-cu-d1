import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import type { Page } from 'playwright'
import { z } from 'zod'
import type { ActivityEvent, ControlAction } from '@alyosha28/dsh-cu-core/activity'
import { compileSwiftHelper } from '@alyosha28/dsh-cu-core/helper-cache'
import { BrowserControlIndicator, DEFAULT_PANEL_STRINGS, type BrowserRunIndicator, type PanelStrings, type RunOutcome } from './indicator.ts'

const helperEvent = z.object({
  type: z.enum(['ready', 'started', 'frame', 'control', 'expired', 'menu']),
  visible: z.boolean().optional(),
  runId: z.string().optional(),
  action: z.enum(['pause', 'resume', 'stop', 'takeover', 'dismiss']).optional(),
  bytes: z.number().optional(),
}).strict()

interface Waiter {
  type: string
  runId?: string
  resolve: () => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

async function processExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', () => resolve())
  })
}

class BrowserPreviewProcess {
  private child?: ChildProcess
  private runId?: string
  private heartbeat?: NodeJS.Timeout
  private readonly waiters = new Set<Waiter>()
  private closed = false

  private constructor(
    private readonly helperPath: string,
    private readonly temporaryRoot: string | undefined,
    private readonly onControl: (action: ControlAction) => void,
    private readonly onUnavailable: () => void,
  ) {}

  static async create(
    helperPath: string | undefined,
    onControl: (action: ControlAction) => void,
    onUnavailable: () => void,
  ): Promise<BrowserPreviewProcess> {
    if (helperPath !== undefined) return new BrowserPreviewProcess(helperPath, undefined, onControl, onUnavailable)
    const source = fileURLToPath(new URL('../native/BrowserPreview.swift', import.meta.url))
    try {
      const binary = await compileSwiftHelper([source], 'BrowserPreview')
      return new BrowserPreviewProcess(binary, undefined, onControl, onUnavailable)
    } catch (error) {
      throw new Error('browser_preview_compilation_failed', { cause: error })
    }
  }

  get pid(): number | undefined { return this.child?.pid }

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
          reject(new Error(`browser_preview_${type}_timeout`))
        }, timeoutMs),
      }
      waiter.timer.unref()
      this.waiters.add(waiter)
    })
  }

  private handleEvent(raw: string): void {
    const event = helperEvent.safeParse(JSON.parse(raw))
    if (!event.success) return
    for (const waiter of [...this.waiters]) {
      if (waiter.type === event.data.type && waiter.runId === event.data.runId) waiter.resolve()
    }
    if (event.data.type === 'control' && event.data.runId === this.runId && event.data.action !== undefined) {
      if (event.data.action === 'dismiss') {
        this.runId = undefined
        this.onControl('dismiss')
        return
      }
      this.onControl(event.data.action)
    }
    if (event.data.type === 'expired' && event.data.runId === this.runId) {
      this.runId = undefined
      this.onUnavailable()
    }
  }

  private async ensureProcess(): Promise<void> {
    if (this.child !== undefined) return
    if (this.closed) throw new Error('browser_preview_closed')
    const ready = this.waitFor('ready', undefined, 10000)
    const child = spawn(this.helperPath, [], { stdio: ['pipe', 'pipe', 'ignore'] })
    this.child = child
    const lines = createInterface({ input: child.stdout! })
    lines.on('line', line => this.handleEvent(line))
    child.once('error', () => {
      for (const waiter of [...this.waiters]) waiter.reject(new Error('browser_preview_unavailable'))
    })
    child.once('exit', () => {
      if (this.child === child) this.child = undefined
      lines.close()
      for (const waiter of [...this.waiters]) waiter.reject(new Error('browser_preview_unavailable'))
      if (!this.closed && this.runId !== undefined) {
        this.runId = undefined
        this.onUnavailable()
      }
    })
    await ready
  }

  private async send(command: Record<string, unknown>): Promise<void> {
    const stdin = this.child?.stdin
    if (stdin?.writable !== true) throw new Error('browser_preview_unavailable')
    await new Promise<void>((resolve, reject) => {
      stdin.write(`${JSON.stringify(command)}\n`, error => error ? reject(error) : resolve())
    })
  }

  async start(runId: string, title: string, strings: PanelStrings): Promise<void> {
    z.string().uuid().parse(runId)
    await this.finish()
    await this.ensureProcess()
    const started = this.waitFor('started', runId, 5000)
    this.runId = runId
    try {
      await this.send({ type: 'start', runId, title, labels: strings })
      this.heartbeat = setInterval(() => {
        if (this.runId === runId) void this.send({ type: 'heartbeat', runId }).catch(() => undefined)
      }, 1000)
      this.heartbeat.unref()
      await started
    } catch (error) {
      await this.finish()
      throw error
    }
  }

  async activity(event: ActivityEvent): Promise<void> {
    if (this.runId === undefined) throw new Error('browser_preview_not_running')
    await this.send({
      type: 'activity', runId: this.runId, phase: event.phase, operation: event.operation,
      step: event.step, maxSteps: event.maxSteps, route: event.route,
    })
  }

  async frame(data: string, title?: string): Promise<void> {
    if (this.runId === undefined) return
    const framed = this.waitFor('frame', this.runId, 5000)
    await this.send({ type: 'frame', runId: this.runId, data, ...title === undefined ? {} : { title } })
    await framed
  }

  async finish(outcome?: RunOutcome): Promise<void> {
    const runId = this.runId
    this.runId = undefined
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat)
    this.heartbeat = undefined
    if (runId === undefined || this.child?.stdin?.writable !== true) return
    await this.send({
      type: 'finish', runId,
      ...outcome === undefined ? {} : {
        persistent: true, status: outcome.status, reason: outcome.reason, route: outcome.route,
      },
    }).catch(() => undefined)
  }

  async dismiss(): Promise<void> {
    if (this.child?.stdin?.writable === true) await this.send({ type: 'dismiss' }).catch(() => undefined)
  }

  async close(): Promise<void> {
    if (this.closed) return
    await this.finish()
    this.closed = true
    const child = this.child
    if (child !== undefined) {
      if (child.stdin?.writable === true) {
        child.stdin.write(`${JSON.stringify({ type: 'stop' })}\n`)
        child.stdin.end()
      }
      await Promise.race([
        processExit(child),
        new Promise<void>(resolve => setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
          resolve()
        }, 2000).unref()),
      ])
      this.child = undefined
    }
    if (this.temporaryRoot !== undefined) {
      await rm(this.temporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    }
  }
}

export class PreviewBrowserIndicator implements BrowserRunIndicator {
  private runId?: string
  private captureTimer?: NodeJS.Timeout
  private capturing = false

  private constructor(
    private readonly page: Page,
    private readonly dom: BrowserControlIndicator,
    private readonly preview: BrowserPreviewProcess,
    private readonly strings: PanelStrings,
  ) {}

  static async create(
    page: Page,
    onControl: (action: ControlAction) => void,
    helperPath?: string,
    onUnavailable: () => void = () => onControl('stop'),
    strings: PanelStrings = DEFAULT_PANEL_STRINGS,
  ): Promise<PreviewBrowserIndicator> {
    const preview = await BrowserPreviewProcess.create(helperPath, onControl, onUnavailable)
    return new PreviewBrowserIndicator(
      page, new BrowserControlIndicator(page, onControl, false, strings), preview, strings,
    )
  }

  get pid(): number | undefined { return this.preview.pid }

  private async capture(required: boolean): Promise<void> {
    if (this.capturing || this.runId === undefined || this.page.isClosed()) return
    this.capturing = true
    try {
      const image = await this.page.screenshot({ type: 'png', timeout: 5000 })
      const title = await this.page.title().catch(() => undefined)
      if (this.runId !== undefined) await this.preview.frame(image.toString('base64'), title)
    } catch (error) {
      if (required) throw error
    } finally {
      this.capturing = false
    }
  }

  async start(runId: string): Promise<void> {
    await this.dom.start(runId)
    try {
      await this.preview.start(runId, await this.page.title(), this.strings)
      this.runId = runId
      await this.capture(true)
      this.captureTimer = setInterval(() => { void this.capture(false) }, 400)
      this.captureTimer.unref()
    } catch (error) {
      this.runId = undefined
      await Promise.allSettled([this.preview.finish(), this.dom.finish()])
      throw error
    }
  }

  async activity(event: ActivityEvent): Promise<void> {
    await Promise.all([this.dom.activity(event), this.preview.activity(event)])
    if (event.phase === 'acting') await this.capture(true)
  }

  async finish(outcome?: RunOutcome): Promise<void> {
    this.runId = undefined
    if (this.captureTimer !== undefined) clearInterval(this.captureTimer)
    this.captureTimer = undefined
    await Promise.allSettled([this.preview.finish(outcome), this.dom.finish()])
  }

  async dismiss(): Promise<void> {
    this.runId = undefined
    if (this.captureTimer !== undefined) clearInterval(this.captureTimer)
    this.captureTimer = undefined
    await Promise.allSettled([this.dom.finish(), this.preview.dismiss()])
  }

  async close(): Promise<void> {
    await this.finish()
    await Promise.allSettled([this.preview.close(), this.dom.close()])
  }
}
