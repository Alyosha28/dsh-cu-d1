/**
 * BR-04 — `text_visible` is a case-insensitive substring match over the whole
 * document, not a scoped assertion.
 *
 * dom.ts:206 `page.getByText(text, { exact: false }).first().isVisible()`:
 *  - `exact: false` makes the assertion text a substring of any page text, so
 *    "Saved" is satisfied by "Not saved" and a failed operation verifies as
 *    success;
 *  - no region/element is named, so a string in a footer, a demo banner or a
 *    hidden template area satisfies an assertion about the operation result;
 *  - only the first match has to be visible, so the page decides which copy of
 *    the text counts.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Browser } from 'playwright'
import { verifyAll } from '../../../packages/dsh-browser-use-d1/src/dom.ts'
import { launch, newPage } from './harness.ts'

let browser: Browser
beforeAll(async () => { browser = await launch() })
afterAll(async () => { await browser.close() })

it('verifies a failed operation as success through a negated phrase', async () => {
  const page = await newPage(browser)
  // The operation failed: nothing was saved and the account still exists.
  await page.setContent(`
    <h1>Account</h1>
    <div role="alert">Not saved. The account was not deleted.</div>`)
  expect(await verifyAll(page, [{ type: 'text_visible', text: 'Saved' }])).toBe(true)
  expect(await verifyAll(page, [{ type: 'text_visible', text: 'deleted' }])).toBe(true)
  await page.context().close()
})

it('verifies success text that only exists in an unrelated region', async () => {
  const page = await newPage(browser)
  await page.setContent(`
    <main><h1>Checkout</h1><div role="alert">Payment declined</div></main>
    <footer>Demo store — an order confirmed here is only a sample.</footer>`)
  expect(await verifyAll(page, [{ type: 'text_visible', text: 'order confirmed' }])).toBe(true)
  await page.context().close()
})

it('lets the page choose which copy of the text satisfies the assertion', async () => {
  const page = await newPage(browser)
  await page.setContent(`
    <div data-template style="position:absolute;left:0;top:0;width:120px;height:20px">Transfer complete</div>
    <main><div role="alert">Transfer failed</div></main>`)
  expect(await verifyAll(page, [{ type: 'text_visible', text: 'Transfer complete' }])).toBe(true)
  await page.context().close()
})

it('fails closed when the only match is hidden (no false positive from display:none)', async () => {
  const page = await newPage(browser)
  await page.setContent('<div style="display:none">Transfer complete</div><div>Transfer failed</div>')
  expect(await verifyAll(page, [{ type: 'text_visible', text: 'Transfer complete' }])).toBe(false)
  await page.context().close()
})
