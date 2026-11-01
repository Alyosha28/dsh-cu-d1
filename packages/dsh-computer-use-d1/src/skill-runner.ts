import { validateDecision } from '@albaincompleta/dsh-cu-core/actions'
import { checkPagePolicy, checkTargetAmbiguity } from '@albaincompleta/dsh-cu-core/policy'
import type { TaskPolicy } from '@albaincompleta/dsh-cu-core/policy'
import {
  actionApprovalContext, needsConsequentialApproval, needsLoginApproval,
  requestConsequentialApproval, requestLoginApproval,
} from '@albaincompleta/dsh-cu-core/policy-approvals'
import type { ActionApprovalContext } from '@albaincompleta/dsh-cu-core/policy-approvals'
import {
  assertSkillProvider, assertSkillScope, decisionForSkillStep, SkillError, skillPolicy, verificationForSkill,
} from '@albaincompleta/dsh-cu-core/skills'
import type { VerifiedSkill } from '@albaincompleta/dsh-cu-core/skills'
import { uiStrings } from '@albaincompleta/dsh-cu-core/locale'
import type { ApprovalGateway } from '@albaincompleta/dsh-cu-core/approvals'
import type { ComputerSubgoalInput, RunState } from './controller.ts'
import { executeNative, hasPendingState, isUncertainNativePaste, parseAxElements, readNativeState, verifyNative } from './controller.ts'
import type { NativeCaller } from './controller.ts'
import type { RunBudget } from '@albaincompleta/dsh-cu-core/budget'
import type { ActivitySink } from '@albaincompleta/dsh-cu-core/activity'
import type { ExecutionHandle } from '@albaincompleta/dsh-cu-core/run-controller'
import type { ResolvedConfig } from './config.ts'

/**
 * Provider-owned policy inputs the Skill route needs to reach the same gates as
 * the D1 route (CR-01). They are read defensively so this route keeps working
 * before the provider config declares them: an absent field means "no host floor"
 * and "no host pre-authorization", never "pre-authorized".
 */
export interface NativeSkillPolicyConfig {
  minRisk?: TaskPolicy['risk']
  preauthorizeConsequential?: boolean
  preauthorizeLogin?: boolean
}

export function nativeSkillPolicy(config: ResolvedConfig, skill: VerifiedSkill, args: ComputerSubgoalInput): TaskPolicy {
  const extended = config as ResolvedConfig & NativeSkillPolicyConfig
  return skillPolicy(args.policy, skill, {
    ...extended.minRisk === undefined ? {} : { minRisk: extended.minRisk },
    ...extended.preauthorizeConsequential === undefined ? {} : { preauthorizeConsequential: extended.preauthorizeConsequential },
    ...extended.preauthorizeLogin === undefined ? {} : { preauthorizeLogin: extended.preauthorizeLogin },
  })
}


export async function runNativeSkill(
  caller: NativeCaller,
  skill: VerifiedSkill,
  args: ComputerSubgoalInput,
  selected: any,
  params: Record<string, unknown>,
  config: ResolvedConfig,
  signal: AbortSignal,
  appBundleId?: string,
  budget?: RunBudget,
  maxSteps?: number,
  indicator?: ActivitySink,
  execution?: ExecutionHandle,
  approvals?: ApprovalGateway,
): Promise<RunState | null> {
  // CR-03: a Skill may only replay in the provider whose scope kind it carries.
  assertSkillProvider(skill, 'native')
  assertSkillScope(skill, { windowTitle: selected.title, appBundleId })
  const policy = nativeSkillPolicy(config, skill, args)
  const approvalLabels = uiStrings(config.locale).approvals
  const state: RunState = {
    route: 'skill', skillId: skill.id, status: 'escalated', reason: 'skill_failed',
    decisionRequests: 0, modelForwardCalls: 0, textExtractionCalls: 0,
    actionsExecuted: 0, staleDecisions: 0, decisionLatencyMs: 0, inputTokens: 0, outputTokens: 0, trace: [],
  }
  try {
    const assertions = verificationForSkill(skill, args.inputs, args.verify)
    if (await verifyNative(caller, params, assertions, signal)) {
      state.status = 'success'
      state.reason = 'independently_verified'
      return state
    }

    await indicator?.activity({ phase: 'skill', step: 1, maxSteps, route: 'skill' })
    /**
     * CR-01: the same two gates the D1 route uses, asked once per mutating step.
     * Without a live execution handle and an approval gateway the step is refused
     * before any input is dispatched, so a missing wire can never silently replay.
     */
    const approvalGate = async (
      kind: 'consequential' | 'login',
      context: ActionApprovalContext,
      operation: string,
      stepIndex: number,
    ): Promise<RunState | null> => {
      if (execution === undefined || approvals === undefined) {
        state.status = 'confirmation_required'
        state.reason = 'approval_unavailable'
        return state
      }
      await indicator?.activity({
        phase: 'awaiting_approval', operation, step: stepIndex + 1, maxSteps, route: 'skill',
      })
      const result = kind === 'consequential'
        ? await requestConsequentialApproval(execution.agent, approvals, context, approvalLabels, signal)
        : await requestLoginApproval(execution.agent, approvals, context, approvalLabels, signal)
      if (result.approved) return null
      state.status = 'confirmation_required'
      state.reason = result.reason ?? (kind === 'consequential'
        ? 'consequential_action_requires_approval'
        : 'login_requires_approval')
      return state
    }
    for (const [stepIndex, step] of skill.steps.entries()) {
      const paused = await execution?.waitWhilePaused(signal)
      if (paused !== null && paused !== undefined) {
        state.status = paused.status
        state.reason = paused.reason
        return state
      }
      if (execution !== undefined) budget?.creditPaused(execution.pausedMs())
      if (maxSteps !== undefined && stepIndex >= maxSteps) {
        state.reason = 'step_budget_exhausted'
        return state
      }
      const budgetStop = budget?.checkClock()
      if (budgetStop !== null && budgetStop !== undefined) {
        state.reason = budgetStop.reason
        return state
      }
      signal.throwIfAborted()
      if (step.type === 'wait') {
        await indicator?.activity({ phase: 'waiting', step: stepIndex + 1, maxSteps, route: 'skill' })
        let remaining = step.ms
        while (remaining > 0) {
          signal.throwIfAborted()
          const waitBudgetStop = budget?.checkClock()
          if (waitBudgetStop !== null && waitBudgetStop !== undefined) {
            state.reason = waitBudgetStop.reason
            return state
          }
          const slice = Math.min(50, remaining)
          await new Promise(resolve => setTimeout(resolve, slice))
          remaining -= slice
        }
        continue
      }
      await indicator?.activity({ phase: 'observing', step: stepIndex + 1, maxSteps, route: 'skill' })
      const nativeState = await readNativeState(caller, params, signal)
      // CR-03: re-assert the provider and the scope against the fresh window, so a
      // window retitled or replaced mid-replay cannot inherit the Skill's approval.
      assertSkillProvider(skill, 'native')
      const liveWindow = Array.isArray(nativeState.windows)
        ? nativeState.windows.find((entry: any) => entry?.windowId === params.windowId)
        : undefined
      assertSkillScope(skill, {
        windowTitle: typeof liveWindow?.title === 'string' ? liveWindow.title : selected.title,
        appBundleId,
      })
      const observation: import('@albaincompleta/dsh-cu-core/types').Observation = {
        snapshot_id: nativeState.snapshotId,
        version: 0,
        url: `app://${nativeState.pid}/${selected.windowId}`,
        title: selected.title ?? '',
        truncated: Boolean(nativeState.truncated),
        can_scroll_up: false,
        can_scroll_down: false,
        ...selected.bounds === undefined ? {} : { windowBounds: selected.bounds },
        elements: [],
      }
      observation.elements = parseAxElements(nativeState.tree, selected)
      const policyStop = checkPagePolicy(observation, policy)
      if (policyStop !== null) {
        state.route = 'human'
        state.status = policyStop.status
        state.reason = policyStop.reason
        return state
      }
      const decision = decisionForSkillStep(step, observation, args.inputs)
      validateDecision(observation, decision)
      const ambiguityStop = checkTargetAmbiguity(observation, decision, args.goal)
      if (ambiguityStop !== null) {
        state.route = 'human'
        state.reason = ambiguityStop.reason
        state.details = ambiguityStop.details
        return state
      }
      try {
        const preAction = await execution?.waitWhilePaused(signal)
        if (preAction !== null && preAction !== undefined) {
          state.status = preAction.status
          state.reason = preAction.reason
          return state
        }
        const controlStop = execution?.admit()
        if (controlStop !== null && controlStop !== undefined) {
          state.status = controlStop.status
          state.reason = controlStop.reason
          return state
        }
        const approvalContext = actionApprovalContext(observation, decision)
        if (needsConsequentialApproval(policy)) {
          const gated = await approvalGate('consequential', approvalContext, decision.operation, stepIndex)
          if (gated !== null) return gated
        }
        if (needsLoginApproval(observation, decision, policy)) {
          const gated = await approvalGate('login', approvalContext, decision.operation, stepIndex)
          if (gated !== null) return gated
        }
        await executeNative(caller, params, observation, decision, signal, indicator)
        state.actionsExecuted += 1
        state.trace.push({
          snapshotId: observation.snapshot_id,
          operation: decision.operation,
          target: decision.target,
          dispatched: true,
        })
      } catch (error) {
        if (decision.operation === 'PASTE_TEXT' && isUncertainNativePaste(error)) {
          if (error instanceof Error && error.message.includes('PASTE_NOT_CONSUMED')) state.actionsExecuted += 1
          if (await verifyNative(caller, params, assertions, signal)) {
            state.status = 'success'
            state.reason = 'independently_verified_after_uncertain_paste'
          } else {
            state.route = 'human'
            state.reason = 'paste_outcome_unconfirmed'
          }
          return state
        }
        if (error instanceof Error && /STALE_SNAPSHOT|WINDOW_CHANGED/u.test(error.message)) {
          state.staleDecisions += 1
          if (state.actionsExecuted === 0 && skill.fallback === 'd1') {
            state.fallbackReason = 'stale_before_first_skill_action'
            return null
          }
          state.route = 'human'
          state.reason = 'stale_skill_snapshot'
          return state
        }
        throw error
      }

      const deadline = Date.now() + config.verificationTimeoutMs
      do {
        signal.throwIfAborted()
        const waitBudgetStop = budget?.checkClock()
        if (waitBudgetStop !== null && waitBudgetStop !== undefined) {
          state.reason = waitBudgetStop.reason
          return state
        }
        if (await verifyNative(caller, params, assertions, signal)) {
          state.status = 'success'
          state.reason = 'independently_verified_after_action'
          return state
        }
        if (Date.now() >= deadline) break
        await new Promise(resolve => setTimeout(resolve, 50))
      } while (true)

      const current = await readNativeState(caller, params, signal)
      if (hasPendingState(current)) {
        const asyncDeadline = Date.now() + config.asyncTimeoutMs
        do {
          signal.throwIfAborted()
          if (await verifyNative(caller, params, assertions, signal)) {
            state.status = 'success'
            state.reason = 'independently_verified_after_async_update'
            return state
          }
          const next = await readNativeState(caller, params, signal)
          if (!hasPendingState(next)) break
          if (Date.now() >= asyncDeadline) {
            state.route = 'human'
            state.reason = 'async_result_timeout'
            return state
          }
          await new Promise(resolve => setTimeout(resolve, 100))
        } while (true)
      }
    }
    // The final read races the application's AX update: a single sample can be
    // stale right after the last dispatched step. Keep sampling for the same
    // bounded window the per-step check uses instead of declaring failure on
    // the first miss.
    const finalDeadline = Date.now() + config.verificationTimeoutMs
    while (true) {
      signal.throwIfAborted()
      if (await verifyNative(caller, params, assertions, signal)) {
        state.status = 'success'
        state.reason = 'independently_verified_after_skill'
        return state
      }
      if (Date.now() >= finalDeadline) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    state.route = 'human'
    state.reason = 'skill_postcondition_failed'
    return state
  } catch (error) {
    if (error instanceof SkillError && error.allowD1Fallback && state.actionsExecuted === 0 && skill.fallback === 'd1') {
      state.fallbackReason = error.code
      return null
    }
    if (error instanceof SkillError) {
      state.route = 'human'
      state.reason = error.code
      return state
    }
    throw error
  }
}
