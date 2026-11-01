/**
 * BR-13 — a download wait must report only what this call produced, and nothing
 * may be written to disk without an explicit approval naming the destination.
 */
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DownloadSink, describeDownloadDir } from '../src/downloads.ts'
import { CHROME } from './fixtures.ts'

let browser: Browser
let dir: string
beforeAll(async () => { browser = await chromium.launch({ executablePath: CHROME, headless: true }) })
afterAll(async () => { await browser.close() })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function sinkFor(page: Awaited<ReturnType<Browser['newPage']>>) {
  dir = await mkdtemp(join(tmpdir(), 'dsh-cu-download-gate-'))
  const sink = new DownloadSink(dir)
  await sink.ready()
  sink.attach(page)
  return sink
}

class Gate {
  readonly calls: Array<{ question: string; detail: string }> = []
  constructor(private readonly approve: boolean, private readonly during: () => Promise<void> | void = () => undefined) {}

  async request(_agent: unknown, request: { question: string; detail: string }) {
    this.calls.push({ question: request.question, detail: request.detail })
    await this.during()
    return this.approve ? { approved: true } : { approved: false, reason: 'denied_by_user' }
  }
}

it('a denied wait writes nothing and reports confirmation_required', async () => {
  const context = await browser.newContext({ acceptDownloads: true })
  const page = await context.newPage()
  const sink = await sinkFor(page)
  const gate = new Gate(false)
  const result = await sink.awaitApproved(gate as never, { id: 'a' } as never, { timeoutMs: 500 }, new AbortController().signal)
  expect(result).toMatchObject({ status: 'confirmation_required', reason: 'denied_by_user' })
  expect(gate.calls).toHaveLength(1)
  // The prompt names the directory that will receive the bytes.
  expect(gate.calls[0]!.detail).toContain(dir)
  await page.setContent('<a id="a" download="late.txt" href="data:text/plain,late">a</a>')
  await page.click('#a')
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(await readdir(dir)).toEqual([])
  await context.close()
})

it('an approved wait reports only files created after the wait started', async () => {
  const context = await browser.newContext({ acceptDownloads: true })
  const page = await context.newPage()
  const sink = await sinkFor(page)
  await page.setContent(`
    <a id="old" download="old.txt" href="data:text/plain,old">old</a>
    <a id="new" download="new.txt" href="data:text/plain,new">new</a>`)
  // The earlier file arrives under its own approved wait, so it is a real record
  // that the next wait must not claim.
  const seed = new Gate(true, async () => { await page.click('#old') })
  const seeded = await sink.awaitApproved(seed as never, { id: 'a' } as never, { timeoutMs: 5000 }, new AbortController().signal)
  expect(seeded.status).toBe('success')
  expect(sink.list().map(record => record.name)).toEqual(['old.txt'])

  // A wait with no new download must not report the previous run's file.
  const idle = await sink.awaitApproved(new Gate(true) as never, { id: 'a' } as never, { timeoutMs: 300 }, new AbortController().signal)
  expect(idle).toMatchObject({ status: 'escalated', reason: 'download_timeout' })
  expect(idle.download).toBeUndefined()

  // A wait that does see a new download reports that one, not the older file.
  const gate = new Gate(true, async () => { await page.click('#new') })
  const live = await sink.awaitApproved(gate as never, { id: 'a' } as never, { timeoutMs: 5000 }, new AbortController().signal)
  expect(live.status).toBe('success')
  expect(live.download?.name).toBe('new.txt')
  expect(live.download?.path).toContain(dir)
  await context.close()
})

it('refuses to save anything when no approved wait covers the download', async () => {
  const context = await browser.newContext({ acceptDownloads: true })
  const page = await context.newPage()
  const sink = await sinkFor(page)
  await page.setContent('<a id="a" download="payload.html" href="data:text/html,<h1>x</h1>">a</a>')
  await page.click('#a')
  await new Promise(resolve => setTimeout(resolve, 500))
  // An unapproved download leaves no trace at all: no file, and no record that a
  // later wait could mistake for its own result.
  expect(await readdir(dir)).toEqual([])
  expect(sink.list()).toEqual([])
  await context.close()
})

it('describes the download destination for the approval prompt', async () => {
  expect(describeDownloadDir('/tmp/dsh-cu-downloads-1')).toContain('/tmp/dsh-cu-downloads-1')
})
