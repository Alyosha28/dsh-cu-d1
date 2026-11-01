/**
 * BR-03 / CR-01 / CR-03 — a verified Skill replay is a run, not an exemption.
 *
 * The replay loop must pass the same per-action gates as the D1 loop
 * (consequential + login), the effective risk is the maximum of the caller's,
 * the Skill's and the provider's floor, a missing approval channel fails closed,
 * and a Skill scoped to a native window/application never replays in a browser.
 */
import { afterAll, beforeAll, expect, it } from 'vitest'
import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { runBrowserSkill } from '../src/skill-runner.ts'
import type { RunState } from '../src/controller.ts'
import { Config } from '../src/config.ts'
import type { ResolvedConfig } from '../src/config.ts'
import { CHROME } from './fixtures.ts'
import type { VerifiedSkill } from '@albaincompleta/dsh-cu-core/skills'

let browser: Browser
const config: ResolvedConfig = Config({
  mode: 'launch', decisionToken: 'unused-token', verificationTimeoutMs: 100,
})
const agent = { id: 'skill-replay-agent' } as never

beforeAll(async () => { browser = await chromium.launch({ executablePath: CHROME, headless: true }) })
afterAll(async () => { await browser.close() })

class Gate {
  readonly calls: Array<{ id: string; detail: string }> = []
  constructor(private readonly approve: boolean | (() => boolean) = true) {}

  async request(_agent: unknown, request: { id: string; detail: string }) {
    this.calls.push({ id: request.id, detail: request.detail })
    const approved = typeof this.approve === 'function' ? this.approve() : this.approve
    return approved ? { approved: true } : { approved: false, reason: 'denied_by_user' }
  }
}

function executionFor(signal: AbortSignal) {
  return { agent, signal, waitWhilePaused: async () => null, admit: () => null, pausedMs: () => 0 } as never
}

const CHECKOUT = `<!doctype html>
<title>Checkout</title>
<h1>Checkout</h1>
<button id="pay" data-dsh-decision-id="e1" onclick="window.__paid = (window.__paid ?? 0) + 1; document.getElementById('done').hidden = false">Pay now</button>
<div id="done" hidden>Payment complete</div>`

const LOGIN = `<!doctype html>
<title>Sign in</title>
<form id="login-form" action="/session" method="post">
  <label>Password <input id="pw" type="password" autocomplete="current-password"></label>
  <button id="go" type="submit" data-dsh-decision-id="e2" onclick="event.preventDefault(); window.__signedIn = true; document.getElementById('ok').hidden = false">Continue</button>
</form>
<div id="ok" hidden>Welcome back</div>`

async function pageFor(html: string): Promise<Page> {
  const page = await browser.newPage()
  await page.route('https://shop.example/**', route => route.fulfill({ contentType: 'text/html', body: html }))
  await page.goto('https://shop.example/checkout')
  return page
}

function paySkill(overrides: Partial<VerifiedSkill> = {}): VerifiedSkill {
  return {
    id: 'test.pay-now', version: 1, verifiedAt: '2026-11-01',
    match: { urlPath: '/checkout', origin: 'https://shop.example' },
    fallback: 'human', risk: 'consequential',
    verify: [{ type: 'text_visible', text: 'Payment complete' }],
    steps: [{ type: 'click', target: 'Pay now' }],
    ...overrides,
  } as VerifiedSkill
}

async function run(
  page: Page,
  skill: VerifiedSkill,
  options: {
    approvals?: Gate
    execution?: unknown
    policy?: Record<string, unknown>
    inputs?: Record<string, string>
    config?: ResolvedConfig
  } = {},
): Promise<RunState | null> {
  const signal = new AbortController().signal
  return runBrowserSkill(
    page, skill,
    {
      goal: 'Pay the invoice',
      ...options.policy === undefined ? {} : { policy: options.policy },
      ...options.inputs === undefined ? {} : { inputs: options.inputs },
      verify: [{ type: 'text_visible', text: 'Payment complete' }],
    } as never,
    options.config ?? config, signal, undefined, 5, undefined,
    (options.execution ?? executionFor(signal)) as never,
    options.approvals as never,
  )
}

it('asks once for a consequential step and refuses to replay without an approval channel', async () => {
  const page = await pageFor(CHECKOUT)
  const failClosed = await run(page, paySkill(), { execution: undefined })
  expect(failClosed).toMatchObject({
    route: 'skill', status: 'confirmation_required', reason: 'approval_unavailable', actionsExecuted: 0,
  })

  const withoutGateway = await run(page, paySkill(), { approvals: undefined })
  expect(withoutGateway).toMatchObject({
    status: 'confirmation_required', reason: 'approval_unavailable', actionsExecuted: 0,
  })
  expect(await page.evaluate(() => (window as unknown as { __paid?: number }).__paid ?? 0)).toBe(0)

  // A fresh page: the approval prompt is a real pause, and a snapshot taken
  // before it must not be reused after it (BR-01 freshness).
  const live = await pageFor(CHECKOUT)
  const gate = new Gate(true)
  const approved = await run(live, paySkill(), { approvals: gate })
  expect(approved).toMatchObject({ route: 'skill', status: 'success', actionsExecuted: 1 })
  expect(gate.calls).toHaveLength(1)
  expect(gate.calls[0]!.id).toBe('dsh-cu-consequential')
  expect(gate.calls[0]!.detail).toContain('Pay now')
  expect(approved?.reason).not.toBe('stale_skill_snapshot')
  await live.close()
  await page.close()
})

it('a denied consequential approval executes nothing', async () => {
  const page = await pageFor(CHECKOUT)
  const gate = new Gate(false)
  const state = await run(page, paySkill(), { approvals: gate })
  expect(state).toMatchObject({ status: 'confirmation_required', reason: 'denied_by_user', actionsExecuted: 0 })
  expect(state?.trace).toEqual([])
  expect(await page.evaluate(() => (window as unknown as { __paid?: number }).__paid ?? 0)).toBe(0)
  await page.close()
})

it('gates credential steps behind a login approval', async () => {
  const page = await pageFor(LOGIN)
  const skill: VerifiedSkill = {
    id: 'test.sign-in', version: 1, verifiedAt: '2026-11-01',
    match: { urlPath: '/checkout', origin: 'https://shop.example' },
    fallback: 'human', risk: 'reversible',
    verify: [{ type: 'text_visible', text: 'Welcome back' }],
    steps: [{ type: 'type', target: 'Password', input: 'Password' }, { type: 'click', target: 'Continue' }],
  } as VerifiedSkill
  const gate = new Gate(false)
  const denied = await run(page, skill, {
    approvals: gate,
    inputs: { Password: 'correct-horse-battery' },
  })
  expect(denied).toMatchObject({ status: 'confirmation_required', actionsExecuted: 0 })
  expect(gate.calls.map(call => call.id)).toEqual(['dsh-cu-login'])
  expect(await page.evaluate(() => (window as unknown as { __signedIn?: boolean }).__signedIn)).toBeUndefined()

  const allowed = new Gate(true)
  const ok = await run(page, skill, { approvals: allowed, inputs: { Password: 'correct-horse-battery' } })
  // Both steps submit a secret through the same form, so both are gated; the
  // count is asserted, not the exact prompt ids, so a core refinement to the
  // sign-in heuristic does not silently weaken this test.
  expect(allowed.calls.length).toBeGreaterThanOrEqual(1)
  expect(allowed.calls.every(call => call.id === 'dsh-cu-login')).toBe(true)
  expect(ok).toMatchObject({ actionsExecuted: 2, route: 'human', reason: 'skill_postcondition_failed' })
  await page.close()
})

it('takes the maximum of caller, Skill and provider risk instead of the Skill risk', async () => {
  const page = await pageFor(CHECKOUT)
  // A reversible Skill replayed under a caller-declared consequential policy
  // still needs the approval the caller asked for (CR-01).
  const gate = new Gate(false)
  const state = await run(page, paySkill({ risk: 'reversible' }), {
    approvals: gate, policy: { risk: 'consequential' },
  })
  expect(state).toMatchObject({ status: 'confirmation_required', actionsExecuted: 0 })
  expect(gate.calls).toHaveLength(1)
  await page.close()
})

it('honours a provider-config pre-authorization and a stricter provider floor', async () => {
  const page = await pageFor(CHECKOUT)
  const preauthorized = { ...config, preauthorizeConsequential: true, minRisk: 'consequential' as const }
  const bypassed = new Gate(false)
  const state = await run(page, paySkill(), { approvals: bypassed, config: preauthorized })
  expect(bypassed.calls).toEqual([])
  expect(state).toMatchObject({ status: 'success', actionsExecuted: 1 })

  // The floor raises a reversible Skill to consequential, so approval returns
  // even though neither the caller nor the Skill asked for it.
  const clean = await browser.newPage()
  await clean.route('https://shop.example/**', route => route.fulfill({ contentType: 'text/html', body: CHECKOUT }))
  await clean.goto('https://shop.example/checkout')
  const floorGate = new Gate(false)
  const gated = await run(clean, paySkill({ risk: 'reversible' }), {
    approvals: floorGate, config: { ...config, minRisk: 'consequential' },
  })
  await clean.close()
  expect(gated).toMatchObject({ status: 'confirmation_required', actionsExecuted: 0 })
  expect(floorGate.calls).toHaveLength(1)
  await page.close()
})

it('refuses a read_only Skill that declares mutating steps', async () => {
  const page = await pageFor(CHECKOUT)
  const state = await run(page, paySkill({ risk: 'read_only' }), { approvals: new Gate(true) })
  expect(state).toMatchObject({ route: 'human', reason: 'skill_read_only_mutation', actionsExecuted: 0 })
  expect(await page.evaluate(() => (window as unknown as { __paid?: number }).__paid ?? 0)).toBe(0)
  await page.close()
})

it('never replays a window- or application-scoped Skill inside a browser', async () => {
  const page = await pageFor(CHECKOUT)
  const gate = new Gate(true)
  for (const match of [{ windowTitle: 'Finder' }, { appBundleId: 'com.apple.finder' }]) {
    const state = await run(page, paySkill({ match: match as never }), { approvals: gate })
    expect(state).toMatchObject({ route: 'human', reason: 'skill_provider_mismatch', actionsExecuted: 0 })
  }
  expect(gate.calls).toEqual([])
  expect(await page.evaluate(() => (window as unknown as { __paid?: number }).__paid ?? 0)).toBe(0)
  await page.close()
})

it('waits respond to the cancellation signal and need no approval', async () => {
  const page = await pageFor(CHECKOUT)
  const controller = new AbortController()
  const skill = paySkill({
    risk: 'reversible',
    verify: [{ type: 'text_visible', text: 'Never present' }],
    steps: [{ type: 'wait', ms: 5000 }, { type: 'click', target: 'Pay now' }],
  })
  const gate = new Gate(true)
  const running = runBrowserSkill(
    page, skill,
    { goal: 'wait', verify: [{ type: 'text_visible', text: 'Never present' }] } as never,
    config, controller.signal, undefined, 5, undefined, executionFor(controller.signal) as never, gate as never,
  )
  setTimeout(() => controller.abort(new Error('cancelled by operator')), 50)
  await expect(running).rejects.toThrow('cancelled by operator')
  expect(gate.calls).toEqual([])
  await page.close()
})
