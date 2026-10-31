import type { Page } from 'playwright'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ResolvedConfig } from './config.ts'
import type { D1DecisionClient } from './decision.ts'
import {
  assertSupportedAssertions,
  BrowserDom,
  hasPendingUi,
  navigationUrl,
  StaleSnapshot,
  validateDecision,
  verifyAll,
} from './dom.ts'
import { checkPagePolicy, checkTargetAmbiguity, taskPolicySchema } from './policy.ts'
import { selectSkill, SkillError } from '@alyosha28/dsh-cu-core/skills'
import type { SkillStore } from '@alyosha28/dsh-cu-core/skill-store'
import { runBrowserSkill } from './skill-runner.ts'
import { createCandidateFromTrajectory } from '@alyosha28/dsh-cu-core/skill-builder'
import type { CapturedInput } from '@alyosha28/dsh-cu-core/skill-builder'
import type { ExecutionHandle } from '@alyosha28/dsh-cu-core/run-controller'
import type { ApprovalGateway } from '@alyosha28/dsh-cu-core/approvals'
import {
  actionApprovalContext, needsConsequentialApproval, needsLoginApproval,
  requestConsequentialApproval, requestLoginApproval,
} from '@alyosha28/dsh-cu-core/policy-approvals'
import { uiStrings } from '@alyosha28/dsh-cu-core/locale'
import { RunBudget } from '@alyosha28/dsh-cu-core/budget'
import { randomUUID } from 'node:crypto'
import type { ActivitySink } from '@alyosha28/dsh-cu-core/activity'
import type { BrowserRunIndicator } from './indicator.ts'
import type { RunOutcome } from './indicator.ts'


import { subgoalInput } from '@alyosha28/dsh-cu-core/contract'
import type { RunStatus, SubgoalInput } from '@alyosha28/dsh-cu-core/contract'

export { subgoalInput } from '@alyosha28/dsh-cu-core/contract'
export type { SubgoalInput } from '@alyosha28/dsh-cu-core/contract'

interface TraceEntry {
  [key: string]: unknown
  snapshotId: string
  operation: string
  target: string | null
  targetName?: string
  origin?: string
  confidence?: number
  requestLatencyMs: number
  dispatched: boolean
  stale?: string
}

export interface RunState {
  route: 'skill' | 'd1' | 'human'
  skillId?: string
  fallbackReason?: string
  candidateId?: string
  evolvedFromSkillId?: string
  status: RunStatus
  reason: string
  details?: Record<string, unknown>
  decisionRequests: number
  modelForwardCalls: number
  textExtractionCalls: number
  actionsExecuted: number
  staleDecisions: number
  decisionLatencyMs: number
  inputTokens: number
  outputTokens: number
  trace: TraceEntry[]
}

const captureInputs = new WeakMap<RunState, CapturedInput[]>()

async function runBrowserSubgoalInner(
  page: Page,
  client: D1DecisionClient,
  config: ResolvedConfig,
  rawArgs: unknown,
  signal: AbortSignal,
  skillStore?: SkillStore,
  execution?: ExecutionHandle,
  approvals?: ApprovalGateway,
  indicator?: ActivitySink,
): Promise<RunState> {
  const args = subgoalInput.parse(rawArgs)
  assertSupportedAssertions(args.verify)
  const policy = taskPolicySchema.parse(args.policy ?? {})
  const activeSignal = execution === undefined ? signal : AbortSignal.any([signal, execution.signal])
  const state: RunState = {
    status: 'escalated', reason: 'step_budget_exhausted', decisionRequests: 0,
    route: 'd1',
    modelForwardCalls: 0, textExtractionCalls: 0, actionsExecuted: 0,
    staleDecisions: 0, decisionLatencyMs: 0, inputTokens: 0, outputTokens: 0, trace: [],
  }
  captureInputs.set(state, [])
  try {
  const budget = new RunBudget({
    maxWallClockMs: config.maxWallClockMs,
    maxInputTokens: config.maxInputTokens,
    maxOutputTokens: config.maxOutputTokens,
  })
  const approvalLabels = uiStrings(config.locale).approvals
  if (args.url !== undefined) {
    activeSignal.throwIfAborted()
    await page.goto(navigationUrl(args.url), {
      waitUntil: 'domcontentloaded', timeout: config.operationTimeoutMs,
    })
  }
  const dom = new BrowserDom(page, 60, indicator, uiStrings(config.locale).panel.tabMark)
  try {
    const skill = await selectSkill({ ...args, url: page.url() }, skillStore)
    if (skill !== null) {
      const result = await runBrowserSkill(
        page, skill, args, config, activeSignal, budget, Math.min(args.maxSteps ?? config.maxSteps, config.maxSteps), indicator, execution,
      )
      if (result !== null) {
        const budgetStop = result.status === 'success' ? budget.checkClock() : null
        if (budgetStop !== null) {
          result.status = budgetStop.status
          result.reason = budgetStop.reason
        }
        return result
      }
      state.fallbackReason = 'skill_fallback'
      if (skillStore !== undefined && await skillStore.get(skill.id) !== undefined) {
        state.evolvedFromSkillId = skill.id
      }
    }
  } catch (error) {
    if (error instanceof SkillError) {
      state.route = 'human'
      state.reason = error.code
      return state
    }
    throw error
  }
  const maxSteps = Math.min(args.maxSteps ?? config.maxSteps, config.maxSteps)
  let previousFingerprint: string | undefined
  let repeated = 0

  for (let step = 0; step < maxSteps; step += 1) {
    activeSignal.throwIfAborted()
    const pausedStop = await execution?.waitWhilePaused(activeSignal)
    if (pausedStop !== null && pausedStop !== undefined) {
      state.status = pausedStop.status
      state.reason = pausedStop.reason
      return state
    }
    if (execution !== undefined) budget.creditPaused(execution.pausedMs())
    const admissionStop = execution?.admit()
    if (admissionStop !== null && admissionStop !== undefined) {
      state.status = admissionStop.status
      state.reason = admissionStop.reason
      return state
    }
    if (await verifyAll(page, args.verify)) {
      state.status = 'success'
      state.reason = 'independently_verified'
      return state
    }
    const budgetStop = budget.checkBeforeDecision()
    if (budgetStop !== null) {
      state.reason = budgetStop.reason
      return state
    }
    await indicator?.activity({ phase: 'observing', step: step + 1, maxSteps, route: 'd1' })
    const observation = await dom.snapshot()
    const policyStop = checkPagePolicy(observation, policy)
    if (policyStop !== null) {
      state.status = policyStop.status
      state.reason = policyStop.reason
      if (policyStop.details !== undefined) state.details = policyStop.details
      return state
    }
    await indicator?.activity({ phase: 'deciding', step: step + 1, maxSteps, route: 'd1' })
    const response = await client.decide(args.goal, observation, activeSignal, args.inputs)
    state.decisionRequests += 1
    const modelBudgetStop = budget.consume(response.usage.input_tokens, response.usage.output_tokens)
    state.modelForwardCalls += 1 + response.textExtractionCalls
    state.textExtractionCalls += response.textExtractionCalls
    state.decisionLatencyMs += response.latencyMs
    state.inputTokens += response.usage.input_tokens
    state.outputTokens += response.usage.output_tokens
    if (modelBudgetStop !== null) {
      state.reason = modelBudgetStop.reason
      return state
    }
    const decision = response.decision
    validateDecision(observation, decision)
    const ambiguityStop = checkTargetAmbiguity(observation, decision, args.goal)
    if (ambiguityStop !== null) {
      state.status = ambiguityStop.status
      state.reason = ambiguityStop.reason
      if (ambiguityStop.details !== undefined) state.details = ambiguityStop.details
      return state
    }
    const targetName = observation.elements.find(element => element.id === decision.target)?.identifier
      ?? observation.elements.find(element => element.id === decision.target)?.name
    const entry: TraceEntry = {
      snapshotId: observation.snapshot_id,
      operation: decision.operation,
      target: decision.target,
      ...targetName === undefined ? {} : { targetName },
      origin: new URL(observation.url).origin,
      ...decision.confidence === undefined ? {} : { confidence: decision.confidence },
      requestLatencyMs: response.latencyMs,
      dispatched: false,
    }
    state.trace.push(entry)

    if (decision.operation === 'DONE') {
      if (await verifyAll(page, args.verify)) {
        state.status = 'success'
        state.reason = 'independently_verified'
      } else state.reason = 'premature_done_rejected_by_verifier'
      return state
    }
    if (decision.operation === 'BLOCKED') {
      state.status = 'blocked'
      state.reason = 'decision_model_selected_blocked'
      return state
    }

    const approvalContext = actionApprovalContext(observation, decision)
    if (needsConsequentialApproval(policy)) {
      if (execution === undefined) {
        state.status = 'confirmation_required'
        state.reason = 'approval_unavailable'
        return state
      }
      await indicator?.activity({
        phase: 'awaiting_approval', operation: decision.operation, step: step + 1, maxSteps, route: 'd1',
      })
      const approval = await requestConsequentialApproval(
        execution.agent, approvals, approvalContext, approvalLabels, activeSignal,
      )
      if (!approval.approved) {
        state.status = 'confirmation_required'
        state.reason = approval.reason ?? 'consequential_action_requires_approval'
        return state
      }
    }
    if (needsLoginApproval(observation, decision, policy)) {
      if (execution === undefined) {
        state.status = 'confirmation_required'
        state.reason = 'approval_unavailable'
        return state
      }
      await indicator?.activity({
        phase: 'awaiting_approval', operation: decision.operation, step: step + 1, maxSteps, route: 'd1',
      })
      const approval = await requestLoginApproval(
        execution.agent, approvals, approvalContext, approvalLabels, activeSignal,
      )
      if (!approval.approved) {
        state.status = 'confirmation_required'
        state.reason = approval.reason ?? 'login_requires_approval'
        return state
      }
    }

    const fingerprint = JSON.stringify([
      observation.url, observation.elements, decision.operation, decision.target, decision.text,
    ])
    repeated = fingerprint === previousFingerprint ? repeated + 1 : 0
    previousFingerprint = fingerprint
    if (repeated >= 2) {
      state.reason = 'no_progress_same_decision_repeated'
      return state
    }
    const preActionPause = await execution?.waitWhilePaused(activeSignal)
    if (preActionPause !== null && preActionPause !== undefined) {
      state.status = preActionPause.status
      state.reason = preActionPause.reason
      return state
    }
    if (execution !== undefined) budget.creditPaused(execution.pausedMs())
    const actionStop = execution?.admit()
    if (actionStop !== null && actionStop !== undefined) {
      state.status = actionStop.status
      state.reason = actionStop.reason
      return state
    }
    const actionBudgetStop = budget.checkClock()
    if (actionBudgetStop !== null) {
      state.reason = actionBudgetStop.reason
      return state
    }

    try {
      await dom.execute(observation, decision, config.operationTimeoutMs)
      state.actionsExecuted += 1
      entry.dispatched = true
      if (decision.operation === 'TYPE_TEXT' && targetName !== undefined && decision.text !== undefined) {
        captureInputs.get(state)!.push({ targetName, value: decision.text })
      }
    } catch (error) {
      if (error instanceof StaleSnapshot) {
        state.staleDecisions += 1
        entry.stale = error.message
        continue
      }
      throw error
    }

  const waitResult = await waitAfterAction(page, args.verify, config, activeSignal, decision.operation, budget)
    if (waitResult !== null) {
      state.status = waitResult.status
      state.reason = waitResult.reason
      return state
    }
  }
  return state
  } catch (error) {
    const controlStop = execution?.admit()
    if (controlStop !== null && controlStop !== undefined) {
      state.status = controlStop.status
      state.reason = controlStop.reason
      return state
    }
    throw error
  }
}

export async function runBrowserSubgoal(
  page: Page,
  client: D1DecisionClient,
  config: ResolvedConfig,
  rawArgs: unknown,
  signal: AbortSignal,
  skillStore?: SkillStore,
  execution?: ExecutionHandle,
  approvals?: ApprovalGateway,
  indicator?: BrowserRunIndicator,
): Promise<RunState> {
  await indicator?.start(execution?.id || randomUUID())
  try {
    const result = await runBrowserSubgoalInner(page, client, config, rawArgs, signal, skillStore, execution, approvals, indicator)
    if (config.captureSkills && skillStore !== undefined && result.route === 'd1' && result.status === 'success') {
      const args = subgoalInput.parse(rawArgs)
      if (args.url !== undefined) {
        const captureUrl = new URL(page.url())
        const origins = new Set(result.trace.map(step => step.origin).filter(origin => origin !== undefined))
        if (origins.size === 1 && origins.has(captureUrl.origin)) {
          await createCandidateFromTrajectory(skillStore, {
            route: result.route,
            status: result.status,
            trace: result.trace,
            verify: args.verify,
            inputs: args.inputs,
            capturedValues: captureInputs.get(result),
            match: { urlPath: captureUrl.pathname, origin: captureUrl.origin },
            risk: args.policy?.risk,
            evolveFrom: result.evolvedFromSkillId,
          }).then(candidate => { if (candidate !== undefined) result.candidateId = candidate.id })
        }
      }
    }
    captureInputs.delete(result)
    await indicator?.finish(outcome(result))
    return result
  } catch (error) {
    await indicator?.finish({ status: 'failed', reason: 'tool_execution_failed' })
    throw error
  }
}

function outcome(result: RunState): RunOutcome {
  return {
    status: result.status,
    reason: result.reason,
    ...result.route === undefined ? {} : { route: result.route },
  }
}

export interface BrowserObserveResult {
  status: 'success' | 'paused' | 'stopped' | 'takeover'
  reason: string
  observation?: import('@alyosha28/dsh-cu-core/types').Observation
}

/** Reads the owned page for the caller without invoking D1 or dispatching input. */
export async function runBrowserObserve(
  page: Page,
  execution?: ExecutionHandle,
  tabMark = '',
): Promise<BrowserObserveResult> {
  const control = execution?.admit()
  if (control !== null && control !== undefined) return { status: control.status, reason: control.reason }
  const observation = await new BrowserDom(page, 60, undefined, tabMark).snapshot()
  const after = execution?.admit()
  if (after !== null && after !== undefined) return { status: after.status, reason: after.reason }
  return { status: 'success', reason: 'observed', observation }
}

export async function waitAfterAction(
  page: Page,
  assertions: Parameters<typeof verifyAll>[1],
  config: ResolvedConfig,
  signal: AbortSignal,
  operation?: string,
  budget?: RunBudget,
): Promise<{ status: 'success' | 'escalated'; reason: string } | null> {
  const shortTimeout = operation === 'TYPE_TEXT' || operation === 'INCREMENT' || operation === 'DECREMENT'
    ? Math.min(100, config.verificationTimeoutMs)
    : config.verificationTimeoutMs
  const shortDeadline = Date.now() + shortTimeout
  do {
    signal.throwIfAborted()
    const budgetStop = budget?.checkClock()
    if (budgetStop !== null && budgetStop !== undefined) return budgetStop
    if (await verifyAll(page, assertions)) {
      return { status: 'success', reason: 'independently_verified_after_action' }
    }
    if (Date.now() >= shortDeadline) break
    await page.waitForTimeout(50)
  } while (true)

  if (!await hasPendingUi(page)) return null
  const asyncDeadline = Date.now() + config.asyncTimeoutMs
  do {
    signal.throwIfAborted()
    const budgetStop = budget?.checkClock()
    if (budgetStop !== null && budgetStop !== undefined) return budgetStop
    if (await verifyAll(page, assertions)) {
      return { status: 'success', reason: 'independently_verified_after_async_update' }
    }
    if (!await hasPendingUi(page)) return null
    if (Date.now() >= asyncDeadline) return { status: 'escalated', reason: 'async_result_timeout' }
    await page.waitForTimeout(100)
  } while (true)
}
