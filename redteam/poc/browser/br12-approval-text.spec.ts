/**
 * BR-12 — the approval prompt is composed from page-authored strings.
 *
 * policy-approvals.ts:15-22 builds the approval `target` from `element.name`
 * (DOM text/aria-label, up to 300 chars) and the `scope` from `document.title`.
 * A page therefore writes the exact words of the consent dialog it is asking the
 * human to approve: a button whose accessible name is "Open read-only preview"
 * can run a destructive handler, and the prompt never mentions what it does.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Browser } from 'playwright'
import { runBrowserSubgoal } from '../../../packages/dsh-browser-use-d1/src/controller.ts'
import type { D1DecisionClient } from '../../../packages/dsh-browser-use-d1/src/decision.ts'
import { approvalSpy, config, execution, launch, newPage } from './harness.ts'

let browser: Browser
beforeAll(async () => { browser = await launch() })
afterAll(async () => { await browser.close() })

it('shows the page-written label in the consent dialog while the page deletes data', async () => {
  const page = await newPage(browser)
  await page.setContent(`
    <title>Settings · read-only preview</title>
    <h1>Settings</h1>
    <button id="danger" type="button" aria-label="Open read-only preview">Delete account</button>
    <div id="state" role="status"></div>
    <script>
      window.__wiped = 0;
      document.getElementById('danger').addEventListener('click', () => {
        window.__wiped = 1;
        document.getElementById('state').textContent = 'Account deleted';
      });
    </script>`)

  const client = {
    async decide(_goal: string, observation: { elements: Array<{ id: string; name: string; role: string }> }) {
      const button = observation.elements.find(element => element.role === 'button')
      return {
        decision: { operation: 'CLICK' as const, target: button?.id ?? null },
        usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, textExtractionCalls: 0,
      }
    },
  } as unknown as D1DecisionClient

  const spy = approvalSpy(true)
  const result = await runBrowserSubgoal(
    page, client, config(), {
      goal: 'Delete the account.', policy: { risk: 'consequential' },
      verify: [{ type: 'text_visible' as const, text: 'Account deleted' }],
    }, new AbortController().signal, undefined, execution(), spy as never,
  )

  expect(result.status).toBe('success')
  expect(await page.evaluate(() => (window as unknown as { __wiped: number }).__wiped)).toBe(1)
  expect(spy.calls).toHaveLength(1)
  const detail = spy.calls[0]!.detail
  // The human approved "Open read-only preview" on a page titled "read-only preview".
  expect(detail).toContain('Open read-only preview')
  expect(detail).toContain('read-only preview')
  expect(detail).not.toContain('Delete')
  console.log('[BR-12] approval detail shown to the human:', detail)
  await page.context().close()
})

it('an unnamed control makes the same prompt useless instead of dangerous', async () => {
  const page = await newPage(browser)
  await page.setContent(`
    <title>Dashboard</title>
    <button id="icon" type="button" aria-hidden="true"><svg width="10" height="10"></svg></button>
    <div id="state" role="status"></div>
    <script>
      document.getElementById('icon').addEventListener('click', () => {
        document.getElementById('state').textContent = 'Row deleted';
      });
    </script>`)
  const client = {
    async decide(_goal: string, observation: { elements: Array<{ id: string; name: string }> }) {
      const button = observation.elements.find(element => element.role === 'button')
      return {
        decision: { operation: 'CLICK' as const, target: button?.id ?? null },
        usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, textExtractionCalls: 0,
      }
    },
  } as unknown as D1DecisionClient
  const spy = approvalSpy(true)
  await runBrowserSubgoal(
    page, client, config(), {
      goal: 'Delete the row.', policy: { risk: 'consequential' },
      verify: [{ type: 'text_visible' as const, text: 'Row deleted' }],
    }, new AbortController().signal, undefined, execution(), spy as never,
  )
  expect(spy.calls[0]!.detail).toMatch(/\be\d+\b/u)
  console.log('[BR-12] approval detail for an icon-only control:', spy.calls[0]!.detail)
  await page.context().close()
})
