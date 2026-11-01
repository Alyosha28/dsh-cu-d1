/**
 * BR-01 — snapshot freshness is enforced with page-controlled state.
 *
 * The provider observes childList+characterData but not attributes, and keeps
 * the version counter and the "observer installed" flag on `window`. A page can
 * therefore (a) move `data-dsh-decision-id` after the snapshot, or (b) declare
 * the observer already installed so the counter is frozen at 0. In both cases
 * `BrowserDom.execute()` dispatches the click on an element the snapshot never
 * contained.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Browser } from 'playwright'
import { BrowserDom, StaleSnapshot } from '../../../packages/dsh-browser-use-d1/src/dom.ts'
import { launch, newPage } from './harness.ts'

let browser: Browser
beforeAll(async () => { browser = await launch() })
afterAll(async () => { await browser.close() })

const TRAP = `
  <button id="real" type="button">Pay invoice</button>
  <button id="trap" type="button" style="position:absolute;top:160px;left:0">Delete everything</button>
  <script>
    window.__clicked = [];
    for (const id of ['real', 'trap']) {
      document.getElementById(id).addEventListener('click', () => window.__clicked.push(id));
    }
  </script>`

it('clicks the attacker element after the page re-points data-dsh-decision-id', async () => {
  const page = await newPage(browser)
  await page.setContent(TRAP)
  const dom = new BrowserDom(page)
  const snapshot = await dom.snapshot()
  const real = snapshot.elements.find(element => element.name === 'Pay invoice')!
  expect(real.id).toBe('e1')

  // Page script: steal the id off the approved control and give it to the trap.
  // Attribute writes are invisible to the MutationObserver configured in dom.ts.
  await page.evaluate((id) => {
    document.getElementById('real')!.removeAttribute('data-dsh-decision-id')
    document.getElementById('trap')!.setAttribute('data-dsh-decision-id', id)
  }, real.id)

  await dom.execute(snapshot, { operation: 'CLICK', target: real.id }, 1000)

  expect(await page.evaluate(() => (window as unknown as { __clicked: string[] }).__clicked))
    .toEqual(['trap'])
  await page.context().close()
})

it('freezes the version counter so arbitrary DOM substitution is accepted', async () => {
  const page = await newPage(browser)
  await page.setContent(TRAP)
  // One script tag at document start is enough: the snapshot script returns
  // immediately and never installs the observer.
  await page.evaluate(() => {
    ;(window as unknown as { __dshDecisionObserver: boolean }).__dshDecisionObserver = true
  })
  const dom = new BrowserDom(page)
  const snapshot = await dom.snapshot()
  expect(snapshot.version).toBe(0)
  const real = snapshot.elements.find(element => element.name === 'Pay invoice')!

  // Replace the approved control with a different one that carries the same id
  // and a new handler. childList + attributes changed, the counter did not.
  await page.evaluate((id) => {
    const replacement = document.createElement('button')
    replacement.id = 'substituted'
    replacement.textContent = 'Approve 5000 EUR'
    replacement.setAttribute('data-dsh-decision-id', id)
    replacement.addEventListener('click', () => {
      ;(window as unknown as { __substituted: number }).__substituted =
        ((window as unknown as { __substituted?: number }).__substituted ?? 0) + 1
    })
    document.getElementById('real')!.replaceWith(replacement)
  }, real.id)

  // Would throw StaleSnapshot('dom_changed') with a working observer.
  await dom.execute(snapshot, { operation: 'CLICK', target: real.id }, 1000)
  expect(await page.evaluate(() => (window as unknown as { __substituted?: number }).__substituted)).toBe(1)
  await page.context().close()
})

it('control: with the observer intact the same mutation is rejected as stale', async () => {
  const page = await newPage(browser)
  await page.setContent(TRAP)
  const dom = new BrowserDom(page)
  const snapshot = await dom.snapshot()
  const real = snapshot.elements.find(element => element.name === 'Pay invoice')!
  await page.evaluate(() => { document.body.appendChild(document.createElement('div')) })
  await expect(dom.execute(snapshot, { operation: 'CLICK', target: real.id }, 1000))
    .rejects.toBeInstanceOf(StaleSnapshot)
  await page.context().close()
})
