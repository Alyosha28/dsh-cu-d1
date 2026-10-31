import { afterAll, beforeAll, expect, it } from 'vitest'
import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import { captureTakeoverState, installSessionStorageRestore, restoreTakeoverState } from '../src/takeover.ts'
import { CHROME } from './fixtures.ts'

const HTML = `<!doctype html>
<title>Takeover fixture</title>
<style>body { height: 3000px; } input { display: block; }</style>
<form onsubmit="return false">
  <label>From <input id="from" value=""></label>
  <label>Nonstop only <input id="nonstop" type="checkbox"></label>
  <label>Class <select id="cabin"><option value="economy">Economy</option><option value="business">Business</option></select></label>
  <textarea id="note"></textarea>
</form>
<div id="marker">bottom</div>`

let browser: Browser
beforeAll(async () => { browser = await chromium.launch({ executablePath: CHROME, headless: true }) })
afterAll(async () => { await browser.close() })

async function pageWithRoute() {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.route('https://example.test/**', route => route.fulfill({ contentType: 'text/html', body: HTML }))
  await page.goto('https://example.test/flights')
  return { context, page }
}

it('captures session storage, scroll, and form state from the controlled page', async () => {
  const { context, page } = await pageWithRoute()
  await page.evaluate(() => sessionStorage.setItem('cart', 'LX-318'))
  await page.fill('#from', 'Zürich')
  await page.check('#nonstop')
  await page.selectOption('#cabin', 'business')
  await page.fill('#note', 'window seat')
  await page.evaluate(() => window.scrollTo(0, 1200))

  const state = await captureTakeoverState(page)
  expect(state).toMatchObject({
    url: 'https://example.test/flights',
    origin: 'https://example.test',
    sessionStorage: [['cart', 'LX-318']],
    scrollY: 1200,
  })
  expect(state?.fields).toMatchObject([
    { index: 0, id: 'from', tag: 'input', type: 'text', value: 'Zürich' },
    { index: 1, id: 'nonstop', tag: 'input', type: 'checkbox', checked: true },
    { index: 2, id: 'cabin', tag: 'select', value: 'business' },
    { index: 3, id: 'note', tag: 'textarea', value: 'window seat' },
  ])
  await context.close()
})

it('restores the same state into the takeover tab before and after navigation', async () => {
  const source = await pageWithRoute()
  await source.page.evaluate(() => sessionStorage.setItem('cart', 'LX-318'))
  await source.page.fill('#from', 'Zürich')
  await source.page.check('#nonstop')
  await source.page.selectOption('#cabin', 'business')
  await source.page.evaluate(() => window.scrollTo(0, 1200))
  const state = await captureTakeoverState(source.page)
  expect(state).toBeDefined()

  const takeoverContext = await browser.newContext()
  await installSessionStorageRestore(takeoverContext, state!)
  const takeover = await takeoverContext.newPage()
  await takeover.route('https://example.test/**', route => route.fulfill({ contentType: 'text/html', body: HTML }))
  await takeover.goto('https://example.test/flights')
  await restoreTakeoverState(takeover, state!)

  expect(await takeover.evaluate(() => sessionStorage.getItem('cart'))).toBe('LX-318')
  expect(await takeover.inputValue('#from')).toBe('Zürich')
  expect(await takeover.isChecked('#nonstop')).toBe(true)
  expect(await takeover.inputValue('#cabin')).toBe('business')
  expect(await takeover.evaluate(() => window.scrollY)).toBe(1200)

  await takeoverContext.close()
  await source.context.close()
})

it('leaves a changed page alone instead of writing into the wrong control', async () => {
  const source = await pageWithRoute()
  await source.page.fill('#from', 'Zürich')
  const state = await captureTakeoverState(source.page)
  expect(state).toBeDefined()

  const takeoverContext = await browser.newContext()
  const takeover = await takeoverContext.newPage()
  await takeover.route('https://example.test/**', route => route.fulfill({
    contentType: 'text/html',
    body: '<title>Different</title><input id="only">',
  }))
  await takeover.goto('https://example.test/flights')
  await restoreTakeoverState(takeover, state!)
  expect(await takeover.inputValue('#only')).toBe('')

  await takeoverContext.close()
  await source.context.close()
})

it('returns undefined when the source page cannot be read', async () => {
  const { context, page } = await pageWithRoute()
  await context.close()
  expect(await captureTakeoverState(page)).toBeUndefined()
})
