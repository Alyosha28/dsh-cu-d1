import type { Page } from 'playwright'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { uiStrings } from '@albaincompleta/dsh-cu-core/locale'
import { validateDecision } from '@albaincompleta/dsh-cu-core/actions'
import { checkPagePolicy, checkTargetAmbiguity } from '@albaincompleta/dsh-cu-core/policy'
import type { TaskPolicy } from '@albaincompleta/dsh-cu-core/policy'
import {
  assertSkillOrigin, assertSkillProvider, decisionForSkillStep, skillPolicy,
  SkillError, verificationForSkill,
} from '@albaincompleta/dsh-cu-core/skills'
import {
  actionApprovalContext, needsConsequentialApproval, needsLoginApproval,
  requestConsequentialApproval, requestLoginApproval,
} from '@albaincompleta/dsh-cu-core/policy-approvals'
import type { ApprovalGateway } from '@albaincompleta/dsh-cu-core/approvals'
import type { SubgoalInput } from '@albaincompleta/dsh-cu-core/contract'
import type { VerifiedSkill } from '@albaincompleta/dsh-cu-core/skills'
import type { RunBudget } from '@albaincompleta/dsh-cu-core/budget'
import type { ActivitySink } from '@albaincompleta/dsh-cu-core/activity'
import type { ExecutionHandle } from '@albaincompleta/dsh-cu-core/run-controller'
import type { ResolvedConfig } from './config.ts'
import type { RunState } from './controller.ts'
import { waitAfterAction } from './controller.ts'
import { BrowserDom, StaleSnapshot, verifyAll } from './dom.ts'


/** Provider-config fields this runner reads; added to `Config` by the provider owner. */
interface PolicyConfigFields {
  minRisk?: TaskPolicy['risk']
  preauthorizeConsequential?: boolean
  preauthorizeLogin?: boolean
}

/**
 * Refuses a Skill whose match scope belongs to the native provider (CR-03).
 *
 * `selectSkill` resolves a `skillId` before any replay starts, so a native-only
 * Skill is rejected by the same code path whether it was requested explicitly or
 * picked from a store listing.
 */
export function assertBrowserReplayable(skill: VerifiedSkill): void {
  assertSkillProvider(skill, 'browser')
}

/**
 * Replays a verified Skill through exactly the gates the D1 loop uses.
 *
 * A published Skill is a saved decision, not a standing exemption: every
 * non-wait step still asks for consequential and credential approval, the
 * effective risk is the maximum of the caller's request, the Skill's own risk
 * and the provider floor, a missing approval channel fails closed with zero
 * actions, and a Skill scoped to a native window or application never replays
 * inside a browser (BR-03 / CR-01 / CR-03).
 */
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
  approvals?: ApprovalGateway,
): Promise<RunState | null> {
  const dom = new BrowserDom(page, 60, indicator, uiStrings(config.locale).panel.tabMark)
  const policyConfig = config as ResolvedConfig & PolicyConfigFields
  const approvalLabels = uiStrings(config.locale).approvals
  const state: RunState = {
    route: 'skill', skillId: skill.id, status: 'escalated', reason: 'skill_failed',
    decisionRequests: 0, modelForwardCalls: 0, textExtractionCalls: 0,
    actionsExecuted: 0, staleDecisions: 0, decisionLatencyMs: 0, inputTokens: 0, outputTokens: 0, trace: [],
  }
  // A Skill whose match scope belongs to the native provider can never run here,
  // and a contradictory risk declaration is refused before any action.
  let policy: TaskPolicy
  try {
    assertSkillProvider(skill, 'browser')
    policy = skillPolicy(args.policy, skill, {
      ...policyConfig.minRisk === undefined ? {} : { minRisk: policyConfig.minRisk },
      ...policyConfig.preauthorizeConsequential === undefined ? {} : { preauthorizeConsequential: policyConfig.preauthorizeConsequential },
      ...policyConfig.preauthorizeLogin === undefined ? {} : { preauthorizeLogin: policyConfig.preauthorizeLogin },
    })
  } catch (error) {
    if (error instanceof SkillError) {
      state.route = 'human'
      state.reason = error.code
      return state
    }
    throw error
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
      // Re-checked per step: a Skill cannot outgrow its provider scope mid-run.
      assertSkillProvider(skill, 'browser')
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
        // Same two gates as the D1 loop (CR-01). They run after pause/admission
        // and immediately before dispatch, so a cancelled or stopped run never
        // reaches a prompt and a human never approves a stale action.
        signal.throwIfAborted()
        const approvalContext = actionApprovalContext(observation, decision)
        if (needsConsequentialApproval(policy)) {
          if (execution === undefined || approvals === undefined) {
            state.status = 'confirmation_required'
            state.reason = 'approval_unavailable'
            return state
          }
          await indicator?.activity({
            phase: 'awaiting_approval', operation: decision.operation, step: stepIndex + 1, maxSteps, route: 'skill',
          })
          const approval = await requestConsequentialApproval(
            execution.agent as Agent, approvals, approvalContext, approvalLabels, signal,
          )
          if (!approval.approved) {
            state.status = 'confirmation_required'
            state.reason = approval.reason ?? 'consequential_action_requires_approval'
            return state
          }
        }
        if (needsLoginApproval(observation, decision, policy)) {
          if (execution === undefined || approvals === undefined) {
            state.status = 'confirmation_required'
            state.reason = 'approval_unavailable'
            return state
          }
          await indicator?.activity({
            phase: 'awaiting_approval', operation: decision.operation, step: stepIndex + 1, maxSteps, route: 'skill',
          })
          const approval = await requestLoginApproval(
            execution.agent as Agent, approvals, approvalContext, approvalLabels, signal,
          )
          if (!approval.approved) {
            state.status = 'confirmation_required'
            state.reason = approval.reason ?? 'login_requires_approval'
            return state
          }
        }
        // The approval covered one action: re-check that the run was not paused,
        // stopped, cancelled, or re-pointed while the human was reading.
        signal.throwIfAborted()
        const postApprovalPause = await execution?.waitWhilePaused(signal)
        if (postApprovalPause !== null && postApprovalPause !== undefined) {
          state.status = postApprovalPause.status
          state.reason = postApprovalPause.reason
          return state
        }
        const postApprovalStop = execution?.admit()
        if (postApprovalStop !== null && postApprovalStop !== undefined) {
          state.status = postApprovalStop.status
          state.reason = postApprovalStop.reason
          return state
        }
        assertSkillOrigin(skill, page.url())
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
