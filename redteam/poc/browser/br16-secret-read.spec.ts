/**
 * BR-16 — the read tools return live secret values.
 *
 * SNAPSHOT_SCRIPT (dom.ts:100-102) copies `el.value` for every input, including
 * `type=password`, into the observation that `browser_observe` returns to the
 * model and that `d1_browser_subgoal` posts to the decision service.
 * `browser_extract` reads `inputValue()` for any element, so it returns the
 * password and any hidden token verbatim. Neither tool has an approval path and
 * neither is covered by the subgoal policy (`credentialsAvailable` is only
 * consulted by checkPagePolicy inside a subgoal).
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Browser } from 'playwright'
import { runBrowserObserve } from '../../../packages/dsh-browser-use-d1/src/controller.ts'
import { runBrowserExtract } from '../../../packages/dsh-browser-use-d1/src/extract.ts'
import { config, launch, newPage } from './harness.ts'

let browser: Browser
beforeAll(async () => { browser = await launch() })
afterAll(async () => { await browser.close() })

const LOGGED_IN = `
  <h1>Account</h1>
  <label>Password <input id="pw" type="password" value="hunter2-correct-horse"></label>
  <input type="hidden" name="csrf" value="csrf-token-9f13">
  <form><input name="card" value="4111111111111111"></form>`

it('browser_observe returns the password field value in the observation', async () => {
  const page = await newPage(browser)
  await page.setContent(LOGGED_IN)
  const result = await runBrowserObserve(page)
  expect(result.status).toBe('success')
  const password = result.observation!.elements.find(element => element.inputType === 'password')
  expect(password?.value).toBe('hunter2-correct-horse')
  await page.context().close()
})

it('browser_extract reads the password value and a hidden CSRF token', async () => {
  const page = await newPage(browser)
  await page.setContent(LOGGED_IN)
  const result = await runBrowserExtract(page, config(), {
    fields: [
      { name: 'password', type: 'string', locator: { kind: 'label', text: 'Password' } },
      { name: 'csrf', type: 'string', locator: { kind: 'css', selector: 'input[name="csrf"]' } },
      { name: 'card', type: 'string', locator: { kind: 'css', selector: 'input[name="card"]' } },
    ],
  }, new AbortController().signal)
  expect(result.status).toBe('success')
  expect(result.data).toEqual({
    password: 'hunter2-correct-horse',
    csrf: 'csrf-token-9f13',
    card: '4111111111111111',
  })
  await page.context().close()
})

it('the credentialsAvailable policy does not reach either read tool', async () => {
  const page = await newPage(browser)
  await page.setContent(LOGGED_IN)
  // No argument exists on observe/extract to express "no credentials here".
  const observation = await runBrowserObserve(page)
  expect(JSON.stringify(observation.observation)).toContain('hunter2-correct-horse')
  await page.context().close()
})
