/**
 * BR-07 — credential gating only recognises `input[type=password]`.
 *
 * policy.ts:25 / 44-47 look at `inputType === 'password'` from the snapshot.
 * A secret field rendered as `type=text` with `-webkit-text-security: disc`
 * (the standard way to build PIN / OTP / SSN inputs) is an ordinary textbox:
 * `credentialsAvailable: false` does not block the page, and typing the secret
 * never asks for the login approval that the identical `type=password` field
 * requires.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Browser, Page } from 'playwright'
import { runBrowserSubgoal } from '../../../packages/dsh-browser-use-d1/src/controller.ts'
import type { D1DecisionClient } from '../../../packages/dsh-browser-use-d1/src/decision.ts'
import { approvalSpy, config, execution, launch, newPage } from './harness.ts'

let browser: Browser
beforeAll(async () => { browser = await launch() })
afterAll(async () => { await browser.close() })

const PIN_PAGE = (type: string) => `
  <h1>Confirm your identity</h1>
  <div>Card PIN</div>
  <input id="pin" type="${type}" aria-label="Card PIN" style="-webkit-text-security: disc" autocomplete="off">
  <button id="submit" type="button">Continue</button>
  <div id="done" role="status"></div>
  <script>
    window.__submitted = null;
    document.getElementById('submit').addEventListener('click', () => {
      window.__submitted = document.getElementById('pin').value;
      document.getElementById('done').textContent = 'Identity confirmed';
    });
  </script>`

function pinClient() {
  return {
    async decide(_goal: string, observation: { elements: Array<{ id: string; name: string; value: string | null }> }) {
      const pin = observation.elements.find(element => element.name === 'Card PIN')
      if (pin !== undefined && pin.value === '') {
        return {
          decision: { operation: 'TYPE_TEXT' as const, target: pin.id, text: '4821' },
          usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, textExtractionCalls: 0,
        }
      }
      const submit = observation.elements.find(element => element.name === 'Continue')
      return {
        decision: { operation: 'CLICK' as const, target: submit?.id ?? null },
        usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, textExtractionCalls: 0,
      }
    },
  } as unknown as D1DecisionClient
}

async function run(page: Page, policy: Record<string, unknown> | undefined, spy: ReturnType<typeof approvalSpy>) {
  return runBrowserSubgoal(
    page, pinClient(), config(), {
      goal: 'Confirm the identity with the card PIN.',
      verify: [{ type: 'text_visible' as const, text: 'Identity confirmed' }],
      ...policy === undefined ? {} : { policy },
    }, new AbortController().signal, undefined, execution(), spy as never,
  )
}

it('types and submits a masked text field with credentialsAvailable:false', async () => {
  const page = await newPage(browser)
  await page.setContent(PIN_PAGE('text'))
  const spy = approvalSpy(true)
  const result = await run(page, { credentialsAvailable: false }, spy)
  expect(result).toMatchObject({ status: 'success', actionsExecuted: 2 })
  expect(await page.evaluate(() => (window as unknown as { __submitted: string | null }).__submitted)).toBe('4821')
  expect(spy.calls).toEqual([])
  await page.context().close()
})

it('control: the same page with type=password blocks on credentialsAvailable:false', async () => {
  const page = await newPage(browser)
  await page.setContent(PIN_PAGE('password'))
  const spy = approvalSpy(true)
  const result = await run(page, { credentialsAvailable: false }, spy)
  expect(result).toMatchObject({ status: 'blocked', reason: 'credentials_unavailable', actionsExecuted: 0 })
  expect(spy.calls).toEqual([])
  await page.context().close()
})

it('control: the same page with type=password asks for login approval', async () => {
  const page = await newPage(browser)
  await page.setContent(PIN_PAGE('password'))
  const spy = approvalSpy(true)
  const result = await run(page, undefined, spy)
  expect(result.status).toBe('success')
  expect(spy.calls).toHaveLength(1)
  expect(spy.calls[0]!.id).toBe('dsh-cu-login')
  await page.context().close()
})
