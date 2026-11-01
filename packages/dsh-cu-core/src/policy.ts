import { z } from 'zod'
import type { Decision, Observation, ObservedElement } from './types.ts'


/**
 * The model-facing policy. The caller of these tools is the model, so it may
 * only *tighten* the run: raise the risk floor or declare that no credentials
 * are available. Pre-authorization (`allowConsequential` / `allowLogin`) is a
 * provider-config decision and never a tool parameter (CR-04).
 */
export const taskPolicyInputSchema = z.object({
  risk: z.enum(['read_only', 'reversible', 'consequential']).default('reversible')
    .describe('Risk floor for this subgoal. The effective risk is the maximum of this value and the provider configuration, so a lower value never disables approval.'),
  credentialsAvailable: z.boolean().optional()
    .describe('False blocks credential, payment and one-time-code fields entirely.'),
}).strict()
export type TaskPolicyInput = z.infer<typeof taskPolicyInputSchema>

/**
 * The internal policy a run is executed with. Provider config is composed in
 * through {@link resolvePolicy}; tools never parse the model input with this
 * schema.
 */
export const taskPolicySchema = z.object({
  credentialsAvailable: z.boolean().optional().describe('False blocks credential fields entirely.'),
  allowLogin: z.boolean().optional().describe('Provider-config pre-authorization for credential submission and sign-in clicks.'),
  risk: z.enum(['read_only', 'reversible', 'consequential']).default('reversible').describe('Effective risk. Consequential actions ask for one-action approval unless the provider config pre-authorized them.'),
  allowConsequential: z.boolean().optional().describe('Provider-config pre-authorization for consequential actions.'),
}).strict()
export type TaskPolicy = z.infer<typeof taskPolicySchema>

export interface PolicyConfig {
  /** Effective-risk floor owned by the provider host, e.g. 'reversible'. */
  minRisk?: TaskPolicy['risk']
  /** Host-level pre-authorization; never settable by the model. */
  preauthorizeConsequential?: boolean
  /** Host-level pre-authorization; never settable by the model. */
  preauthorizeLogin?: boolean
}

export const RISK_ORDER: ReadonlyArray<TaskPolicy['risk']> = ['read_only', 'reversible', 'consequential']

export function riskAtLeast(risk: TaskPolicy['risk'], floor: TaskPolicy['risk'] | undefined): boolean {
  if (floor === undefined) return true
  return RISK_ORDER.indexOf(risk) >= RISK_ORDER.indexOf(floor)
}

export function maxRisk(...risks: Array<TaskPolicy['risk'] | undefined>): TaskPolicy['risk'] {
  let result: TaskPolicy['risk'] = 'read_only'
  for (const risk of risks) {
    if (risk !== undefined && riskAtLeast(risk, result)) result = risk
  }
  return result
}

/**
 * Combines a caller-supplied (model) policy with the provider configuration.
 * `risk` is the maximum of both, and every `allow*` flag comes from `config`
 * only, so a tool argument can never pre-authorize anything.
 */
export function resolvePolicy(input: TaskPolicyInput | undefined, config: PolicyConfig = {}): TaskPolicy {
  const requested = input?.risk ?? 'reversible'
  const policy: TaskPolicy = { risk: maxRisk(requested, config.minRisk) }
  if (input?.credentialsAvailable !== undefined) policy.credentialsAvailable = input.credentialsAvailable
  if (config.preauthorizeConsequential === true) policy.allowConsequential = true
  if (config.preauthorizeLogin === true) policy.allowLogin = true
  return policy
}

export interface PolicyStop {
  status: 'blocked' | 'confirmation_required' | 'escalated'
  reason: string
  details?: Record<string, unknown>
}

const SENSITIVE_AUTOCOMPLETE = [
  'current-password',
  'new-password',
  'one-time-code',
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-name',
]

/**
 * Field names that carry a secret. `passw`/`passc` cover password, passwd and
 * passcode; `pin` is word-anchored so "Shopping"/"Spinner" do not match.
 */
const SENSITIVE_PATTERN = /passw|passc|\bpin\b|otp|one[-_ ]?time|cvv|cvc|security code|card number|card|credit card|debit card|\bban\b|seed phrase|mnemonic|recovery code|验证码|密码|口令|卡号|安全码|动态码|校验码/u

/** Observed fields arrive from the DOM and may be `null` even where the type says string. */
function text(value: string | null | undefined): string {
  return typeof value === 'string' ? value : ''
}

function autocompleteTokens(element: ObservedElement): string[] {
  const raw = `${text(element.context)} ${text(element.identifier)} ${text(element.inputType)}`
  const tokens: string[] = []
  for (const match of raw.matchAll(/autocomplete\s*=\s*["']?([^"'\s;]+)/giu)) tokens.push(match[1]!.toLowerCase())
  const inputType = text(element.inputType)
  if (inputType !== '') tokens.push(inputType.toLowerCase())
  return tokens
}

const AUTOCOMPLETE_FIELDS = new Set(SENSITIVE_AUTOCOMPLETE)

/**
 * True when an element carries a secret: a password field, a payment or
 * one-time-code autocomplete token, or a name/identifier/label that names a
 * PIN, OTP, CVV, card number, password or verification code (CR-04).
 */
export function isSensitiveInput(element: ObservedElement | undefined | null): boolean {
  if (element === undefined || element === null || typeof element !== 'object') return false
  if (text(element.inputType).toLowerCase() === 'password') return true
  if (autocompleteTokens(element).some(token => AUTOCOMPLETE_FIELDS.has(token))) return true
  const haystack = [text(element.name), text(element.identifier), text(element.context), text(element.inputType)].join(' ')
  return SENSITIVE_PATTERN.test(haystack.toLowerCase())
}

function hasSensitiveField(elements: ObservedElement[] | undefined | null): boolean {
  return Array.isArray(elements) && elements.some(element => element?.enabled === true && isSensitiveInput(element))
}

/**
 * Hard policy checks that do not depend on a selected action. Consequential
 * actions and credential submission ask for approval after the decision, so
 * the prompt can name the action and target.
 */
export function checkPagePolicy(observation: Observation, policy: TaskPolicy): PolicyStop | null {
  if (policy.credentialsAvailable === false && hasSensitiveField(observation?.elements)) {
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
  if (decision.target === null || decision.target === undefined) return undefined
  const elements = observation?.elements
  return Array.isArray(elements) ? elements.find(element => element?.id === decision.target) : undefined
}

/** True when the decision submits a secret, not when a password field is merely visible. */
export function isCredentialInput(observation: Observation, decision: Decision): boolean {
  if (!['TYPE_TEXT', 'PASTE_TEXT'].includes(decision.operation)) return false
  return isSensitiveInput(targetElement(observation, decision))
}

const SIGN_IN_TEXT = /sign in|sign-in|signin|log in|log-in|login|登录|登入|ログイン/u
const SUBMIT_ROLE = /button|link|menuitem/u

function sameForm(subject: ObservedElement, other: ObservedElement): boolean {
  const context = normalized(text(subject.context))
  return context !== '' && normalized(text(other.context)) === context
}

/**
 * True when the decision activates a sign-in control. The primary evidence is
 * form semantics: a submit-like control sharing a form context with a
 * sensitive field (this covers e-mail-first sign-in pages, where the password
 * field only appears on the next page). The control-name regex remains a
 * fallback for flat observations without form context.
 */
export function isSignInAction(observation: Observation, decision: Decision): boolean {
  if (decision.operation !== 'CLICK') return false
  const target = targetElement(observation, decision)
  if (target === undefined) return false
  const actions = Array.isArray(target.actions) ? target.actions : []
  const submitLike = actions.includes('click') || SUBMIT_ROLE.test(text(target.role))
  if (submitLike && (observation?.elements ?? []).some(element =>
    element?.id !== target.id && element?.enabled === true && isSensitiveInput(element) && sameForm(target, element))) {
    return true
  }
  // Fallback: a login-shaped control name on a page that exposes a sensitive field.
  if (!hasSensitiveField(observation.elements)) return false
  return SIGN_IN_TEXT.test(normalized(target.name))
}

export function checkTargetAmbiguity(
  observation: Observation,
  decision: Decision,
  goal: string,
): PolicyStop | null {
  if (decision.target === null) return null
  const target = (observation?.elements ?? []).find(element => element?.id === decision.target)
  if (target === undefined || normalized(target.name) === '') return null
  const duplicates = (observation?.elements ?? []).filter(element =>
    element?.enabled === true && element.role === target.role && normalized(element.name) === normalized(target.name),
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
