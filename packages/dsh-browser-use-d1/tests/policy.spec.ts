import { expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import { checkPagePolicy, checkTargetAmbiguity, isCredentialInput, isSignInAction } from '../src/policy.ts'
import { needsConsequentialApproval, needsLoginApproval } from '@albaincompleta/dsh-cu-core/policy-approvals'
import type { Observation } from '../src/dom.ts'

const observation: Observation = {
  snapshot_id: 's1', version: 1, url: 'http://fixture', title: 'Fixture', truncated: false,
  can_scroll_up: false, can_scroll_down: false,
  elements: [
    { id: 'document', role: 'button', name: 'Save', value: null, actions: ['click'], enabled: true, focused: false, context: 'Document' },
    { id: 'workspace', role: 'button', name: 'Save', value: null, actions: ['click'], enabled: true, focused: false, context: 'Workspace' },
  ],
}

it('applies a bounded audit retention configuration', () => {
  expect(Config({ mode: 'launch', decisionToken: 'unused' }).auditRetentionDays).toBe(30)
  expect(Config({ mode: 'launch', decisionToken: 'unused', auditRetentionDays: 7 }).auditRetentionDays).toBe(7)
  expect(() => Config({ mode: 'launch', decisionToken: 'unused', auditRetentionDays: 0 })).toThrow()
  expect(() => Config({ mode: 'launch', decisionToken: 'unused', auditRetentionDays: 3651 })).toThrow()
})

it('allows a duplicate target only when its context uniquely disambiguates the goal', () => {
  expect(checkTargetAmbiguity(observation, { operation: 'CLICK', target: 'workspace' }, 'Click Save in Workspace')).toBeNull()
  expect(checkTargetAmbiguity(observation, { operation: 'CLICK', target: 'document' }, 'Click Save in Workspace')?.reason).toBe('ambiguous_target')
  expect(checkTargetAmbiguity(observation, { operation: 'CLICK', target: 'workspace' }, 'Click Save')?.reason).toBe('ambiguous_target')
})

it('rejects duplicates within one context and credential or consequential policy violations', () => {
  const duplicate = {
    ...observation,
    elements: observation.elements.map(element => ({ ...element, context: 'Document' })),
  }
  expect(checkTargetAmbiguity(duplicate, { operation: 'CLICK', target: 'workspace' }, 'Save in Document')?.reason).toBe('ambiguous_target')

  const password = {
    ...observation,
    elements: [{ ...observation.elements[0]!, inputType: 'password', name: 'Password', role: 'textbox' }],
  }
  expect(checkPagePolicy(password, { risk: 'reversible', credentialsAvailable: false })?.reason).toBe('credentials_unavailable')
  expect(checkPagePolicy(password, { risk: 'reversible' })).toBeNull()
  expect(checkPagePolicy(observation, { risk: 'consequential' })).toBeNull()
  expect(needsConsequentialApproval({ risk: 'consequential' })).toBe(true)
  expect(needsConsequentialApproval({ risk: 'consequential', allowConsequential: true })).toBe(false)
  const credentialDecision = { operation: 'TYPE_TEXT' as const, target: 'document', text: 'secret' }
  expect(isCredentialInput(password, credentialDecision)).toBe(true)
  expect(isCredentialInput(password, { operation: 'CLICK', target: 'document' })).toBe(false)
  expect(needsLoginApproval(password, credentialDecision, { risk: 'reversible' })).toBe(true)
  const signIn = {
    ...password,
    elements: [
      { ...password.elements[0]!, name: 'Sign in', inputType: undefined },
      ...password.elements,
    ],
  }
  expect(isSignInAction(signIn, { operation: 'CLICK', target: 'document' })).toBe(true)
  expect(needsLoginApproval(signIn, { operation: 'CLICK', target: 'document' }, { risk: 'reversible' })).toBe(true)
})
