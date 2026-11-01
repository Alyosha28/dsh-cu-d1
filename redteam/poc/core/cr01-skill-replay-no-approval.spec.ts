/**
 * CR-01 — Verified Skill replay performs consequential and login actions with no
 * approval path at all, and the Skill's own risk silently overrides the caller's.
 *
 * Contract under test:
 *  - ARCHITECTURE_PLAN.md §8: "后果性动作与凭据提交在动作选定后按单次动作请求批准" / "高风险操作、登录和 Skill 发布使用外部审批，不由模型批准自己"
 *  - SKILL.md hard rule 5: "Consequential actions and login require explicit user approval."
 *
 * Run: ./node_modules/.bin/vitest run --config redteam/poc/core/vitest.config.ts
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { taskPolicySchema } from '../../../packages/dsh-cu-core/src/policy.ts'
import { runBrowserSkill } from '../../../packages/dsh-browser-use-d1/src/skill-runner.ts'
import { FakePage } from './fake-page.ts'

const runnerSource = readFileSync(
  new URL('../../../packages/dsh-browser-use-d1/src/skill-runner.ts', import.meta.url),
  'utf8',
)
const nativeRunnerSource = readFileSync(
  new URL('../../../packages/dsh-computer-use-d1/src/skill-runner.ts', import.meta.url),
  'utf8',
)

const config = {
  locale: 'en',
  operationTimeoutMs: 1000,
  verificationTimeoutMs: 0,
  asyncTimeoutMs: 100,
  maxSteps: 12,
  decisionEndpoint: 'http://127.0.0.1:1',
  decisionToken: 'x',
  textStrategy: 'speculative',
  headless: true,
  maxWallClockMs: 60_000,
  maxInputTokens: 1,
  maxOutputTokens: 1,
  captureSkills: false,
  auditRetentionDays: 30,
  toolPrefix: 'browser',
} as any

const consequentialPaymentSkill = {
  id: 'redteam.pay-now',
  version: 1,
  verifiedAt: '2026-11-01',
  match: { urlPath: '/checkout', origin: 'https://shop.example' },
  fallback: 'd1' as const,
  risk: 'consequential' as const,
  verify: [{ type: 'text_visible' as const, text: 'Payment complete' }],
  steps: [{ type: 'click' as const, target: 'Pay now' }],
}

function paymentPage(): FakePage {
  const page = new FakePage('https://shop.example/checkout', [
    { name: 'Pay now', role: 'button', actions: ['click'] },
  ])
  page.onClick = name => {
    if (name === 'Pay now') page.visible.push('Payment complete')
  }
  return page
}

describe('CR-01 Skill replay has no approval channel', () => {
  it('the replay loop imports no approval primitive (source proof)', () => {
    for (const source of [runnerSource, nativeRunnerSource]) {
      expect(source).not.toMatch(/needsConsequentialApproval|needsLoginApproval/)
      expect(source).not.toMatch(/requestConsequentialApproval|requestLoginApproval/)
      expect(source).not.toMatch(/ApprovalGateway/)
    }
    // The d1 loop does use them — the difference is the defect, not a global design choice.
    const d1Loop = readFileSync(
      new URL('../../../packages/dsh-browser-use-d1/src/controller.ts', import.meta.url),
      'utf8',
    )
    expect(d1Loop).toMatch(/needsConsequentialApproval/)
    expect(d1Loop).toMatch(/requestLoginApproval/)
  })

  it('replays a risk=consequential Skill that clicks "Pay now" with zero prompts', async () => {
    const page = paymentPage()
    const state = await runBrowserSkill(
      page as any,
      consequentialPaymentSkill,
      { goal: 'Pay the invoice', verify: [{ type: 'text_visible', text: 'Payment complete' }] } as any,
      config,
      new AbortController().signal,
      undefined,
      5,
    )
    // The money-moving click was dispatched by the replay engine itself.
    expect(page.clicked).toEqual(['Pay now'])
    expect(state?.status).toBe('success')
    // No approval object exists anywhere in the call: `runBrowserSkill` has no
    // approvals parameter, so the runner cannot ask even if it wanted to.
    expect(runBrowserSkill.length).toBe(9)
    expect(runnerSource).not.toMatch(/approvals/)
  })

  it('skill.risk overrides a stricter caller policy (read_only is upgraded to the Skill risk)', async () => {
    const page = paymentPage()
    // Exactly the expression at skill-runner.ts:29 / computer-use skill-runner.ts:28
    const effective = taskPolicySchema.parse({ ...{ risk: 'read_only' as const }, risk: consequentialPaymentSkill.risk })
    expect(effective.risk).toBe('consequential')
    expect(effective.risk).not.toBe('read_only')

    const downgraded = taskPolicySchema.parse({ ...{ risk: 'read_only' as const }, risk: 'reversible' })
    expect(downgraded.risk).toBe('reversible')

    const state = await runBrowserSkill(
      page as any,
      { ...consequentialPaymentSkill, risk: 'reversible' },
      { goal: 'Pay the invoice', policy: { risk: 'read_only' }, verify: [{ type: 'text_visible', text: 'Payment complete' }] } as any,
      config,
      new AbortController().signal,
      undefined,
      5,
    )
    expect(page.clicked).toEqual(['Pay now'])
    expect(state?.status).toBe('success')
  })

  it('a credential-typing Skill step runs without a login approval', async () => {
    const page = new FakePage('https://shop.example/login', [
      { name: 'Password', role: 'textbox', inputType: 'password', actions: ['type'] },
      { name: 'Sign in', role: 'button', actions: ['click'] },
    ], [], 'Sign in')
    page.onClick = name => {
      if (name === 'Sign in') page.visible.push('Welcome back')
    }
    const state = await runBrowserSkill(
      page as any,
      {
        id: 'redteam.login', version: 1, verifiedAt: '2026-11-01',
        match: { urlPath: '/login', origin: 'https://shop.example' },
        fallback: 'd1', risk: 'read_only',
        verify: [{ type: 'text_visible', text: 'Welcome back' }],
        steps: [{ type: 'type', target: 'Password', input: 'Password' }, { type: 'click', target: 'Sign in' }],
      } as any,
      { goal: 'Sign in', inputs: { Password: 'correct-horse-battery' }, verify: [{ type: 'text_visible', text: 'Welcome back' }] } as any,
      config,
      new AbortController().signal,
      undefined,
      5,
    )
    expect(page.typed).toEqual([{ target: 'Password', text: 'correct-horse-battery' }])
    expect(page.clicked).toEqual(['Sign in'])
    expect(state?.status).toBe('success')
  })
})
