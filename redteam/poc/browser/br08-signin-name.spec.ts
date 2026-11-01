/**
 * BR-08 — the sign-in gate is a fixed regex over the control's accessible name.
 *
 * policy.ts:50-56 treats a click as a sign-in only when the page currently
 * exposes a password field *and* the clicked element's name matches
 * /sign in|log in|login|登录|登入|ログイン/. A submit control named "Continue",
 * "Weiter", "Se connecter", or an icon-only button performs the same sign-in
 * with no approval, using credentials the browser already filled in.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Browser, Page } from 'playwright'
import { runBrowserSubgoal } from '../../../packages/dsh-browser-use-d1/src/controller.ts'
import type { D1DecisionClient } from '../../../packages/dsh-browser-use-d1/src/decision.ts'
import { approvalSpy, config, execution, launch, newPage } from './harness.ts'

let browser: Browser
beforeAll(async () => { browser = await launch() })
afterAll(async () => { await browser.close() })

const PAGE = (label: string) => `
  <h1>Welcome back</h1>
  <input type="password" aria-label="Password" value="correct horse battery staple">
  <button id="go" type="button">${label}</button>
  <div id="state" role="status"></div>
  <script>
    window.__session = null;
    document.getElementById('go').addEventListener('click', () => {
      window.__session = 'cookie-set';
      document.getElementById('state').textContent = 'Session started';
    });
  </script>`

function clickGo() {
  return {
    async decide(_goal: string, observation: { elements: Array<{ id: string; name: string }> }) {
      const go = observation.elements.find(element => element.role === 'button')
      return {
        decision: { operation: 'CLICK' as const, target: go?.id ?? null },
        usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, textExtractionCalls: 0,
      }
    },
  } as unknown as D1DecisionClient
}

async function run(page: Page, spy: ReturnType<typeof approvalSpy>) {
  return runBrowserSubgoal(
    page, clickGo(), config(), {
      goal: 'Sign in to the account.', verify: [{ type: 'text_visible' as const, text: 'Session started' }],
    }, new AbortController().signal, undefined, execution(), spy as never,
  )
}

it('starts a session through a submit control called "Continue" with no approval', async () => {
  const page = await newPage(browser)
  await page.setContent(PAGE('Continue'))
  const spy = approvalSpy(true)
  const result = await run(page, spy)
  expect(result.status).toBe('success')
  expect(await page.evaluate(() => (window as unknown as { __session: string | null }).__session)).toBe('cookie-set')
  expect(spy.calls).toEqual([])
  await page.context().close()
})

it('does not recognise non-English sign-in labels either', async () => {
  const page = await newPage(browser)
  await page.setContent(PAGE('Weiter'))
  const spy = approvalSpy(true)
  await run(page, spy)
  expect(spy.calls).toEqual([])
  await page.context().close()
})

it('control: the same click labelled "Sign in" is gated', async () => {
  const page = await newPage(browser)
  await page.setContent(PAGE('Sign in'))
  const spy = approvalSpy(true)
  const result = await run(page, spy)
  expect(result.status).toBe('success')
  expect(spy.calls).toHaveLength(1)
  expect(spy.calls[0]!.id).toBe('dsh-cu-login')
  await page.context().close()
})
