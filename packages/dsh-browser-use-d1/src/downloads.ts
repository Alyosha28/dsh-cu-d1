import { mkdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Download, Page } from 'playwright'

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

/** Keeps the page suggestion but removes path separators and control characters. */
export function sanitizeDownloadName(suggested: string): string {
  const name = basename(suggested).replace(/[\u0000-\u001f/\\]/gu, '_').trim()
  return name === '' || name === '.' || name === '..' ? 'download' : name.slice(0, 180)
}

/**
 * Saves every download a controlled page starts.
 *
 * A download is a side effect the model never sees in the DOM: without a sink
 * the click path only times out, and the bytes are discarded when the browser
 * closes. Records are kept in memory and files land in `dir`.
 */
export class DownloadSink {
  private readonly records: DownloadRecord[] = []
  private readonly waiters = new Set<() => void>()

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

  private async save(download: Download): Promise<void> {
    const id = randomUUID()
    const name = sanitizeDownloadName(download.suggestedFilename())
    const record: DownloadRecord = { id, name, state: 'saving', startedAt: new Date().toISOString() }
    this.records.push(record)
    for (const wake of [...this.waiters]) wake()
    const target = join(this.dir, `${id}-${name}`)
    try {
      await download.saveAs(target)
      const info = await stat(target)
      record.path = target
      record.bytes = info.size
      record.state = 'saved'
    } catch (error) {
      record.state = 'failed'
      record.error = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
    }
    for (const wake of [...this.waiters]) wake()
  }
}
