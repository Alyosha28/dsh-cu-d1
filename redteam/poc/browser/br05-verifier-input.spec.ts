/**
 * BR-05 — `input_value` / `checkbox` verification resolve by accessible label
 * and never check visibility, so a decoy the run never touched satisfies the
 * assertion.
 *
 * dom.ts:210-212 `page.getByLabel(label, { exact: true }).inputValue()` /
 * `.isChecked()`. The locator is global: it is not tied to the element the run
 * typed into, and a hidden element with the same `aria-label` is a valid match.
 * A page (or an SSR/autofill mirror) that ships a hidden `aria-label="Email"`
 * input with the expected value makes an empty visible field verify as filled.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Browser } from 'playwright'
import { verifyAll } from '../../../packages/dsh-browser-use-d1/src/dom.ts'
import { launch, newPage } from './harness.ts'

let browser: Browser
beforeAll(async () => { browser = await launch() })
afterAll(async () => { await browser.close() })

it('a hidden labelled decoy satisfies input_value while the real field is empty', async () => {
  const page = await newPage(browser)
  await page.setContent(`
    <h1>Transfer</h1>
    <div>Recipient email</div>
    <input id="recipient" type="email" placeholder="name@example.com">
    <input id="mirror" type="hidden" aria-label="Recipient email" value="attacker@evil.test">`)
  // The run typed nothing; the visible field the user sees is empty.
  expect(await page.locator('#recipient').inputValue()).toBe('')
  expect(await verifyAll(page, [{ type: 'input_value', label: 'Recipient email', value: 'attacker@evil.test' }]))
    .toBe(true)
  await page.context().close()
})

it('an off-screen labelled decoy does the same for a visible field without a <label>', async () => {
  const page = await newPage(browser)
  // The real control is labelled by adjacent text + placeholder, which
  // getByLabel does not resolve: only the decoy answers the assertion.
  await page.setContent(`
    <div>Amount</div>
    <input id="amount" value="" placeholder="0.00">
    <input aria-label="Amount" value="10.00"
           style="position:absolute;left:-4000px;top:0;width:10px;height:10px">`)
  expect(await page.locator('#amount').inputValue()).toBe('')
  expect(await verifyAll(page, [{ type: 'input_value', label: 'Amount', value: '10.00' }])).toBe(true)
  await page.context().close()
})

it('a hidden checked decoy satisfies checkbox while the visible box is unchecked', async () => {
  const page = await newPage(browser)
  await page.setContent(`
    <input id="agree" type="checkbox"><span>I accept the terms</span>
    <input type="checkbox" aria-label="I accept the terms" checked hidden>`)
  expect(await page.locator('#agree').isChecked()).toBe(false)
  expect(await verifyAll(page, [{ type: 'checkbox', label: 'I accept the terms', checked: true }])).toBe(true)
  await page.context().close()
})
