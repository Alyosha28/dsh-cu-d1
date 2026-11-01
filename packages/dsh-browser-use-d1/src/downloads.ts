import { mkdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Download, Page } from 'playwright'
import type { ApprovalGateway } from '@albaincompleta/dsh-cu-core/approvals'

export interface DownloadRecord {
  id: string
  /** Suggested name from the page, sanitized for the local filesystem. */
  name: string
  /** Absolute path once the download completed. */
  path?: string
  state: 'saving' | 'saved' | 'failed'
  bytes?: number
  startedAt: string
  error?: string
}

/** Per-file cap so one page cannot fill the disk with a single response. */
export const DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024

/** Keeps the page suggestion but removes path separators and control characters. */
export function sanitizeDownloadName(suggested: string): string {
  const name = basename(suggested).replace(/[\u0000-\u001f/\\]/gu, '_').trim()
  return name === '' || name === '.' || name === '..' ? 'download' : name.slice(0, 180)
}

/** Directory text for the approval prompt: the exact place bytes will land. */
export function describeDownloadDir(dir: string): string {
  return dir
}

export interface DownloadWaitResult {
  status: 'success' | 'escalated' | 'confirmation_required'
  reason: string
  download?: DownloadRecord
}

/**
 * Saves the downloads a controlled page starts.
 *
 * A download is a side effect the model never sees in the DOM: without a sink
 * the click path only times out, and the bytes are discarded when the browser
 * closes. Nothing is written until an approved wait covers it (BR-13): a page
 * (or a background tab) cannot decide on its own to put a file on this disk.
 */
export class DownloadSink {
  private readonly records: DownloadRecord[] = []
  private readonly waiters = new Set<() => void>()
  /**
   * A download is refused unless an approved wait covers it. A window start is
   * recorded *before* the prompt is composed (not after the answer), so a page
   * that starts the download while the human is still reading still lands,
   * while a page with no approved wait at all never writes.
   */
  private approvedWaits = 0
  private pending = 0

  constructor(readonly dir: string) {}

  async ready(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
  }

  attach(page: Page): void {
    // Every tab gets its own listener; a download started in a background tab
    // is still owned by this run.
    page.on('download', download => { void this.save(download) })
  }

  list(): DownloadRecord[] {
    return this.records.map(record => ({ ...record }))
  }

  /**
   * Waits for the newest download and for it to finish.
   *
   * A page starts a download while the triggering tool call is still returning,
   * so "the next download" usually already exists by the time a caller asks.
   * Returning the newest record makes the wait idempotent instead of a race.
   * Callers that need "only what this call produced" use {@link awaitApproved}.
   */
  async waitForLatest(timeoutMs: number, signal?: AbortSignal): Promise<DownloadRecord | undefined> {
    const deadline = Date.now() + timeoutMs
    while (true) {
      signal?.throwIfAborted()
      const candidate = this.records.at(-1)
      if (candidate !== undefined) {
        while (candidate.state === 'saving' && Date.now() < deadline) {
          signal?.throwIfAborted()
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        return { ...candidate }
      }
      if (Date.now() >= deadline) return undefined
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiters.delete(wake)
          resolve()
        }, Math.min(100, Math.max(1, deadline - Date.now())))
        const wake = () => {
          clearTimeout(timer)
          this.waiters.delete(wake)
          resolve()
        }
        this.waiters.add(wake)
        signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          this.waiters.delete(wake)
          reject(signal.reason instanceof Error ? signal.reason : new Error('download wait aborted'))
        }, { once: true })
      })
    }
  }

  /**
   * Asks once for permission to write into `dir`, then reports only the file
   * this wait produced.
   *
   * The record list is snapshotted *before* the prompt, so a download from an
   * earlier action can never be reported as the result of this call (BR-13).
   */
  async awaitApproved(
    approvals: ApprovalGateway | undefined,
    agent: Agent,
    options: { timeoutMs: number; strings?: DownloadStrings },
    signal: AbortSignal,
  ): Promise<DownloadWaitResult> {
    const labels = options.strings ?? DEFAULT_STRINGS
    const before = new Set(this.records.map(record => record.id))
    this.pending += 1
    let approval: { approved: boolean; reason?: string }
    try {
      approval = approvals === undefined
        ? { approved: false, reason: 'approval_unavailable' }
        : await approvals.request(agent, {
          id: 'dsh-cu-download',
          question: labels.question,
          detail: labels.detail.replace('{dir}', this.dir),
          approve: labels.approve,
          reject: labels.reject,
        }, signal)
    } finally {
      this.pending -= 1
    }
    if (!approval.approved) {
      // A denied wait leaves neither a file nor a record behind.
      return { status: 'confirmation_required', reason: approval.reason ?? 'denied_by_user' }
    }
    signal.throwIfAborted()

    this.approvedWaits += 1
    try {
      const deadline = Date.now() + options.timeoutMs
      while (true) {
        signal.throwIfAborted()
        const fresh = this.records.filter(record => !before.has(record.id))
        const candidate = fresh.at(-1)
        if (candidate !== undefined) {
          while (candidate.state === 'saving' && Date.now() < deadline) {
            signal.throwIfAborted()
            await new Promise(resolve => setTimeout(resolve, 25))
          }
          if (candidate.state === 'saving') {
            return { status: 'escalated', reason: 'download_timeout' }
          }
          return { status: 'success', reason: 'downloaded', download: { ...candidate } }
        }
        if (Date.now() >= deadline) return { status: 'escalated', reason: 'download_timeout' }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.waiters.delete(wake)
            resolve()
          }, Math.min(50, Math.max(1, deadline - Date.now())))
          const wake = () => {
            clearTimeout(timer)
            this.waiters.delete(wake)
            resolve()
          }
          this.waiters.add(wake)
          signal.addEventListener('abort', () => {
            clearTimeout(timer)
            this.waiters.delete(wake)
            reject(signal.reason instanceof Error ? signal.reason : new Error('download wait aborted'))
          }, { once: true })
        })
      }
    } finally {
      this.approvedWaits -= 1
    }
  }

  private async save(download: Download): Promise<void> {
    const id = randomUUID()
    const name = sanitizeDownloadName(download.suggestedFilename())
    // The event fires as soon as the page asks for a download; refuse before the
    // bytes reach the disk unless an approved wait is covering this moment.
    if (this.approvedWaits <= 0 && this.pending <= 0) {
      // Not even a record: an unapproved download leaves no trace, so no later
      // wait can observe it and report it as a result (BR-13).
      await download.cancel().catch(() => undefined)
      return
    }
    const record: DownloadRecord = { id, name, state: 'saving', startedAt: new Date().toISOString() }
    this.records.push(record)
    for (const wake of [...this.waiters]) wake()
    const target = join(this.dir, `${id}-${name}`)
    try {
      await download.saveAs(target)
      const info = await stat(target)
      if (info.size > DOWNLOAD_MAX_BYTES) {
        record.state = 'failed'
        record.error = 'download_exceeds_size_limit'
      } else {
        record.path = target
        record.bytes = info.size
        record.state = 'saved'
      }
    } catch (error) {
      record.state = 'failed'
      record.error = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
    }
    for (const wake of [...this.waiters]) wake()
  }
}

export interface DownloadStrings {
  question: string
  detail: string
  approve: string
  reject: string
}

const DEFAULT_STRINGS: DownloadStrings = {
  question: 'Allow this page to save a downloaded file to this computer?',
  detail: 'Destination: {dir}\nOnly files created after this approval are reported.',
  approve: 'Allow this download',
  reject: 'Deny',
}
