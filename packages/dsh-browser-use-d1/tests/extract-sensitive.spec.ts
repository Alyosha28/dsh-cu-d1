/**
 * BR-16 — the read tools must not hand live secrets to the caller.
 *
 * `browser_extract` reads `inputValue()` for any element, so a password field, a
 * payment field and a hidden CSRF token come back verbatim with no approval.
 * Sensitive values are redacted by default and only released through a
 * provider-config opt-in or a one-field approval.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import { chromium } from 'playwright'
import type { Browser } from 'playwright'
import { Config } from '../src/config.ts'
import { runBrowserExtract } from '../src/extract.ts'
import { CHROME } from './fixtures.ts'

let browser: Browser
beforeAll(async () => {
  browser = await chromium.launch({ executablePath: CHROME, headless: true })
})
afterAll(async () => { await browser.close() })

const config = Config({ mode: 'launch', decisionToken: 'unused-token' })

const LOGGED_IN = `<!doctype html>
<title>Account</title>
<h1>Account</h1>
<label>Email <input id="email" value="ada@example.test"></label>
<label>Password <input id="pw" type="password" value="hunter2-correct-horse"></label>
<label>PIN <input id="pin" type="text" value="4821"></label>
<input type="hidden" name="csrf" value="csrf-token-9f13">
<input type="hidden" name="next" value="/account/42">
<form><input id="card" name="card number" value="4111111111111111" autocomplete="cc-number"></form>`

async function page() {
  const opened = await browser.newPage()
  await opened.setContent(LOGGED_IN)
  return opened
}

// Result keys are deliberately neutral: sensitivity must come from the element,
// never from the caller's field name.
const sensitiveFields = [
  { name: 'f0', locator: { kind: 'label', text: 'Password' } },
  { name: 'f1', locator: { kind: 'label', text: 'PIN' } },
  { name: 'f2', locator: { kind: 'css', selector: 'input[name="csrf"]' } },
  { name: 'f3', locator: { kind: 'css', selector: 'input[name="card number"]' } },
]

it('redacts sensitive field values by default and says why', async () => {
  const opened = await page()
  const result = await runBrowserExtract(opened, config, {
    fields: [...sensitiveFields, { name: 'email', locator: { kind: 'label', text: 'Email' } }],
  }, new AbortController().signal)
  expect(result.status).toBe('success')
  expect(result.data).toEqual({
    f0: '[redacted]', f1: '[redacted]', f2: '[redacted]', f3: '[redacted]',
    email: 'ada@example.test',
  })
  expect(JSON.stringify(result)).not.toContain('hunter2-correct-horse')
  expect(JSON.stringify(result)).not.toContain('csrf-token-9f13')
  expect(JSON.stringify(result)).not.toContain('4111111111111111')
  const reasons = Object.fromEntries(result.evidence.fields.map(field => [field.name, field.reason]))
  expect(reasons).toMatchObject({
    f0: 'sensitive_redacted', f1: 'sensitive_redacted',
    f2: 'sensitive_redacted', f3: 'sensitive_redacted',
  })
  expect(reasons.email).toBeUndefined()
  // Redaction is not a failure: the field was read, its value is withheld.
  expect(result.evidence.fields.filter(field => field.name !== 'email').every(field => field.ok)).toBe(true)
  await opened.close()
})

it('keeps a non-secret hidden input readable', async () => {
  const opened = await page()
  // Read alone on its own page: `context` (ancestor text) is part of the
  // sensitivity heuristic, so a sibling secret would legitimately taint it.
  await opened.setContent('<input type="hidden" name="next" value="/account/42">')
  const result = await runBrowserExtract(opened, config, {
    fields: [{ name: 'f4', locator: { kind: 'css', selector: 'input[name="next"]' } }],
  }, new AbortController().signal)
  expect(result).toMatchObject({ status: 'success', data: { f4: '/account/42' } })
  await opened.close()
})

it('a provider-config opt-in releases real values', async () => {
  const opened = await page()
  await opened.setContent('<label>Password <input id="pw" type="password" value="hunter2-correct-horse"></label>')
  const result = await runBrowserExtract(opened, { ...config, allowSensitiveRead: true } as never, {
    fields: [{ name: 'f0', locator: { kind: 'label', text: 'Password' } }],
  }, new AbortController().signal)
  expect(result).toMatchObject({ status: 'success', data: { f0: 'hunter2-correct-horse' } })
  await opened.close()
})

it('a tool argument can never opt itself in', async () => {
  const opened = await page()
  // `allowSensitiveRead` is provider configuration, not a tool parameter: the
  // strict input schema rejects it instead of silently honouring it.
  await expect(runBrowserExtract(opened, config, {
    fields: [{ name: 'f0', locator: { kind: 'label', text: 'Password' } }],
    allowSensitiveRead: true,
  }, new AbortController().signal)).rejects.toThrow()
  await opened.close()
})

it('one approval releases exactly the approved field, once', async () => {
  const opened = await page()
  const asked: string[] = []
  const approvals = {
    async request(_agent: unknown, request: { detail: string }) {
      asked.push(request.detail)
      return { approved: true }
    },
  }
  const agent = { id: 'extract-agent' } as never
  // Each field asks on its own; only the first may release (see below).
  let calls = 0
  const prompts: string[] = []
  const never = { async request() { return { approved: false, reason: 'denied_by_user' } } }
  const once = {
    async request(_agent: unknown, request: { detail: string }) {
      calls += 1
      prompts.push(request.detail)
      return calls === 1 ? { approved: true } : { approved: false, reason: 'denied_by_user' }
    },
  }
  const first = await runBrowserExtract(opened, config, {
    fields: [
      { name: 'f0', locator: { kind: 'label', text: 'Password' } },
      { name: 'f2', locator: { kind: 'css', selector: 'input[name="csrf"]' } },
    ],
  }, new AbortController().signal, undefined, once as never, agent)
  // One approval covers one field: the second secret stays redacted because it
  // was never approved, even though the same run released the first.
  expect(first.data).toEqual({ f0: 'hunter2-correct-horse', f2: '[redacted]' })
  expect(calls).toBe(2)
  // The prompt must identify the field and never contain the secret itself.
  expect(prompts[0]).toContain('label:Password')
  expect(prompts[0]).not.toContain('hunter2-correct-horse')
  expect(prompts[1]).toContain('csrf')

  // A second call asks again: an approval is not a standing grant.
  const second = await runBrowserExtract(opened, config, {
    fields: [{ name: 'f0', locator: { kind: 'label', text: 'Password' } }],
  }, new AbortController().signal, undefined, never as never, agent)
  expect(second).toMatchObject({ status: 'success', data: { f0: '[redacted]' } })
  await opened.close()
})

it('a denied approval falls back to the redacted value', async () => {
  const opened = await page()
  const approvals = { async request() { return { approved: false, reason: 'denied_by_user' } } }
  const result = await runBrowserExtract(opened, config, {
    fields: [{ name: 'f0', locator: { kind: 'label', text: 'Password' } }],
  }, new AbortController().signal, undefined, approvals as never, { id: 'a' } as never)
  expect(result).toMatchObject({ status: 'success', data: { f0: '[redacted]' } })
  expect(result.evidence.fields[0]).toMatchObject({ reason: 'sensitive_redacted' })
  await opened.close()
})

it('masks every match of an all:true sensitive field', async () => {
  const opened = await browser.newPage()
  await opened.setContent(`
    <div class="token" value="t1">token one</div>
    <input class="secret" type="password" value="one">
    <input class="secret" type="password" value="two">`)
  const result = await runBrowserExtract(opened, config, {
    fields: [{ name: 'secrets', all: true, locator: { kind: 'css', selector: 'input.secret' } }],
  }, new AbortController().signal)
  expect(result).toMatchObject({ status: 'success', data: { secrets: ['[redacted]', '[redacted]'] } })
  expect(JSON.stringify(result)).not.toContain('"one"')
  expect(JSON.stringify(result)).not.toContain('"two"')
  await opened.close()
})
