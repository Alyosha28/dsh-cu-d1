/**
 * BR-11 — controls with no accessible name opt out of the ambiguity gate.
 *
 * policy.ts:64-65 returns null as soon as `normalized(target.name) === ''`, and
 * SNAPSHOT_SCRIPT produces '' for every icon-only or aria-hidden control (see
 * BR-07's unlabeled input). Repeated icon buttons — the classic delete/edit
 * column in a table — are therefore never reported as `ambiguous_target`, and the
 * same '' name is what the approval prompt would have to describe.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Browser } from 'playwright'
import { BrowserDom } from '../../../packages/dsh-browser-use-d1/src/dom.ts'
import { checkTargetAmbiguity } from '../../../packages/dsh-browser-use-d1/src/policy.ts'
import { launch, newPage } from './harness.ts'

let browser: Browser
beforeAll(async () => { browser = await launch() })
afterAll(async () => { await browser.close() })

it('two identical icon buttons snapshot as unnamed and pass the ambiguity gate', async () => {
  const page = await newPage(browser)
  await page.setContent(`
    <table><tbody>
      <tr><td>Invoice 1</td><td><button type="button" aria-hidden="true"><svg width="12" height="12"></svg></button></td></tr>
      <tr><td>Invoice 2</td><td><button type="button" aria-hidden="true"><svg width="12" height="12"></svg></button></td></tr>
    </tbody></table>`)
  const dom = new BrowserDom(page)
  const snapshot = await dom.snapshot()
  const buttons = snapshot.elements.filter(element => element.role === 'button')
  expect(buttons).toHaveLength(2)
  expect(buttons.map(button => button.name)).toEqual(['', ''])
  expect(checkTargetAmbiguity(snapshot, { operation: 'CLICK', target: buttons[1]!.id }, 'Delete invoice 1'))
    .toBeNull()
  await page.context().close()
})

it('control: the same duplication with a name is reported as ambiguous', async () => {
  const page = await newPage(browser)
  await page.setContent(`
    <section><h2>Invoices</h2><button type="button">Delete</button><button type="button">Delete</button></section>`)
  const dom = new BrowserDom(page)
  const snapshot = await dom.snapshot()
  const buttons = snapshot.elements.filter(element => element.role === 'button')
  expect(buttons.every(button => button.name === 'Delete')).toBe(true)
  expect(checkTargetAmbiguity(snapshot, { operation: 'CLICK', target: buttons[0]!.id }, 'Delete invoice 1')?.reason)
    .toBe('ambiguous_target')
  await page.context().close()
})
