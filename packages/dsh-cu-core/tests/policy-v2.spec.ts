/**
 * CR-04 / CR-01 / CR-03 — model-facing policy must only be able to tighten.
 *
 * The caller of `d1_browser_subgoal` / `computer_subgoal` is the model, so the
 * approval decision may not live in a tool parameter. Only `risk` (a floor the
 * caller may raise) and `credentialsAvailable` (a restriction) stay model
 * facing; `allowConsequential` / `allowLogin` come from provider config.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { subgoalInput } from '../src/contract.ts'
import { taskPolicyInputSchema } from '../src/policy.ts'
import {
  checkPagePolicy,
  isCredentialInput,
  isSensitiveInput,
  isSignInAction,
  resolvePolicy,
  riskAtLeast,
  taskPolicySchema,
} from '../src/policy.ts'
import { needsConsequentialApproval, needsLoginApproval } from '../src/policy-approvals.ts'
import type { Observation, ObservedElement } from '../src/types.ts'

function element(partial: Partial<ObservedElement> & { name: string }): ObservedElement {
  return {
    id: partial.id ?? partial.name.toLowerCase().replace(/\s+/gu, '-'),
    role: partial.role ?? 'textbox',
    value: null,
    actions: ['type'],
    enabled: true,
    focused: false,
    ...partial,
  } as ObservedElement
}

function page(elements: ObservedElement[], extra: Partial<Observation> = {}): Observation {
  return {
    snapshot_id: 's1', version: 1, url: 'https://shop.example/pay', title: 'Checkout',
    truncated: false, can_scroll_up: false, can_scroll_down: false, elements, ...extra,
  }
}

const submit = element({ name: 'Pay now', role: 'button', actions: ['click'], context: 'Card form' })

describe('CR-04 — the model can only tighten the policy', () => {
  it('advertises only risk and credentialsAvailable to the model', () => {
    const schema = z.toJSONSchema(subgoalInput) as any
    const properties = schema.properties.policy.properties
    expect(Object.keys(properties).sort()).toEqual(['credentialsAvailable', 'risk'])
    expect(JSON.stringify(schema.properties.policy)).not.toMatch(/pre-authorizes/u)
  })

  it('rejects allowConsequential / allowLogin from a tool call', () => {
    expect(() => subgoalInput.parse({
      goal: 'Pay', verify: [{ type: 'text_visible', text: 'Paid' }],
      policy: { risk: 'consequential', allowConsequential: true },
    })).toThrow()
    expect(() => subgoalInput.parse({
      goal: 'Sign in', verify: [{ type: 'text_visible', text: 'Hi' }],
      policy: { allowLogin: true },
    })).toThrow()
    expect(taskPolicyInputSchema.safeParse({ allowConsequential: true }).success).toBe(false)
  })

  it('keeps allow* on the internal schema for provider composition', () => {
    expect(taskPolicySchema.parse({ risk: 'consequential', allowConsequential: true }))
      .toMatchObject({ risk: 'consequential', allowConsequential: true })
  })
})

describe('resolvePolicy — risk floor, approvals only from config', () => {
  it('raises the caller risk to the configured floor and never lowers it', () => {
    expect(resolvePolicy(undefined, {}).risk).toBe('reversible')
    expect(resolvePolicy({ risk: 'read_only' }, {}).risk).toBe('read_only')
    expect(resolvePolicy({ risk: 'read_only' }, { minRisk: 'consequential' }).risk).toBe('consequential')
    expect(resolvePolicy({ risk: 'consequential' }, { minRisk: 'reversible' }).risk).toBe('consequential')
  })

  it('takes allow* only from the provider config', () => {
    expect(resolvePolicy(undefined, {})).not.toHaveProperty('allowConsequential', true)
    expect(resolvePolicy(undefined, {})).not.toHaveProperty('allowLogin', true)
    expect(resolvePolicy({ risk: 'consequential', credentialsAvailable: false } as any, {
      preauthorizeConsequential: true, preauthorizeLogin: true,
    })).toMatchObject({
      risk: 'consequential', credentialsAvailable: false,
      allowConsequential: true, allowLogin: true,
    })
    // a caller cannot pre-authorize by smuggling the internal field
    expect(resolvePolicy({ risk: 'reversible', allowConsequential: true } as any, {}).allowConsequential).toBeUndefined()
  })

  it('ranks risks', () => {
    expect(riskAtLeast('consequential', 'reversible')).toBe(true)
    expect(riskAtLeast('read_only', 'reversible')).toBe(false)
  })
})

describe('CR-04 — sensitive input classification', () => {
  it('classifies payment, OTP and credential fields', () => {
    const cases: Array<[Partial<ObservedElement> & { name: string }, boolean]> = [
      [{ name: 'Password', inputType: 'password' }, true],
      [{ name: 'Search' }, false],
      [{ name: 'Card number', id: 'cc-number' }, true],
      [{ name: 'Field A', identifier: 'cvv' }, true],
      [{ name: 'Field B', identifier: 'cvc-code' }, true],
      [{ name: 'Field C', name: 'PIN code' }, true],
      [{ name: 'One-time code' }, true],
      [{ name: '验证码' }, true],
      [{ name: '登录密码' }, true],
      [{ name: '卡号' }, true],
      [{ name: 'Field D', value: null }, false],
      // autocomplete tokens are observed through the element context
      [{ name: 'Field E', context: 'autocomplete=current-password' }, true],
      [{ name: 'Field F', context: 'autocomplete=one-time-code' }, true],
      [{ name: 'Field G', context: 'autocomplete=cc-number' }, true],
      [{ name: 'Field H', context: 'autocomplete=off' }, false],
    ]
    for (const [spec, expected] of cases) {
      expect(isSensitiveInput(element(spec)), JSON.stringify(spec)).toBe(expected)
    }
  })

  it('requires approval to type a card number or OTP even at risk=reversible', () => {
    const checkout = page([
      element({ name: 'Card number', id: 'cc-number', inputType: 'text' }),
      element({ name: 'CVV', id: 'cvv', inputType: 'text' }),
      element({ name: 'One-time code', id: 'otp', inputType: 'text' }),
      submit,
    ])
    const policy = resolvePolicy({ risk: 'reversible' }, {})
    for (const target of ['cc-number', 'cvv', 'otp']) {
      const decision = { operation: 'TYPE_TEXT' as const, target, text: '4111111111111111' }
      expect(isCredentialInput(checkout, decision), target).toBe(true)
      expect(needsLoginApproval(checkout, decision, policy), target).toBe(true)
    }
  })

  it('treats a visible sensitive field as blocking when credentials are unavailable', () => {
    const checkout = page([element({ name: 'Card number', id: 'cc-number', inputType: 'text' })])
    expect(checkPagePolicy(checkout, { risk: 'reversible', credentialsAvailable: false }))
      .toMatchObject({ status: 'blocked', reason: 'credentials_unavailable' })
    expect(checkPagePolicy(checkout, { risk: 'reversible', credentialsAvailable: true })).toBeNull()
  })
})

describe('real snapshot shape — null-bearing fields must not throw', () => {
  // The browser snapshot emits `inputType: null` for non-input elements and
  // `name`/`identifier`/`context` can be null at runtime even though the type
  // says string. A TypeError here takes down the whole provider.
  const raw = (partial: Record<string, unknown>) => partial as unknown as ObservedElement

  it('classifies elements whose inputType is null', () => {
    expect(isSensitiveInput(raw({ id: 'e1', role: 'button', name: 'Pay now', value: null, actions: ['click'], enabled: true, focused: false, inputType: null })))
      .toBe(false)
    expect(isSensitiveInput(raw({ id: 'e2', role: 'textbox', name: 'Password', value: null, actions: ['type'], enabled: true, focused: false, inputType: null })))
      .toBe(true)
    expect(isSensitiveInput(raw({ id: 'e3', role: 'textbox', name: 'Card number', value: null, actions: ['type'], enabled: true, focused: false, inputType: null })))
      .toBe(true)
    expect(isSensitiveInput(raw({ id: 'e4', role: 'textbox', name: null, identifier: null, context: null, value: null, actions: [], enabled: true, focused: false, inputType: null })))
      .toBe(false)
    expect(isSensitiveInput(raw({ id: 'e5', role: 'textbox', name: null, identifier: 'cvv', context: null, value: null, actions: [], enabled: true, focused: false, inputType: null })))
      .toBe(true)
    expect(isSensitiveInput(raw({ id: 'e6', role: 'textbox', name: null, identifier: null, context: 'autocomplete=one-time-code', value: null, actions: [], enabled: true, focused: false, inputType: null })))
      .toBe(true)
  })

  it('does not classify an ordinary field whose name merely contains "pin"', () => {
    const shopping = page([element({ name: 'Shopping list' }), element({ name: 'Spinner value' })])
    expect(shopping.elements.every(item => !isSensitiveInput(item))).toBe(true)
    expect(isSensitiveInput(element({ name: 'PIN code' }))).toBe(true)
    expect(isSensitiveInput(element({ name: 'Card PIN' }))).toBe(true)
    expect(isSensitiveInput(element({ name: 'Shipping address' }))).toBe(false)
  })

  it('runs the whole policy surface on a real-shaped observation', () => {
    const observation = {
      snapshot_id: 's1', version: 1, url: 'https://shop.example/pay', title: 'Checkout',
      truncated: false, can_scroll_up: false, can_scroll_down: false,
      elements: [
        raw({ id: 'e1', role: 'button', name: 'Pay now', value: null, actions: ['click'], enabled: true, focused: false, inputType: null, context: 'Card form' }),
        raw({ id: 'e2', role: 'textbox', name: 'Card number', value: null, actions: ['type'], enabled: true, focused: false, inputType: null, context: 'Card form' }),
        raw({ id: 'e3', role: 'textbox', name: null, identifier: null, context: null, value: null, actions: [], enabled: true, focused: false, inputType: null }),
      ],
    } as unknown as Observation
    expect(() => checkPagePolicy(observation, { risk: 'reversible', credentialsAvailable: false })).not.toThrow()
    expect(checkPagePolicy(observation, { risk: 'reversible', credentialsAvailable: false }))
      .toMatchObject({ status: 'blocked', reason: 'credentials_unavailable' })
    expect(checkPagePolicy(observation, { risk: 'reversible' })).toBeNull()
    expect(isCredentialInput(observation, { operation: 'TYPE_TEXT', target: 'e2', text: '4111' })).toBe(true)
    expect(isCredentialInput(observation, { operation: 'TYPE_TEXT', target: 'e3', text: 'x' })).toBe(false)
    expect(() => isSignInAction(observation, { operation: 'CLICK', target: 'e1' })).not.toThrow()
    expect(isSignInAction(observation, { operation: 'CLICK', target: 'e1' })).toBe(true)
    expect(needsLoginApproval(observation, { operation: 'TYPE_TEXT', target: 'e2', text: '4111' }, resolvePolicy(undefined, {})))
      .toBe(true)
  })
})

describe('CR-04 — form-aware sign-in detection', () => {
  it('detects a submit control inside a form that holds a sensitive field', () => {
    // Email-first: the button says "Continue", no password on the page yet.
    // The password field arrives on the next page, so only form semantics can
    // tie the submit control to the credential form.
    const emailFirst = page([
      element({ name: 'Email', id: 'email', inputType: 'email', context: 'Sign-in form' }),
      element({ name: 'Password', id: 'password-field', inputType: 'password', context: 'Sign-in form' }),
      element({ name: 'Continue', role: 'button', actions: ['click'], context: 'Sign-in form' }),
      element({ name: 'Subscribe', role: 'button', actions: ['click'], context: 'Newsletter' }),
    ])
    const policy = resolvePolicy({ risk: 'reversible' }, {})
    const click = (target: string) => ({ operation: 'CLICK' as const, target })
    expect(isSignInAction(emailFirst, click('continue'))).toBe(true)
    expect(needsLoginApproval(emailFirst, click('continue'), policy)).toBe(true)
    expect(isSignInAction(emailFirst, click('subscribe'))).toBe(false)
  })

  it('keeps the name regex as a fallback when no form context is observed', () => {
    const flat = page([
      element({ name: 'Password', inputType: 'password' }),
      element({ name: 'Sign in', role: 'button', actions: ['click'] }),
      element({ name: 'Cancel', role: 'button', actions: ['click'] }),
    ])
    expect(isSignInAction(flat, { operation: 'CLICK', target: 'sign-in' })).toBe(true)
    expect(isSignInAction(flat, { operation: 'CLICK', target: 'cancel' })).toBe(false)
  })
})

describe('needs* keep their call shape', () => {
  it('a model-set risk never disables the consequential gate', () => {
    expect(needsConsequentialApproval(resolvePolicy({ risk: 'consequential' }, {}))).toBe(true)
    expect(needsConsequentialApproval({ risk: 'consequential' })).toBe(true)
    expect(needsConsequentialApproval(resolvePolicy(undefined, { preauthorizeConsequential: true }))).toBe(false)
    expect(needsConsequentialApproval({ risk: 'reversible' })).toBe(false)
  })

  it('a provider login pre-authorization still bypasses the login gate', () => {
    const passwordPage = page([element({ name: 'Password', inputType: 'password' })])
    const decision = { operation: 'TYPE_TEXT' as const, target: 'password', text: 'hunter2' }
    expect(needsLoginApproval(passwordPage, decision, { risk: 'reversible', allowLogin: true })).toBe(false)
    expect(needsLoginApproval(passwordPage, decision, { risk: 'reversible' })).toBe(true)
  })
})
