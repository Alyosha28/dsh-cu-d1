import { afterAll, beforeAll, expect, it } from 'vitest'
import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import { TabMarker } from '../src/tab-marker.ts'
import { CHROME } from './fixtures.ts'

const LABEL = 'DSH-CU 控制中'
const PREFIX = `● ${LABEL} · `

const PAGE = `<!doctype html><html><head><title>Article</title>
<link rel="icon" href="/favicon.ico"></head><body><h1>Article</h1></body></html>`

let browser: Browser
beforeAll(async () => { browser = await chromium.launch({ executablePath: CHROME, headless: true }) })
afterAll(async () => { await browser.close() })

async function pageWithRoutes() {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.route('https://example.test/**', route => route.fulfill({ contentType: 'text/html', body: PAGE }))
  await page.goto('https://example.test/one')
  return { context, page }
}

it('marks the tab title and icon while a run is active', async () => {
  const { context, page } = await pageWithRoutes()
  expect(await page.title()).toBe('Article')

  const marker = new TabMarker(page, LABEL)
  await marker.start()
  expect(await page.title()).toBe(`${PREFIX}Article`)
  const icon = await page.getAttribute('link[rel~="icon"]', 'href')
  expect(icon).toMatch(/^data:image\/svg\+xml,/u)

  await marker.clear()
  expect(await page.title()).toBe('Article')
  expect(await page.getAttribute('link[rel~="icon"]', 'href')).toBe('/favicon.ico')
  await context.close()
})

it('keeps the marker when the page renames itself or navigates', async () => {
  const { context, page } = await pageWithRoutes()
  const marker = new TabMarker(page, LABEL)
  await marker.start()

  await page.evaluate(() => { document.title = 'Renamed by the app' })
  await page.waitForFunction((prefix: string) => document.title.startsWith(prefix), PREFIX)
  expect(await page.title()).toBe(`${PREFIX}Renamed by the app`)

  await page.goto('https://example.test/two')
  await page.waitForFunction((prefix: string) => document.title.startsWith(prefix), PREFIX)
  expect(await page.title()).toBe(`${PREFIX}Article`)

  await marker.clear()
  expect(await page.title()).toBe('Article')
  await context.close()
})
