import { z } from 'zod'
import type { Decision, Observation } from './types.ts'


export const taskPolicySchema = z.object({
  credentialsAvailable: z.boolean().optional().describe('False blocks credential fields entirely.'),
  allowLogin: z.boolean().optional().describe('True pre-authorizes credential submission and sign-in clicks for this run.'),
  risk: z.enum(['read_only', 'reversible', 'consequential']).default('reversible').describe('Consequential actions ask for one-action approval unless allowConsequential is true.'),
  allowConsequential: z.boolean().optional().describe('True pre-authorizes consequential actions for this run.'),
}).strict()
export type TaskPolicy = z.infer<typeof taskPolicySchema>

export interface PolicyStop {
  status: 'blocked' | 'confirmation_required' | 'escalated'
  reason: string
  details?: Record<string, unknown>
}

/**
 * Hard policy checks that do not depend on a selected action. Consequential
 * actions and credential submission ask for approval after the decision, so
 * the prompt can name the action and target.
 */
export function checkPagePolicy(observation: Observation, policy: TaskPolicy): PolicyStop | null {
  const hasPassword = observation.elements.some(element => element.inputType === 'password' && element.enabled)
  if (hasPassword && policy.credentialsAvailable === false) {
    return {
      status: 'blocked', reason: 'credentials_unavailable',
      details: { permission: 'login', message: 'The caller declared that no credentials are available.' },
    }
  }
  return null
}

function normalized(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\s+/gu, ' ').toLowerCase()
}

export function targetElement(observation: Observation, decision: Decision): Observation['elements'][number] | undefined {
  return decision.target === null ? undefined : observation.elements.find(element => element.id === decision.target)
}

/** True when the decision submits a secret, not when a password field is merely visible. */
export function isCredentialInput(observation: Observation, decision: Decision): boolean {
  if (!['TYPE_TEXT', 'PASTE_TEXT'].includes(decision.operation)) return false
  return targetElement(observation, decision)?.inputType === 'password'
}

/** True when the decision activates a sign-in control on a page that exposes a password field. */
export function isSignInAction(observation: Observation, decision: Decision): boolean {
  if (decision.operation !== 'CLICK') return false
  const hasPassword = observation.elements.some(element => element.inputType === 'password' && element.enabled)
  if (!hasPassword) return false
  const name = normalized(targetElement(observation, decision)?.name)
  return /sign in|sign-in|log in|log-in|login|登录|登入|ログイン/u.test(name)
}

export function checkTargetAmbiguity(
  observation: Observation,
  decision: Decision,
  goal: string,
): PolicyStop | null {
  if (decision.target === null) return null
  const target = observation.elements.find(element => element.id === decision.target)
  if (target === undefined || normalized(target.name) === '') return null
  const duplicates = observation.elements.filter(element =>
    element.enabled && element.role === target.role && normalized(element.name) === normalized(target.name),
  )
  if (duplicates.length <= 1) return null

  const contexts = [...new Set(duplicates.map(element => normalized(element.context)).filter(Boolean))]
  const goalNormalized = normalized(goal)
  const matching = contexts.filter(context => goalNormalized.includes(context))
  if (contexts.length > 1 && matching.length === 1 && normalized(target.context) === matching[0]) {
    return null
  }
  return {
    status: 'escalated',
    reason: 'ambiguous_target',
    details: {
      role: target.role,
      name: target.name,
      duplicateCount: duplicates.length,
      contexts,
    },
  }
}
