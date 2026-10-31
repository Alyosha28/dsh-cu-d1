import { afterAll, beforeAll, expect, it } from 'vitest'
import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import { BrowserDom } from '../src/dom.ts'
import { CHROME } from './fixtures.ts'

let browser: Browser
beforeAll(async () => {
  browser = await chromium.launch({ executablePath: CHROME, headless: true })
})
afterAll(async () => { await browser.close() })

it('returns a real snapshot and executes a fresh observed target', async () => {
  const page = await browser.newPage()
  await page.setContent('<h1>Fixture</h1><div role="status">Idle</div><button>Search</button>')
  const dom = new BrowserDom(page)
  const snapshot = await dom.snapshot()
  expect(snapshot.elements).toHaveLength(3)
  expect(snapshot.elements.find(element => element.name === 'Idle')?.actions).toEqual([])
  const button = snapshot.elements.find(element => element.name === 'Search')!
  expect(button.actions).toEqual(['click'])
  await dom.execute(snapshot, { operation: 'CLICK', target: button.id }, 1000)
  expect(await page.locator('button').evaluate(element => element === document.activeElement)).toBe(true)
  await page.close()
})

it('returns after click dispatch without waiting for a slow navigation', async () => {
  const page = await browser.newPage()
  let navigationRequests = 0
  let markRouted!: () => void
  const routed = new Promise<void>(resolve => { markRouted = resolve })
  await page.route('https://slow.test/', async route => {
    navigationRequests += 1
    markRouted()
    await new Promise(resolve => setTimeout(resolve, 2000))
    await route.fulfill({ contentType: 'text/html', body: '<h1>Slow result</h1>' })
  })
  await page.setContent(`<a href="https://slow.test/">Slow navigation</a>`)
  const dom = new BrowserDom(page)
  const snapshot = await dom.snapshot()
  const link = snapshot.elements.find(element => element.name === 'Slow navigation')!
  await dom.execute(snapshot, { operation: 'CLICK', target: link.id }, 1000)
  await routed
  expect(navigationRequests).toBe(1)
  await page.waitForURL('https://slow.test/', { timeout: 5000 })
  expect(await page.locator('h1').innerText()).toBe('Slow result')
  await page.close()
})
