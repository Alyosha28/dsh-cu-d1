/**
 * BR-06 — `url_contains` is a raw substring test, so the origin is unverifiable.
 *
 * dom.ts:207 `page.url().includes(assertion.value)`: an attacker hostname that
 * contains the expected host, or a query parameter that carries the expected
 * URL, satisfies the assertion.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Browser } from 'playwright'
import { verifyAll } from '../../../packages/dsh-browser-use-d1/src/dom.ts'
import { launch, newPage } from './harness.ts'

let browser: Browser
beforeAll(async () => { browser = await launch() })
afterAll(async () => { await browser.close() })

it('an attacker host that contains the expected host passes url_contains', async () => {
  const page = await newPage(browser)
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<h1>harness</h1>' }))
  await page.goto('https://example.com.account-verify.test/steal')
  expect(page.url()).toContain('account-verify.test')
  expect(await verifyAll(page, [{ type: 'url_contains', value: 'example.com' }])).toBe(true)
  await page.context().close()
})

it('a query parameter carrying the expected URL passes url_contains', async () => {
  const page = await newPage(browser)
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<h1>harness</h1>' }))
  await page.goto('https://evil.test/phish?next=https://example.com/dashboard')
  expect(await verifyAll(page, [{ type: 'url_contains', value: 'https://example.com/dashboard' }])).toBe(true)
  await page.context().close()
})

it('a loopback origin check is satisfied by a different port than the one expected', async () => {
  const page = await newPage(browser)
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<h1>harness</h1>' }))
  // The trick works for any prefix, including the local decision service the
  // provider trusts: only the "host:port" text matters, not the origin.
  await page.goto('http://127.0.0.1:9/')
  expect(await verifyAll(page, [{ type: 'url_contains', value: '127.0.0.1' }])).toBe(true)
  await page.context().close()
})
