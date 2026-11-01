/**
 * Boundary probes — things that look exploitable but hold.
 *
 * Recorded so the blue team does not "fix" behaviour that is already correct.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Browser } from 'playwright'
import { assertSkillOrigin, type VerifiedSkill } from '@albaincompleta/dsh-cu-core/skills'
import { runBrowserSubgoal } from '../../../packages/dsh-browser-use-d1/src/controller.ts'
import type { D1DecisionClient } from '../../../packages/dsh-browser-use-d1/src/decision.ts'
import { sanitizeDownloadName } from '../../../packages/dsh-browser-use-d1/src/downloads.ts'
import { BrowserDom, verifyAll } from '../../../packages/dsh-browser-use-d1/src/dom.ts'
import { config, execution, launch, newPage } from './harness.ts'

let browser: Browser
beforeAll(async () => { browser = await launch() })
afterAll(async () => { await browser.close() })

const skill: VerifiedSkill = {
  id: 'boundary.origin', version: 1, verifiedAt: '2026-01-01',
  match: { urlPath: '/account', origin: 'https://example.test' },
  fallback: 'human', risk: 'reversible',
  verify: [{ type: 'text_visible', text: 'ok' }],
  steps: [{ type: 'click', target: 'Continue' }],
}

it('B1: a decision target cannot smuggle a CSS selector, because it must be a snapshot id', async () => {
  const page = await newPage(browser)
  await page.setContent('<button type="button">Continue</button>')
  const client = {
    async decide() {
      return {
        // The target is interpolated into `[data-dsh-decision-id="${target}"]` in
        // dom.ts:188, but validateDecision rejects anything that is not an
        // observed element id before execute() is reached.
        decision: { operation: 'CLICK' as const, target: 'e1"] , body' },
        usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, textExtractionCalls: 0,
      }
    },
  } as unknown as D1DecisionClient
  await expect(runBrowserSubgoal(page, client, config(), {
    goal: 'Continue', verify: [{ type: 'text_visible', text: 'ok' }],
  }, new AbortController().signal, undefined, execution())).rejects.toThrow(/is not valid for CLICK/u)
  await page.context().close()
})

it('B2: Skill origin matching resists host case, default ports and look-alike hosts', () => {
  const code = (url: string): string => {
    try { assertSkillOrigin(skill, url); return 'ok' } catch (error) { return (error as { code?: string }).code ?? 'unknown' }
  }
  expect(code('https://EXAMPLE.test/account')).toBe('ok')
  expect(code('https://example.test:443/account')).toBe('ok')
  expect(code('https://example.test./account')).toBe('skill_origin_mismatch')
  expect(code('https://example.test.evil/account')).toBe('skill_origin_mismatch')
  expect(code('http://example.test/account')).toBe('skill_origin_mismatch')
})

it('B3: duplicate labels make verification fail closed instead of reading the wrong field', async () => {
  const page = await newPage(browser)
  await page.setContent(`
    <label>Email <input id="a" value="one@example.test"></label>
    <label>Email <input id="b" value="two@example.test"></label>`)
  expect(await verifyAll(page, [{ type: 'input_value', label: 'Email', value: 'one@example.test' }]))
    .toBe(false)
  await page.context().close()
})

it('B4: an assertion the provider cannot evaluate is never reported as satisfied', async () => {
  const page = await newPage(browser)
  await page.setContent('<h1>Done</h1>')
  expect(await verifyAll(page, [{ type: 'custom', name: 'workflow_state' }])).toBe(false)
  await page.context().close()
})

it('B5: download file names cannot escape the download directory', () => {
  for (const suggestion of ['../../etc/passwd', '..\\..\\windows\\system32', '..', '.', '\u0000evil']) {
    const name = sanitizeDownloadName(suggestion)
    expect(name).not.toContain('/')
    expect(name).not.toContain('\\')
    expect(name.length).toBeGreaterThan(0)
    expect(['.', '..']).not.toContain(name)
  }
  expect(sanitizeDownloadName('../../etc/passwd')).toBe('passwd')
})

it('B6: shadow-DOM and iframe controls are outside the observation and never get an id', async () => {
  const page = await newPage(browser)
  await page.setContent(`
    <div id="host"></div>
    <iframe srcdoc="<button id='inner'>Frame action</button>"></iframe>
    <button id="light">Light action</button>
    <script>
      document.getElementById('host').attachShadow({ mode: 'open' })
        .innerHTML = '<button id="shadow">Shadow action</button>';
    </script>`)
  await page.waitForTimeout(150)
  const snapshot = await new BrowserDom(page).snapshot()
  expect(snapshot.elements.map(element => element.name)).toEqual(['Light action'])
  expect(await page.evaluate(() =>
    document.getElementById('host')!.shadowRoot!.querySelector('[data-dsh-decision-id]') !== null)).toBe(false)
  expect(await page.evaluate(() => {
    const frame = document.querySelector('iframe') as HTMLIFrameElement
    return frame.contentDocument!.querySelector('[data-dsh-decision-id]') !== null
  })).toBe(false)
  await page.context().close()
})
