/**
 * BR-14 — snapshot ids are never cleared, so a scrolled-out element keeps an id
 * that the next snapshot hands to a different element.
 *
 * SNAPSHOT_SCRIPT only assigns `data-dsh-decision-id` to elements that are inside
 * the viewport (dom.ts:35-41, 94-97) and never removes older attributes. After a
 * scroll, the off-screen element still carries `e1`, and the first visible element
 * is renumbered to `e1` as well. The freshness check then validates the stale
 * node (document.querySelector returns the first match in DOM order) while the
 * dispatch resolves to two nodes and fails hard — an unclassified error the tool
 * cannot map, not a StaleSnapshot retry.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Browser } from 'playwright'
import { BrowserDom, StaleSnapshot } from '../../../packages/dsh-browser-use-d1/src/dom.ts'
import { launch, newPage } from './harness.ts'

let browser: Browser
beforeAll(async () => { browser = await launch() })
afterAll(async () => { await browser.close() })

it('produces duplicate ids after a scroll and throws a raw strict-mode error', async () => {
  const page = await newPage(browser)
  await page.setContent(`
    <button id="top" type="button">Top action</button>
    <div style="height:2200px"></div>
    <button id="bottom" type="button">Bottom action</button>`)
  const dom = new BrowserDom(page)

  const first = await dom.snapshot()
  const top = first.elements.find(element => element.name === 'Top action')!
  expect(top.id).toBe('e1')
  expect(first.elements.some(element => element.name === 'Bottom action')).toBe(false)

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  const second = await dom.snapshot()
  const bottom = second.elements.find(element => element.name === 'Bottom action')!
  // The bottom button is the only visible interactive element: it becomes e1,
  // while the scrolled-out top button still carries the e1 from the first snapshot.
  expect(bottom.id).toBe('e1')
  expect(await page.evaluate(() =>
    document.querySelectorAll('[data-dsh-decision-id="e1"]').length)).toBe(2)

  // The actionability check passes (it looks at the stale top button), then the
  // click resolves to both nodes and throws a Playwright strict-mode violation.
  let thrown: unknown
  try {
    await dom.execute(second, { operation: 'CLICK', target: bottom.id }, 1000)
  } catch (error) { thrown = error }
  expect(thrown).toBeInstanceOf(Error)
  expect(thrown).not.toBeInstanceOf(StaleSnapshot)
  expect((thrown as Error).message).toMatch(/strict mode violation/u)
  await page.context().close()
})
