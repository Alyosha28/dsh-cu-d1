import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DownloadSink } from '../src/downloads.ts'
import { CHROME, close, fixtureServer, listen } from './fixtures.ts'

const BODY = 'dsh-cu download fixture\nline two\n'

let browser: Browser
let dir: string
let fixtures: ReturnType<typeof fixtureServer>
let fixtureUrl: string
beforeAll(async () => {
  browser = await chromium.launch({ executablePath: CHROME, headless: true })
  fixtures = fixtureServer()
  fixtureUrl = await listen(fixtures)
})
afterAll(async () => { await browser.close(); await close(fixtures) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

it('saves a page download and reports its path and size', async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-cu-download-test-'))
  const context = await browser.newContext({ acceptDownloads: true })
  const page = await context.newPage()
  await page.goto(`${fixtureUrl}/download.html`)

  const sink = new DownloadSink(dir)
  await sink.ready()
  sink.attach(page)
  // BR-13: nothing is written without an approved wait. The approval is granted
  // while the wait is in flight, then the click starts the download.
  const pending = sink.awaitApproved({ async request() { return { approved: true } } } as never,
    { id: 'downloads-agent' } as never, { timeoutMs: 5000 }, new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 50))
  await page.click('#report')

  const result = await pending
  expect(result.status).toBe('success')
  const record = result.download!
  expect(record).toMatchObject({ name: 'report.bin', state: 'saved' })
  expect(record.bytes).toBe(Buffer.byteLength(BODY))
  expect(record.path).toBeDefined()
  expect(await readFile(record.path!, 'utf8')).toBe(BODY)
  expect(sink.list()).toHaveLength(1)
  await context.close()
})

it('times out cleanly when the page starts no download', async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-cu-download-test-'))
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`${fixtureUrl}/download.html`)
  const sink = new DownloadSink(dir)
  await sink.ready()
  sink.attach(page)
  expect(await sink.waitForLatest(200)).toBeUndefined()
  expect(sink.list()).toEqual([])
  await context.close()
})

it('strips path separators from a suggested filename', async () => {
  const { sanitizeDownloadName } = await import('../src/downloads.ts')
  expect(sanitizeDownloadName('../../etc/passwd')).toBe('passwd')
  expect(sanitizeDownloadName('..')).toBe('download')
  expect(sanitizeDownloadName('report\n.bin')).toBe('report_.bin')
})
