/**
 * BR-13 — downloads are written to disk for every page without any approval or cap.
 *
 * index.ts:174-177 creates one DownloadSink per resource and attaches it to the
 * current page *and to every page the context ever opens*
 * (`context.on('page', next => downloads.attach(next))`). downloads.ts saves
 * whatever the page suggests, with no approval, no size cap and no origin/type
 * check, and `waitForLatest` returns the newest record even if it belongs to an
 * earlier action.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, BrowserContext } from 'playwright'
import { DownloadSink } from '../../../packages/dsh-browser-use-d1/src/downloads.ts'
import { launch } from './harness.ts'

let browser: Browser
let root: string
beforeAll(async () => {
  browser = await launch()
  root = await mkdtemp(join(tmpdir(), 'br13-dl-'))
})
afterAll(async () => {
  await browser.close()
  await rm(root, { recursive: true, force: true })
})

async function sink(context: BrowserContext): Promise<DownloadSink> {
  const instance = new DownloadSink(root)
  await instance.ready()
  for (const page of context.pages()) instance.attach(page)
  context.on('page', page => instance.attach(page))
  return instance
}

async function settle(instance: DownloadSink, expected: number): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (instance.list().length >= expected && instance.list().every(record => record.state !== 'saving')) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('downloads did not settle')
}

it('saves an arbitrary number of downloads with no approval and no size cap', async () => {
  const context = await browser.newContext({ acceptDownloads: true })
  const page = await context.newPage()
  const downloads = await sink(context)
  await page.setContent(`
    <a id="a" download="invoice.html" href="data:text/html,<h1>1</h1>">one</a>
    <a id="b" download="invoice.html" href="data:text/html,<h1>2</h1>">two</a>
    <a id="c" download="invoice.html" href="data:text/html,<h1>3</h1>">three</a>`)
  await page.click('#a')
  await page.click('#b')
  await page.click('#c')
  await settle(downloads, 3)

  const records = downloads.list()
  expect(records).toHaveLength(3)
  for (const record of records) {
    expect(record.state).toBe('saved')
    expect((await stat(record.path!)).size).toBeGreaterThan(0)
    expect(record.path!).toContain(root)
  }
  expect(await readdir(root)).toHaveLength(3)
  await context.close()
})

it('a background tab nobody is looking at also writes files to disk', async () => {
  const context = await browser.newContext({ acceptDownloads: true })
  const downloads = await sink(context)
  const opener = await context.newPage()
  await opener.goto('about:blank')
  // A popup/background tab created by the page: no tool call targets it.
  const background = await context.newPage()
  await background.setContent('<a id="drop" download="payload.bin" href="data:application/octet-stream,PAYLOAD">x</a>')
  await background.click('#drop')
  await settle(downloads, 1)
  expect(downloads.list()[0]!.name).toBe('payload.bin')
  await context.close()
})

it('waitForLatest reports an older download as the result of the current call', async () => {
  const context = await browser.newContext({ acceptDownloads: true })
  const page = await context.newPage()
  const downloads = await sink(context)
  await page.setContent('<a id="a" download="first.txt" href="data:text/plain,one">a</a>')
  await page.click('#a')
  await settle(downloads, 1)
  // No new download happens here, yet the wait succeeds with the previous file.
  const record = await downloads.waitForLatest(200)
  expect(record?.name).toBe('first.txt')
  await context.close()
})
