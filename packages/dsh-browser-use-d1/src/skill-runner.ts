import type { Page } from 'playwright'
import { uiStrings } from '@alyosha28/dsh-cu-core/locale'
import { validateDecision } from '@alyosha28/dsh-cu-core/actions'
import { checkPagePolicy, checkTargetAmbiguity, taskPolicySchema } from '@alyosha28/dsh-cu-core/policy'
import { assertSkillOrigin, decisionForSkillStep, SkillError, verificationForSkill } from '@alyosha28/dsh-cu-core/skills'
import type { SubgoalInput } from '@alyosha28/dsh-cu-core/contract'
import type { VerifiedSkill } from '@alyosha28/dsh-cu-core/skills'
import type { RunBudget } from '@alyosha28/dsh-cu-core/budget'
import type { ActivitySink } from '@alyosha28/dsh-cu-core/activity'
import type { ExecutionHandle } from '@alyosha28/dsh-cu-core/run-controller'
import type { ResolvedConfig } from './config.ts'
import type { RunState } from './controller.ts'
import { waitAfterAction } from './controller.ts'
import { BrowserDom, StaleSnapshot, verifyAll } from './dom.ts'


export async function runBrowserSkill(
  page: Page,
  skill: VerifiedSkill,
  args: SubgoalInput,
  config: ResolvedConfig,
  signal: AbortSignal,
  budget?: RunBudget,
  maxSteps?: number,
  indicator?: ActivitySink,
  execution?: ExecutionHandle,
): Promise<RunState | null> {
  const dom = new BrowserDom(page, 60, indicator, uiStrings(config.locale).panel.tabMark)
  const policy = taskPolicySchema.parse({ ...args.policy, risk: skill.risk })
  const state: RunState = {
    route: 'skill', skillId: skill.id, status: 'escalated', reason: 'skill_failed',
    decisionRequests: 0, modelForwardCalls: 0, textExtractionCalls: 0,
    actionsExecuted: 0, staleDecisions: 0, decisionLatencyMs: 0, inputTokens: 0, outputTokens: 0, trace: [],
  }
  try {
    const assertions = verificationForSkill(skill, args.inputs, args.verify)
    assertSkillOrigin(skill, page.url())
    if (await verifyAll(page, assertions)) {
      assertSkillOrigin(skill, page.url())
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
      assertSkillOrigin(skill, page.url())
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
          await page.waitForTimeout(slice)
          remaining -= slice
        }
        continue
      }
      await indicator?.activity({ phase: 'observing', step: stepIndex + 1, maxSteps, route: 'skill' })
      const observation = await dom.snapshot()
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
        await dom.execute(observation, decision, config.operationTimeoutMs)
        state.actionsExecuted += 1
        state.trace.push({
          snapshotId: observation.snapshot_id,
          operation: decision.operation,
          target: decision.target,
          dispatched: true,
          requestLatencyMs: 0,
        })
      } catch (error) {
        if (error instanceof StaleSnapshot) {
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
      const waitResult = await waitAfterAction(page, assertions, config, signal, decision.operation, budget)
      if (waitResult !== null) {
        if (waitResult.status === 'success') {
          assertSkillOrigin(skill, page.url())
          state.status = 'success'
          state.reason = waitResult.reason
        } else {
          state.route = 'human'
          state.reason = waitResult.reason
        }
        return state
      }
    }
    assertSkillOrigin(skill, page.url())
    if (await verifyAll(page, assertions)) {
      assertSkillOrigin(skill, page.url())
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
