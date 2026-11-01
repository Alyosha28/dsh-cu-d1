import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalGateway } from './approvals.ts'
import type { ApprovalLabels } from './locale.ts'
import { formatTemplate } from './locale.ts'
import { isCredentialInput, isSignInAction, targetElement, type TaskPolicy } from './policy.ts'
import type { Decision, Observation } from './types.ts'


export interface ActionApprovalContext {
  operation: string
  target: string
  scope: string
}

export function actionApprovalContext(observation: Observation, decision: Decision): ActionApprovalContext {
  const element = targetElement(observation, decision)
  return {
    operation: decision.operation,
    target: element?.name || element?.identifier || decision.target || 'current view',
    scope: observation.title || observation.url,
  }
}

export function needsConsequentialApproval(policy: TaskPolicy): boolean {
  return policy.risk === 'consequential' && policy.allowConsequential !== true
}

/**
 * True when the decision needs a credential/payment/sign-in approval. `policy`
 * is the internal resolved policy: `resolvePolicy` / `skillPolicy` are the only
 * producers of `allowLogin`, so a tool argument cannot suppress this gate.
 */
export function needsLoginApproval(observation: Observation, decision: Decision, policy: TaskPolicy): boolean {
  if (policy.allowLogin === true) return false
  return isCredentialInput(observation, decision) || isSignInAction(observation, decision)
}

export async function requestConsequentialApproval(
  agent: Agent,
  gateway: ApprovalGateway | undefined,
  context: ActionApprovalContext,
  labels: ApprovalLabels,
  signal: AbortSignal,
): Promise<{ approved: boolean; reason?: string }> {
  if (gateway === undefined) return { approved: false, reason: 'approval_unavailable' }
  return gateway.request(agent, {
    id: 'dsh-cu-consequential',
    question: labels.consequentialQuestion,
    detail: formatTemplate(labels.consequentialDetail, { operation: context.operation, target: context.target, scope: context.scope }),
    approve: labels.allowOnce,
    reject: labels.deny,
  }, signal)
}

export async function requestLoginApproval(
  agent: Agent,
  gateway: ApprovalGateway | undefined,
  context: ActionApprovalContext,
  labels: ApprovalLabels,
  signal: AbortSignal,
): Promise<{ approved: boolean; reason?: string }> {
  if (gateway === undefined) return { approved: false, reason: 'approval_unavailable' }
  return gateway.request(agent, {
    id: 'dsh-cu-login',
    question: labels.loginQuestion,
    detail: formatTemplate(labels.loginDetail, { operation: context.operation, target: context.target, scope: context.scope }),
    approve: labels.allowLogin,
    reject: labels.deny,
  }, signal)
}
