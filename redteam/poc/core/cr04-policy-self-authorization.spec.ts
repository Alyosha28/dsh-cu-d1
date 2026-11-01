/**
 * CR-04 — The model can pre-authorize its own consequential actions and logins.
 *
 * `policy` is a first-class field of the `d1_browser_subgoal` / native tool schema
 * (contract.ts:19, surfaced through `z.toJSONSchema(subgoalInput)` at
 * browser-use-d1/src/index.ts:316). Its own descriptions read
 * "True pre-authorizes consequential actions for this run" and
 * "True pre-authorizes credential submission and sign-in clicks for this run".
 * The caller of these tools is the model, so the approval decision is supplied by
 * the party the approval is supposed to constrain.
 *
 * Contract under test: ARCHITECTURE_PLAN.md §8 ("...使用外部审批，不由模型批准自己"),
 * §6.2 ("信心不能替代审批"), SKILL.md rule 5.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { subgoalInput } from '../../../packages/dsh-cu-core/src/contract.ts'
import { taskPolicySchema } from '../../../packages/dsh-cu-core/src/policy.ts'
import { checkPagePolicy, isCredentialInput, isSignInAction } from '../../../packages/dsh-cu-core/src/policy.ts'
import { needsConsequentialApproval, needsLoginApproval } from '../../../packages/dsh-cu-core/src/policy-approvals.ts'
import type { Observation } from '../../../packages/dsh-cu-core/src/types.ts'

const passwordPage: Observation = {
  snapshot_id: 's1', version: 1, url: 'https://bank.example/login', title: 'Sign in',
  truncated: false, can_scroll_up: false, can_scroll_down: false,
  elements: [
    { id: 'p1', role: 'textbox', name: 'Password', value: null, actions: ['type'], enabled: true, focused: false, inputType: 'password' },
    { id: 'b1', role: 'button', name: 'Sign in', value: null, actions: ['click'], enabled: true, focused: false },
  ],
}

describe('CR-04 model-supplied policy pre-authorizes the model', () => {
  it('the tool schema advertises allowConsequential / allowLogin to the model', () => {
    const schema = z.toJSONSchema(subgoalInput) as any
    const policy = schema.properties.policy
    expect(Object.keys(policy.properties)).toEqual(
      expect.arrayContaining(['risk', 'allowConsequential', 'allowLogin', 'credentialsAvailable']),
    )
    expect(JSON.stringify(policy)).toMatch(/pre-authorizes consequential actions/)
    expect(JSON.stringify(policy)).toMatch(/pre-authorizes credential submission and sign-in clicks/)
  })

  it('allowConsequential:true disables the consequential approval gate', () => {
    expect(needsConsequentialApproval(taskPolicySchema.parse({ risk: 'consequential' }))).toBe(true)
    expect(needsConsequentialApproval(taskPolicySchema.parse({ risk: 'consequential', allowConsequential: true }))).toBe(false)
  })

  it('allowLogin:true disables the login/credential approval gate', () => {
    const submit = { operation: 'TYPE_TEXT', target: 'p1', text: 'hunter2' }
    expect(needsLoginApproval(passwordPage, submit as any, taskPolicySchema.parse({ risk: 'reversible' }))).toBe(true)
    expect(needsLoginApproval(passwordPage, submit as any, taskPolicySchema.parse({ risk: 'reversible', allowLogin: true }))).toBe(false)
  })

  it('only a password input counts as a credential; cards, OTP and e-mail-first sign-in pass free', () => {
    const checkout: Observation = {
      ...passwordPage, url: 'https://shop.example/pay',
      elements: [
        { id: 'c1', role: 'textbox', name: 'Card number', value: null, actions: ['type'], enabled: true, focused: false, inputType: 'text' },
        { id: 'c2', role: 'textbox', name: 'CVV', value: null, actions: ['type'], enabled: true, focused: false, inputType: 'text' },
        { id: 'c3', role: 'button', name: 'Pay now', value: null, actions: ['click'], enabled: true, focused: false },
      ],
    }
    const card = { operation: 'TYPE_TEXT', target: 'c1', text: '4111111111111111' }
    expect(isCredentialInput(checkout, card as any)).toBe(false)
    expect(needsLoginApproval(checkout, card as any, { risk: 'reversible' })).toBe(false)

    // Email-first login: the password field arrives only on the *next* page.
    const emailFirst: Observation = {
      ...passwordPage, elements: [
        { id: 'e1', role: 'textbox', name: 'Email', value: null, actions: ['type'], enabled: true, focused: false, inputType: 'email' },
        { id: 'b1', role: 'button', name: 'Sign in', value: null, actions: ['click'], enabled: true, focused: false },
      ],
    }
    const signIn = { operation: 'CLICK', target: 'b1' }
    expect(isSignInAction(emailFirst, signIn as any)).toBe(false)
    expect(needsLoginApproval(emailFirst, signIn as any, { risk: 'reversible' })).toBe(false)
    expect(isSignInAction(emailFirst, signIn as any)).not.toBe(isSignInAction(passwordPage, { operation: 'CLICK', target: 'b1' } as any))
  })

  it('an omitted credentialsAvailable is treated as "credentials are available"', () => {
    expect(checkPagePolicy(passwordPage, { risk: 'reversible' })).toBeNull()
    expect(checkPagePolicy(passwordPage, { risk: 'reversible', credentialsAvailable: true })).toBeNull()
    expect(checkPagePolicy(passwordPage, { risk: 'reversible', credentialsAvailable: false })).toMatchObject({ status: 'blocked' })
  })
})
