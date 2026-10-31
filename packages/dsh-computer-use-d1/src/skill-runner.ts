import { validateDecision } from '@albaincompleta/dsh-cu-core/actions'
import { checkPagePolicy, checkTargetAmbiguity, taskPolicySchema } from '@albaincompleta/dsh-cu-core/policy'
import { assertSkillScope, decisionForSkillStep, SkillError, verificationForSkill } from '@albaincompleta/dsh-cu-core/skills'
import type { VerifiedSkill } from '@albaincompleta/dsh-cu-core/skills'
import type { ComputerSubgoalInput, RunState } from './controller.ts'
import { executeNative, hasPendingState, isUncertainNativePaste, parseAxElements, readNativeState, verifyNative } from './controller.ts'
import type { NativeCaller } from './controller.ts'
import type { RunBudget } from '@albaincompleta/dsh-cu-core/budget'
import type { ActivitySink } from '@albaincompleta/dsh-cu-core/activity'
import type { ExecutionHandle } from '@albaincompleta/dsh-cu-core/run-controller'
import type { ResolvedConfig } from './config.ts'


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
): Promise<RunState | null> {
  assertSkillScope(skill, { windowTitle: selected.title, appBundleId })
  const policy = taskPolicySchema.parse({ ...args.policy, risk: skill.risk })
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
    if (await verifyNative(caller, params, assertions, signal)) {
      state.status = 'success'
      state.reason = 'independently_verified_after_skill'
    } else {
      state.route = 'human'
      state.reason = 'skill_postcondition_failed'
    }
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
