import { afterAll, beforeAll, expect, it } from 'vitest'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { Config } from '../src/config.ts'
import { runBrowserExtract } from '../src/extract.ts'
import { CHROME } from './fixtures.ts'

const HTML = `<!doctype html>
<title>Order summary</title>
<h1>Order summary</h1>
<label>Email <input id="email" value="a@b.test"></label>
<label>Nonstop only <input id="nonstop" type="checkbox" checked></label>
<div id="total">Total: $1,299.00</div>
<a id="docs" href="/docs/start">Documentation</a>
<ul><li class="row"> Alpha </li><li class="row">Beta</li></ul>
<span class="duplicate">Duplicate</span><span class="duplicate">Duplicate</span>
<span id="empty">   </span>`

let browser: Browser
beforeAll(async () => {
  browser = await chromium.launch({ executablePath: CHROME, headless: true })
})
afterAll(async () => { await browser.close() })

const config = Config({ mode: 'launch', decisionToken: 'unused-token' })

async function fixturePage(): Promise<Page> {
  const page = await browser.newPage()
  await page.route('https://example.test/**', route => route.fulfill({ contentType: 'text/html', body: HTML }))
  return page
}

function extract(page: Page, fields: unknown[], extra: Record<string, unknown> = {}) {
  return runBrowserExtract(page, config, { fields, ...extra }, new AbortController().signal)
}

it('reads typed values, lists, attributes, and relative URLs with DOM evidence', async () => {
  const page = await fixturePage()
  const result = await extract(page, [
    { name: 'email', locator: { kind: 'label', text: 'Email' } },
    { name: 'nonstop', type: 'boolean', locator: { kind: 'label', text: 'Nonstop only' } },
    { name: 'total', type: 'number', locator: { kind: 'css', selector: '#total' } },
    { name: 'docs', type: 'url', attribute: 'href', locator: { kind: 'role', role: 'link', name: 'Documentation' } },
    { name: 'rows', all: true, locator: { kind: 'css', selector: '.row' } },
    { name: 'note', required: false, locator: { kind: 'css', selector: '#absent' } },
  ], { url: 'https://example.test/orders/1', timeoutMs: 0 })
  expect(result).toMatchObject({
    status: 'success',
    reason: 'extracted_with_missing_optional_fields',
    data: {
      email: 'a@b.test', nonstop: true, total: 1299,
      docs: 'https://example.test/docs/start', rows: ['Alpha', 'Beta'],
    },
    missing: ['note'],
    evidence: {
      source: 'dom', trusted: false, url: 'https://example.test/orders/1', title: 'Order summary',
      fields: [
        { name: 'email', count: 1, ok: true },
        { name: 'nonstop', count: 1, ok: true },
        { name: 'total', count: 1, ok: true },
        { name: 'docs', count: 1, ok: true },
        { name: 'rows', count: 2, ok: true },
        { name: 'note', count: 0, ok: false, reason: 'missing' },
      ],
    },
  })
  expect(result.data).not.toHaveProperty('note')
  await page.close()
})

it('separates absent elements from present but empty values', async () => {
  const page = await fixturePage()
  await page.goto('https://example.test/orders/1')
  const result = await extract(page, [
    { name: 'emptyNote', required: false, locator: { kind: 'css', selector: '#empty' } },
    { name: 'requiredTotal', locator: { kind: 'css', selector: '#absent' } },
  ], { timeoutMs: 0 })
  expect(result).toMatchObject({
    status: 'blocked', reason: 'extract_field_missing',
    missing: ['requiredTotal'], empty: ['emptyNote'], details: { required: ['requiredTotal'] },
  })
  expect(result.data).toBeUndefined()
  await page.close()
})

it('returns an empty string for a present but blank string field', async () => {
  const page = await fixturePage()
  await page.goto('https://example.test/orders/1')
  const result = await extract(page, [
    { name: 'emptyNote', locator: { kind: 'css', selector: '#empty' } },
  ], { timeoutMs: 0 })
  expect(result).toMatchObject({
    status: 'success', reason: 'extracted_with_empty_fields',
    data: { emptyNote: '' }, empty: ['emptyNote'],
    evidence: { fields: [{ name: 'emptyNote', count: 1, ok: true, empty: true }] },
  })
  await page.close()
})

it('refuses to coerce a blank value to a non-string type', async () => {
  const page = await fixturePage()
  await page.goto('https://example.test/orders/1')
  const result = await extract(page, [
    { name: 'blankTotal', type: 'number', locator: { kind: 'css', selector: '#empty' } },
  ], { timeoutMs: 0 })
  expect(result).toMatchObject({
    status: 'blocked', reason: 'extract_field_invalid',
    details: { field: 'blankTotal', expectedType: 'number', reason: 'empty_value' },
  })
  await page.close()
})

it('escalates ambiguous locators instead of selecting a match', async () => {
  const page = await fixturePage()
  await page.goto('https://example.test/orders/1')
  const result = await extract(page, [
    { name: 'duplicate', locator: { kind: 'text', text: 'Duplicate', exact: true } },
  ])
  expect(result).toMatchObject({
    status: 'escalated', reason: 'extract_locator_ambiguous', details: { field: 'duplicate', count: 2 },
  })
  expect(result.data).toBeUndefined()
  await page.close()
})

it('rejects values that cannot be coerced to the requested type', async () => {
  const page = await fixturePage()
  await page.goto('https://example.test/orders/1')
  const result = await extract(page, [
    { name: 'emailAsNumber', type: 'number', locator: { kind: 'label', text: 'Email' } },
  ])
  expect(result).toMatchObject({
    status: 'blocked', reason: 'extract_field_invalid',
    details: { field: 'emailAsNumber', expectedType: 'number', reason: 'not_a_number' },
  })
  await page.close()
})

it('preserves special identifier keys without mutating the result prototype', async () => {
  const page = await fixturePage()
  await page.goto('https://example.test/orders/1')
  const result = await extract(page, [
    { name: '__proto__', all: true, locator: { kind: 'css', selector: '.row' } },
    { name: 'constructor', locator: { kind: 'css', selector: '#total' } },
  ])
  expect(result.status).toBe('success')
  expect(Object.hasOwn(result.data!, '__proto__')).toBe(true)
  expect(result.data!['__proto__']).toEqual(['Alpha', 'Beta'])
  expect(result.data!['constructor']).toBe('Total: $1,299.00')
  expect(Object.getPrototypeOf(result.data!)).toBeNull()
  const serialized = JSON.parse(JSON.stringify(result.data)) as Record<string, unknown>
  expect(serialized['__proto__']).toEqual(['Alpha', 'Beta'])
  await page.close()
})

it('does not install observation markers or globals while extracting', async () => {
  const page = await fixturePage()
  await page.goto('https://example.test/orders/1')
  const result = await extract(page, [
    { name: 'total', type: 'number', locator: { kind: 'css', selector: '#total' } },
  ])
  expect(result).toMatchObject({ status: 'success', data: { total: 1299 } })
  expect(await page.locator('[data-dsh-decision-id]').count()).toBe(0)
  expect(await page.evaluate(() => '__dshDecisionObserver' in window)).toBe(false)
  await page.close()
})

it('aborts a required locator wait instead of consuming the full budget', async () => {
  const page = await fixturePage()
  await page.goto('https://example.test/orders/1')
  const controller = new AbortController()
  const started = Date.now()
  const pending = runBrowserExtract(page, config, {
    fields: [{ name: 'absent', locator: { kind: 'css', selector: '#absent' } }],
    timeoutMs: 5000,
  }, controller.signal)
  await new Promise(resolve => setTimeout(resolve, 100))
  controller.abort(new Error('stop requested'))
  await expect(pending).rejects.toThrow('stop requested')
  expect(Date.now() - started).toBeLessThan(1000)
  await page.close()
})

it('waits within the shared budget for a required asynchronous value', async () => {
  const page = await fixturePage()
  await page.goto('https://example.test/orders/1')
  await page.evaluate(() => {
    setTimeout(() => {
      const element = document.createElement('div')
      element.id = 'late'
      element.textContent = 'Ready'
      document.body.append(element)
    }, 100)
  })
  const result = await extract(page, [
    { name: 'late', locator: { kind: 'css', selector: '#late' } },
  ], { timeoutMs: 1000 })
  expect(result).toMatchObject({ status: 'success', data: { late: 'Ready' } })
  await page.close()
})
