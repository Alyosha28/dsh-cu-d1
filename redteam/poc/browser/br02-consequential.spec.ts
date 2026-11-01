/**
 * BR-02 — the D1 loop never classifies an action; approval is opt-in.
 *
 * `runBrowserSubgoal` asks for approval only when the *caller* declares
 * `policy.risk: 'consequential'` (controller.ts:225-243 + policy-approvals.ts:24-26).
 * The schema default is `reversible`, so a destructive click with default
 * arguments runs with zero approval. The same action with `risk: 'consequential'`
 * is gated — proving the gate exists but is never derived from what the action does.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Browser, Page } from 'playwright'
import { runBrowserSubgoal } from '../../../packages/dsh-browser-use-d1/src/controller.ts'
import type { D1DecisionClient } from '../../../packages/dsh-browser-use-d1/src/decision.ts'
import { launch, newPage, approvalSpy, config, execution } from './harness.ts'

let browser: Browser
let page: Page
beforeAll(async () => {
  browser = await launch()
  page = await newPage(browser)
})
afterAll(async () => { await browser.close() })

const PAGE = `
  <h1>Account settings</h1>
  <p>This action cannot be undone.</p>
  <button id="delete" type="button">Delete account</button>
  <div id="status" role="status">Account active</div>
  <script>
    window.__deleted = 0;
    document.getElementById('delete').addEventListener('click', () => {
      window.__deleted += 1;
      document.getElementById('status').textContent = 'Account deleted';
    });
  </script>`

function deleteClient() {
  return {
    calls: 0,
    async decide(_goal: string, observation: { elements: Array<{ id: string; name: string }> }) {
      this.calls += 1
      const target = observation.elements.find(element => element.name === 'Delete account')
      return {
        decision: { operation: 'CLICK', target: target?.id ?? null, confidence: 0.99 },
        usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, textExtractionCalls: 0,
      }
    },
  } as unknown as D1DecisionClient & { calls: number }
}

const ARGS = {
  goal: 'Delete the account permanently.',
  verify: [{ type: 'text_visible' as const, text: 'Account deleted' }],
}

it('performs a destructive click with the default policy and never asks for approval', async () => {
  await page.setContent(PAGE)
  const approvals = approvalSpy(true)
  const result = await runBrowserSubgoal(
    page, deleteClient(), config(), ARGS, new AbortController().signal,
    undefined, execution(), approvals as never,
  )
  expect(result).toMatchObject({ status: 'success', actionsExecuted: 1 })
  expect(await page.evaluate(() => (window as unknown as { __deleted: number }).__deleted)).toBe(1)
  expect(approvals.calls).toEqual([])
})

it('control: the same click with risk=consequential does ask for approval', async () => {
  await page.setContent(PAGE)
  const approvals = approvalSpy(true)
  const result = await runBrowserSubgoal(
    page, deleteClient(), config(), { ...ARGS, policy: { risk: 'consequential' } },
    new AbortController().signal, undefined, execution(), approvals as never,
  )
  expect(result.status).toBe('success')
  expect(approvals.calls).toHaveLength(1)
  expect(approvals.calls[0]!.detail).toContain('Delete account')
})

it('a payment form with card data also runs unapproved under the default policy', async () => {
  await page.setContent(`
    <h1>Checkout</h1>
    <label>Card number <input id="card" value=""></label>
    <button id="pay" type="button">Pay 499 EUR</button>
    <div id="done" role="status"></div>
    <script>
      window.__paid = null;
      document.getElementById('pay').addEventListener('click', () => {
        window.__paid = document.getElementById('card').value;
        document.getElementById('done').textContent = 'Payment sent';
      });
    </script>`)
  const approvals = approvalSpy(true)
  const client = {
    calls: 0,
    async decide(_goal: string, observation: { elements: Array<{ id: string; name: string; value: string | null }> }) {
      this.calls += 1
      const card = observation.elements.find(element => element.name === 'Card number')
      if (card !== undefined && card.value === '') {
        return {
          decision: { operation: 'TYPE_TEXT', target: card.id, text: '4111111111111111' },
          usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, textExtractionCalls: 0,
        }
      }
      const pay = observation.elements.find(element => element.name === 'Pay 499 EUR')
      return {
        decision: { operation: 'CLICK', target: pay?.id ?? null, confidence: 0.99 },
        usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, textExtractionCalls: 0,
      }
    },
  } as unknown as D1DecisionClient

  const result = await runBrowserSubgoal(
    page, client, config(), {
      goal: 'Buy the subscription with the saved card.',
      verify: [{ type: 'text_visible' as const, text: 'Payment sent' }],
    }, new AbortController().signal, undefined, execution(), approvals as never,
  )
  expect(result.status).toBe('success')
  expect(await page.evaluate(() => (window as unknown as { __paid: string | null }).__paid)).toBe('4111111111111111')
  expect(approvals.calls).toEqual([])
})
