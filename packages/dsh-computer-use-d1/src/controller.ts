import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { validateDecision } from '@albaincompleta/dsh-cu-core/actions'
import { subgoalInput } from '@albaincompleta/dsh-cu-core/contract'
import type { RunStatus, Verification } from '@albaincompleta/dsh-cu-core/contract'
import type { D1DecisionClient } from '@albaincompleta/dsh-cu-core/decision'
import { checkPagePolicy, checkTargetAmbiguity, resolvePolicy } from '@albaincompleta/dsh-cu-core/policy'
import { selectSkill, SkillError } from '@albaincompleta/dsh-cu-core/skills'
import type { SkillStore } from '@albaincompleta/dsh-cu-core/skill-store'
import type { Decision, Observation } from '@albaincompleta/dsh-cu-core/types'
import { z } from 'zod'
import {
  EMPTY_VERIFICATION_REGISTRY, evaluateNativeVerification, parseAxElements,
  type NativeVerificationRegistry, type NativeVerificationResult, type WindowRect,
} from './verification.ts'
export { parseAxElements, visibleAxText } from './verification.ts'
export type { NativeVerificationRegistry } from './verification.ts'
import { createCandidateFromTrajectory } from '@albaincompleta/dsh-cu-core/skill-builder'
import type { ExecutionHandle } from '@albaincompleta/dsh-cu-core/run-controller'
import type { ApprovalGateway } from '@albaincompleta/dsh-cu-core/approvals'
import {
  actionApprovalContext, needsConsequentialApproval, needsLoginApproval,
  requestConsequentialApproval, requestLoginApproval,
} from '@albaincompleta/dsh-cu-core/policy-approvals'
import { uiStrings } from '@albaincompleta/dsh-cu-core/locale'
import { RunBudget } from '@albaincompleta/dsh-cu-core/budget'
import type { CapturedInput, TrajectoryStep } from '@albaincompleta/dsh-cu-core/skill-builder'
import type { ResolvedConfig } from './config.ts'
import { permissionSettingsUrl, requestPermission, type PermissionKind } from './permissions.ts'
import type { ActivitySink } from '@albaincompleta/dsh-cu-core/activity'
import type { NativeIndicator, NativeRunOutcome } from './indicator.ts'


export const computerSubgoalInput = subgoalInput.extend({
  app: z.string().min(1).describe('Application name, bundle id, executable path, or running pid.'),
  windowId: z.number().int().positive().optional().describe('Exact window id when the application has several windows.'),
}).strict()
export type ComputerSubgoalInput = z.infer<typeof computerSubgoalInput>

export interface RunState {
  route: 'skill' | 'd1' | 'human'
  skillId?: string
  fallbackReason?: string
  windowTitle?: string
  appBundleId?: string
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
  trace: TrajectoryStep[]
}

const captureInputs = new WeakMap<RunState, CapturedInput[]>()

/** One privacy dialog per permission per process: macOS only shows it once. */
const promptedPermissions = new Set<PermissionKind>()

async function promptMissingPermission(
  config: ResolvedConfig,
  kind: PermissionKind,
): Promise<{ prompted: boolean; settingsUrl: string }> {
  const settingsUrl = permissionSettingsUrl(kind)
  if (config.promptPermissions !== true || promptedPermissions.has(kind)) {
    return { prompted: promptedPermissions.has(kind), settingsUrl }
  }
  promptedPermissions.add(kind)
  try {
    await requestPermission(kind)
    return { prompted: true, settingsUrl }
  } catch {
    return { prompted: false, settingsUrl }
  }
}



export class NativeCaller {
  constructor(private readonly ctx: Context, private readonly agent: Agent) {}

  async call(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<any> {
    if (process.env.DEBUG_CUA === '1') console.error('CUA_CALL', method, JSON.stringify({ parameterKeys: Object.keys(params).sort() }))
    const result = await this.ctx.tools.execute({
      callId: ToolCallId(randomUUID()),
      name: 'cua',
      arguments: { method, params },
      agent: this.agent,
      signal,
    })
    if (result.isError) {
      const content = result.content as Array<{ type: string; text?: string }>
      const raw = content.map(block => block.text ?? '').filter(Boolean).join('\n')
      let message = raw
      try {
        const parsed = JSON.parse(raw) as { code?: unknown; message?: unknown; error?: unknown }
        const detail = typeof parsed.message === 'string' ? parsed.message : typeof parsed.error === 'string' ? parsed.error : undefined
        if (detail !== undefined) message = detail
        if (typeof parsed.code === 'string') message = `${parsed.code}: ${message}`
      } catch {
        // Keep the textual CUA diagnostic when it is not JSON.
      }
      throw new Error(message.trim().slice(0, 500) || `CUA ${method} failed`)
    }
    return result.value
  }
}

const maxObservationAttempts = 3

/** Re-read only failed AX observations; native input is never replayed here. */
export async function readNativeState(
  caller: NativeCaller,
  params: Record<string, unknown>,
  signal: AbortSignal,
): Promise<any> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await caller.call('getState', params, signal)
    } catch (error) {
      const stale = error instanceof Error && error.message.includes('STALE_SNAPSHOT')
      if (!stale || attempt === maxObservationAttempts) throw error
      if (process.env.DEBUG_CUA === '1') console.error('CUA_OBSERVATION_RETRY', attempt)
    }
  }
}

export async function getNativeApp(caller: NativeCaller, selector: string, signal: AbortSignal): Promise<any> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await caller.call('getApp', { selector }, signal)
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('STALE_APP')) || attempt === 2) throw error
    }
  }
}

function observationFromState(state: any, window: any, screenshot?: any): Observation {
  const elements = parseAxElements(state.tree, window)
  return {
    snapshot_id: state.snapshotId,
    version: 0,
    url: `app://${state.pid}/${window.windowId}`,
    title: window.title ?? '',
    truncated: Boolean(state.truncated),
    can_scroll_up: elements.some(element => element.actions.includes('AXScrollUpByPage')),
    can_scroll_down: elements.some(element => element.actions.includes('AXScrollDownByPage')),
    ...window.bounds === undefined ? {} : { windowBounds: window.bounds },
    elements,
    ...screenshot === undefined ? {} : {
      screenshot: {
        bounds: screenshot.bounds,
        pixelWidth: screenshot.pixelWidth,
        pixelHeight: screenshot.pixelHeight,
        windowId: screenshot.windowId,
        coordinateSpace: screenshot.coordinateSpace,
      },
    },
  }
}

/**
 * Evaluates the assertions against one fresh AX read.
 *
 * The provider owns the read: the caller supplies assertions only, and the
 * window is the one this run selected. Evidence for every assertion is returned
 * so a failure can name the element that was (not) found.
 */
export async function verifyNativeDetailed(
  caller: NativeCaller,
  params: Record<string, unknown>,
  assertions: Verification[],
  signal: AbortSignal,
  registry: NativeVerificationRegistry = EMPTY_VERIFICATION_REGISTRY,
): Promise<NativeVerificationResult> {
  try {
    const state = await readNativeState(caller, params, signal)
    const selectedId = typeof params.windowId === 'number'
      ? params.windowId
      : typeof state?.focusedWindowId === 'number' ? state.focusedWindowId : null
    const window = Array.isArray(state?.windows)
      ? state.windows.find((entry: any) => entry?.windowId === selectedId)
      : undefined
    const customArgs: Record<string, Record<string, unknown>> = {}
    for (const assertion of assertions) {
      if (assertion.type === 'custom') {
        customArgs[assertion.name] = assertion.args === undefined
          ? {}
          : assertion.args as Record<string, unknown>
      }
    }
    return await evaluateNativeVerification({
      tree: typeof state?.tree === 'string' ? state.tree : '',
      pid: typeof state?.pid === 'number' ? state.pid : -1,
      windowId: selectedId,
      window,
      assertions,
      registry,
      caller,
      signal,
      customArgs,
      params,
    })
  } catch (error) {
    if (process.env.DEBUG_CUA === '1') console.error('CUA_VERIFY_ERROR', error instanceof Error ? error.name : 'Error')
    return {
      ok: false, reason: 'verification_state_unavailable',
      evidence: { pid: -1, windowId: null, geometry: 'structural', assertions: [] },
    }
  }
}

/** Boolean view of {@link verifyNativeDetailed}; kept for the Skill route. */
export async function verifyNative(
  caller: NativeCaller,
  params: Record<string, unknown>,
  assertions: Verification[],
  signal: AbortSignal,
  registry?: NativeVerificationRegistry,
): Promise<boolean> {
  return (await verifyNativeDetailed(caller, params, assertions, signal, registry)).ok
}

/** Hard cap on how long one step may wait for a pending indicator. */
export const PENDING_PROBE_MAX_MS = 1500
/** Hard cap on how many AX reads one pending wait may perform. */
export const PENDING_PROBE_MAX_READS = 8

/**
 * True only for structural "still working" evidence.
 *
 * The previous implementation matched free text anywhere in the tree, so an
 * application that merely displays the word "Waiting" (a chat transcript, a log
 * window, a document) kept every step blocked until the async budget expired.
 * Pending work is now recognised by a progress/busy indicator, never by content.
 */
export function hasPendingState(state: any): boolean {
  const tree = typeof state?.tree === 'string' ? state.tree : ''
  return /(?:^|\s)-(?:\s*\[\d+\])?\s+(?:AX)?(?:ProgressIndicator|BusyIndicator)(?=\s|$)/u.test(tree)
    || /(?:^|\s)(?:AX)?busy=(?:"?true"?|1)(?=\s|$)/iu.test(tree)
}

async function runComputerSubgoalInner(
  caller: NativeCaller,
  decisionClient: D1DecisionClient,
  config: ResolvedConfig,
  rawArgs: unknown,
  parentSignal: AbortSignal,
  skillStore?: SkillStore,
  execution?: ExecutionHandle,
  approvals?: ApprovalGateway,
  indicator?: NativeIndicator,
  verifier: NativeVerificationRegistry = EMPTY_VERIFICATION_REGISTRY,
): Promise<RunState> {
  const args = computerSubgoalInput.parse(rawArgs)
  // The model may only raise the risk; pre-authorization is host configuration.
  const policy = resolvePolicy(args.policy, {
    minRisk: config.minRisk,
    preauthorizeConsequential: config.preauthorizeConsequential,
    preauthorizeLogin: config.preauthorizeLogin,
  })
  const signal = execution === undefined ? parentSignal : AbortSignal.any([parentSignal, execution.signal])
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
  const capabilities = await caller.call('getCapabilities', {}, signal)
  const screenRecording = capabilities.permissions?.screenRecording !== false
  if (capabilities.sessionLocked === true) {
    state.reason = 'session_locked'
    state.details = { permission: 'session', recovery: 'Unlock macOS, then read fresh state before continuing.' }
    return state
  }
  if (capabilities.permissions?.accessibility !== true) {
    const prompt = await promptMissingPermission(config, 'accessibility')
    state.reason = 'accessibility_permission_required'
    state.details = {
      permission: 'accessibility',
      recovery: prompt.prompted
        ? 'A macOS dialog asked for Accessibility. Allow the host application in System Settings, then restart it and retry.'
        : 'Open System Settings and allow Accessibility for the host application, then restart it and retry.',
      settingsUrl: prompt.settingsUrl,
      prompted: prompt.prompted,
    }
    return state
  }
  const app = await getNativeApp(caller, args.app, signal)
  if (app.bundleId !== undefined) state.appBundleId = app.bundleId
  const owner = { appHandle: app.appHandle }
  const windows = (await caller.call('listWindows', owner, signal)).filter((window: any) => window.isOnScreen)
  let selected = args.windowId === undefined
    ? windows.length === 1 ? windows[0] : undefined
    : windows.find((window: any) => window.windowId === args.windowId)
  if (selected === undefined && args.windowId === undefined && windows.length > 1 && execution !== undefined) {
    const options = windows.map((window: any) => `${window.title || 'Window'} (${window.windowId})`)
    const choice = await approvals?.select(execution.agent, {
      id: 'dsh-cu-window', question: approvalLabels.windowQuestion, detail: approvalLabels.windowDetail, options,
    }, signal)
    if (choice?.selected !== undefined) {
      const index = options.indexOf(choice.selected)
      if (index >= 0) selected = windows[index]
    }
  }
  if (selected === undefined) {
    state.reason = windows.length === 0 ? 'window_unavailable' : 'window_selection_required'
    state.details = {
      windows: windows.map((window: any) => ({ windowId: window.windowId, title: window.title })),
      recovery: windows.length === 0
        ? 'Open or restore a window for this application, then retry with the same application.'
        : 'Provide windowId from this list; the run will use only that window.',
    }
    return state
  }
  const params = { ...owner, windowId: selected.windowId, details: true }
  state.windowTitle = selected.title ?? ''
  if (indicator !== undefined) {
    if (!Number.isInteger(app.pid)) throw new Error('native_indicator_pid_unavailable')
    await indicator.start(execution?.id || randomUUID(), {
      pid: app.pid,
      windowId: selected.windowId,
      title: state.windowTitle ?? '',
      appName: app.name ?? args.app,
      bounds: selected.bounds,
    })
  }
  try {
    const skill = await selectSkill(args, skillStore)
    if (skill !== null) {
      const { runNativeSkill } = await import('./skill-runner.ts')
      const result = await runNativeSkill(
        caller, skill, args, selected, params, config, signal, app.bundleId,
        budget, Math.min(args.maxSteps ?? config.maxSteps, config.maxSteps), indicator, execution, approvals,
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
    signal.throwIfAborted()
    const pausedStop = await execution?.waitWhilePaused(signal)
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
    if (await verifyNative(caller, params, args.verify, signal, verifier)) {
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
    const nativeState = await readNativeState(caller, params, signal)
    if (process.env.DEBUG_CUA === '1') console.error('CUA_STATE', JSON.stringify({
      snapshotId: nativeState.snapshotId, windows: nativeState.windows?.length ?? 0, truncated: Boolean(nativeState.truncated),
    }))
    const observation = observationFromState(nativeState, selected)
    const policyStop = checkPagePolicy(observation, policy)
    if (policyStop !== null) {
      state.status = policyStop.status
      state.reason = policyStop.reason
      if (policyStop.details !== undefined) state.details = policyStop.details
      return state
    }
    let screenshotInput: { data: string; mimeType: string } | undefined
    const writableAx = observation.elements.filter(element =>
      element.enabled && (element.actions.includes('type') || element.actions.includes('paste')))
    const hasWritableAx = writableAx.some(element => /TextArea|TextView|Document/iu.test(element.role)) || writableAx.length === 1
    if (!hasWritableAx) {
      if (!screenRecording) {
        const prompt = await promptMissingPermission(config, 'screenRecording')
        state.reason = 'screen_recording_permission_required'
        state.details = {
          permission: 'screenRecording',
          recovery: prompt.prompted
            ? 'A macOS dialog asked for Screen Recording. Allow the host application in System Settings, then restart it and retry.'
            : 'Open System Settings and allow Screen Recording for the host application, then restart it and retry.',
          settingsUrl: prompt.settingsUrl,
          prompted: prompt.prompted,
        }
        return state
      }
      let screenshot: any
      try {
        screenshot = await caller.call('screenshot', { appHandle: params.appHandle, windowId: selected.windowId }, signal)
      } catch (error) {
        if (error instanceof Error && /PERMISSION_DENIED|SCREEN_CAPTURE/u.test(error.message)) {
          const prompt = await promptMissingPermission(config, 'screenRecording')
          state.reason = 'screen_recording_permission_required'
          state.details = {
            permission: 'screenRecording',
            recovery: prompt.prompted
              ? 'A macOS dialog asked for Screen Recording. Allow the host application in System Settings, then restart it and retry.'
              : 'Open System Settings and allow Screen Recording for the host application, then restart it and retry.',
            settingsUrl: prompt.settingsUrl,
            prompted: prompt.prompted,
          }
          return state
        }
        throw error
      }
      observation.screenshot = {
        bounds: screenshot.bounds,
        pixelWidth: screenshot.pixelWidth,
        pixelHeight: screenshot.pixelHeight,
        windowId: screenshot.windowId,
        coordinateSpace: screenshot.coordinateSpace,
      }
      screenshotInput = { data: screenshot.data, mimeType: screenshot.mimeType }
    }
    await indicator?.activity({ phase: 'deciding', step: step + 1, maxSteps, route: 'd1' })
    const response = await decisionClient.decide(args.goal, observation, signal, args.inputs, screenshotInput)
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
    // `name` is null at runtime for elements without an accessible name.
    const target = observation.elements.find(element => element.id === decision.target)
    const targetName = target?.name ?? target?.identifier ?? undefined
    const targetIdentifier = target?.identifier ?? undefined
    state.trace.push({
      snapshotId: observation.snapshot_id,
      operation: decision.operation,
      target: decision.target,
      ...targetName === undefined ? {} : { targetName },
      ...targetIdentifier === undefined ? {} : { targetIdentifier },
      ...decision.confidence === undefined ? {} : { confidence: decision.confidence },
      requestLatencyMs: response.latencyMs,
      dispatched: false,
    })
    if (decision.operation === 'DONE') {
      const verified = await verifyNativeDetailed(caller, params, args.verify, signal, verifier)
      if (verified.ok) {
        state.status = 'success'
        state.reason = 'independently_verified'
      } else {
        state.reason = 'premature_done_rejected_by_verifier'
        // Element identity only; assertion text and AX values stay out of the result.
        state.details = { verification: verified.evidence }
      }
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
        execution.agent, approvals, approvalContext, approvalLabels, signal,
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
        execution.agent, approvals, approvalContext, approvalLabels, signal,
      )
      if (!approval.approved) {
        state.status = 'confirmation_required'
        state.reason = approval.reason ?? 'login_requires_approval'
        return state
      }
    }

    const fingerprint = JSON.stringify([observation.elements, decision.operation, decision.target, decision.text])
    repeated = fingerprint === previousFingerprint ? repeated + 1 : 0
    previousFingerprint = fingerprint
    if (repeated >= 2) {
      state.reason = 'no_progress_same_decision_repeated'
      return state
    }
    const preActionPause = await execution?.waitWhilePaused(signal)
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
      // Re-read the frame after the decision: the window may have moved, been
      // resized, or changed display while the model was thinking.
      const live = await readLiveWindow(caller, params, signal)
      await executeNative(caller, params, observation, decision, signal, indicator, live?.bounds)
      state.actionsExecuted += 1
      state.trace.at(-1)!.dispatched = true
      if (['TYPE_TEXT', 'PASTE_TEXT'].includes(decision.operation) && targetName !== undefined && decision.text !== undefined) {
        captureInputs.get(state)!.push({ targetName, value: decision.text })
      }
    } catch (error) {
      if (decision.operation === 'PASTE_TEXT' && isUncertainNativePaste(error)) {
        if (error instanceof Error && error.message.includes('PASTE_NOT_CONSUMED')) {
          state.actionsExecuted += 1
          state.trace.at(-1)!.dispatched = true
        }
        if (await verifyNative(caller, params, args.verify, signal, verifier)) {
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
        state.trace.at(-1)!.stale = error.message.slice(0, 200)
        continue
      }
      throw error
    }

    const shortDeadline = Date.now() + config.verificationTimeoutMs
    do {
      signal.throwIfAborted()
      if (await verifyNative(caller, params, args.verify, signal, verifier)) {
        state.status = 'success'
        state.reason = 'independently_verified_after_action'
        return state
      }
      if (Date.now() >= shortDeadline) break
      await new Promise(resolve => setTimeout(resolve, 50))
    } while (true)

    let current = await readNativeState(caller, params, signal)
    if (!hasPendingState(current)) continue
    // Bounded probe: a structural pending indicator may cost at most
    // PENDING_PROBE_MAX_MS and PENDING_PROBE_MAX_READS, whatever the config says.
    const asyncDeadline = Date.now() + Math.min(config.asyncTimeoutMs, PENDING_PROBE_MAX_MS)
    let reads = 0
    do {
      signal.throwIfAborted()
      if (await verifyNative(caller, params, args.verify, signal, verifier)) {
        state.status = 'success'
        state.reason = 'independently_verified_after_async_update'
        return state
      }
      reads += 1
      if (reads >= PENDING_PROBE_MAX_READS) break
      current = await readNativeState(caller, params, signal)
      if (!hasPendingState(current)) break
      if (Date.now() >= asyncDeadline) {
        state.reason = 'async_result_timeout'
        return state
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (true)
  }
  return state
  } catch (error) {
    const controlStop = execution?.admit()
    if (controlStop !== null && controlStop !== undefined) {
      state.status = controlStop.status
      state.reason = controlStop.reason
      return state
    }
    if (error instanceof Error && error.message.includes('WINDOW_GEOMETRY_UNAVAILABLE')) {
      state.status = 'escalated'
      state.reason = 'window_geometry_unavailable'
      state.details = {
        recovery: 'Re-observe the window (listWindows/getState) before retrying the visual action; the snapshot frame is not reused.',
      }
      return state
    }
    if (error instanceof Error && error.message.includes('FOREGROUND_REQUIRED')) {
      state.route = 'human'
      state.status = 'escalated'
      state.reason = 'foreground_required'
      return state
    }
    throw error
  }
}

/** Window-relative point; the space the native click/scroll calls consume. */
export interface Point {
  x: number
  y: number
}

function finite(...values: number[]): boolean {
  return values.every(Number.isFinite)
}

/**
 * True when two frames describe the same rectangle.
 *
 * Sub-point tolerance: AX reports fractional points (a window at x=399.6 is
 * normal), so an exact comparison would reject an unchanged window.
 */
export function sameWindowFrame(a: WindowRect | undefined, b: WindowRect | undefined): boolean {
  if (a === undefined || b === undefined) return false
  if (!finite(a.x, a.y, a.width, a.height, b.x, b.y, b.width, b.height)) return false
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5
    && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5
}

function validWindow(window: WindowRect | undefined): window is WindowRect {
  return window !== undefined && finite(window.x, window.y, window.width, window.height)
    && window.width > 0 && window.height > 0
}

/**
 * Centre of a normalized screenshot box, in AX screen points.
 *
 * The box is a fraction of the window, so the conversion uses the window frame
 * only. Screenshot pixel dimensions are deliberately ignored: on a 2x display
 * `pixelWidth` is twice `bounds.width`, and scaling by it put every visual click
 * at twice its intended offset.
 */
export function boxCenterPoint(box: NonNullable<Decision['box']>, window: WindowRect): Point | undefined {
  if (!validWindow(window)) return undefined
  const clamp = (value: number): number => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
  return {
    x: window.x + ((clamp(box.left) + clamp(box.right)) / 2) * window.width,
    y: window.y + ((clamp(box.top) + clamp(box.bottom)) / 2) * window.height,
  }
}

/** Centre of an AX frame (screen points) in AX screen points. */
export function frameCenter(bounds: readonly number[] | undefined): Point | undefined {
  if (bounds === undefined || bounds.length < 4) return undefined
  const [x, y, width, height] = bounds
  if (!finite(x!, y!, width!, height!) || width! <= 0 || height! <= 0) return undefined
  return { x: x! + width! / 2, y: y! + height! / 2 }
}

/** AX screen point -> window-relative point, or undefined when it is outside. */
export function windowRelativePoint(point: Point, window: WindowRect | undefined): Point | undefined {
  if (!validWindow(window) || !finite(point.x, point.y)) return undefined
  const x = point.x - window.x
  const y = point.y - window.y
  if (x < 0 || y < 0 || x > window.width || y > window.height) return undefined
  return { x, y }
}

/** AX screen point -> 0..999 basis used by `click { relative: true }`. */
export function basisPoint(point: Point, window: WindowRect | undefined): Point | undefined {
  const relative = windowRelativePoint(point, window)
  if (relative === undefined || window === undefined) return undefined
  return {
    x: Math.min(999, Math.max(0, Math.round(relative.x * 999 / window.width))),
    y: Math.min(999, Math.max(0, Math.round(relative.y * 999 / window.height))),
  }
}

export interface DispatchPoint {
  /** AX screen point; what the on-screen indicator should highlight. */
  ax?: Point
  /** Window-relative point; the `click`/`scroll` wire space. */
  relative?: Point
  /** 0..999 basis for `click { relative: true }`. */
  basis?: Point
}

/**
 * One coordinate system for the whole chain: everything is derived from AX
 * screen points, and the window frame passed in must be the *current* one.
 */
export function resolveDispatchPoint(
  observation: Observation,
  decision: Decision,
  window: WindowRect | undefined,
): DispatchPoint {
  const target = observation.elements.find(element => element.id === decision.target)
  const ax = decision.target === null
    ? decision.box === undefined || window === undefined ? undefined : boxCenterPoint(decision.box, window)
    : frameCenter(target?.bounds)
  if (ax === undefined) return {}
  return {
    ax,
    ...windowRelativePoint(ax, window) === undefined ? {} : { relative: windowRelativePoint(ax, window)! },
    ...basisPoint(ax, window) === undefined ? {} : { basis: basisPoint(ax, window)! },
  }
}

export interface LiveWindow {
  windowId: number
  title?: string
  bounds?: WindowRect
  isOnScreen?: boolean
}

/**
 * Re-reads the selected window's frame right before dispatch.
 *
 * The snapshot's `windowBounds` is evidence from decision time; a window can be
 * moved, resized, or sent to another display while the model is thinking, so a
 * click derived from it lands somewhere else. `listWindows` is the cheap,
 * always-fresh source for the frame.
 */
export async function readLiveWindow(
  caller: NativeCaller,
  params: Record<string, unknown>,
  signal: AbortSignal,
): Promise<LiveWindow | undefined> {
  try {
    const windows = await caller.call('listWindows', { appHandle: params.appHandle }, signal) as any
    if (!Array.isArray(windows)) return undefined
    const entry = windows.find((window: any) => window?.windowId === params.windowId)
    if (entry === undefined) return undefined
    return {
      windowId: entry.windowId,
      ...typeof entry.title === 'string' ? { title: entry.title } : {},
      ...entry.bounds === undefined ? {} : { bounds: entry.bounds as WindowRect },
      ...entry.isOnScreen === undefined ? {} : { isOnScreen: entry.isOnScreen === true },
    }
  } catch {
    return undefined
  }
}

export async function runComputerSubgoal(
  caller: NativeCaller,
  decisionClient: D1DecisionClient,
  config: ResolvedConfig,
  rawArgs: unknown,
  signal: AbortSignal,
  skillStore?: SkillStore,
  execution?: ExecutionHandle,
  approvals?: ApprovalGateway,
  indicator?: NativeIndicator,
  verifier: NativeVerificationRegistry = EMPTY_VERIFICATION_REGISTRY,
): Promise<RunState> {
  try {
    const result = await runComputerSubgoalInner(
      caller, decisionClient, config, rawArgs, signal, skillStore, execution, approvals, indicator, verifier,
    )
    if (config.captureSkills && skillStore !== undefined && result.route === 'd1' && result.status === 'success') {
      const args = computerSubgoalInput.parse(rawArgs)
      await createCandidateFromTrajectory(skillStore, {
        route: result.route,
        status: result.status,
        trace: result.trace,
        verify: args.verify,
        inputs: args.inputs,
        capturedValues: captureInputs.get(result),
        match: result.appBundleId === undefined ? { windowTitle: result.windowTitle } : { appBundleId: result.appBundleId },
        // The captured risk is the *resolved* one: a Skill may never store less
        // risk than the provider floor demanded for the run that produced it.
        risk: resolvePolicy(args.policy, {
          minRisk: config.minRisk,
          preauthorizeConsequential: config.preauthorizeConsequential,
          preauthorizeLogin: config.preauthorizeLogin,
        }).risk,
        evolveFrom: result.evolvedFromSkillId,
      }).then(candidate => { if (candidate !== undefined) result.candidateId = candidate.id })
    }
    captureInputs.delete(result)
    await indicator?.finish({ status: result.status, reason: result.reason, route: result.route })
    return result
  } catch (error) {
    await indicator?.finish({ status: 'failed', reason: 'tool_execution_failed' })
    throw error
  }
}

export function isUncertainNativePaste(error: unknown): boolean {
  return error instanceof Error && /PASTE_NOT_CONSUMED|CLIPBOARD_CHANGED/u.test(error.message)
}

export async function executeNative(
  caller: NativeCaller,
  params: Record<string, unknown>,
  observation: Observation,
  decision: Decision,
  signal: AbortSignal,
  indicator?: ActivitySink,
  /**
   * Current window frame, re-read by the caller right before dispatch. Without
   * it, coordinate-based operations fail closed instead of using the frame the
   * snapshot was taken with.
   */
  window?: WindowRect,
): Promise<void> {
  await indicator?.activity({
    phase: decision.operation === 'WAIT' ? 'waiting' : 'acting',
    operation: decision.operation,
    point: resolveDispatchPoint(observation, decision, window).ax,
  })
  if (process.env.DEBUG_CUA === '1') {
    // Coordinates only: no AX values, no typed text.
    console.error('CUA_DISPATCH', JSON.stringify({
      operation: decision.operation,
      snapshotFrame: observation.windowBounds,
      liveFrame: window,
      screenshotBounds: observation.screenshot?.bounds,
      point: resolveDispatchPoint(observation, decision, window).relative,
    }))
  }
  try {
    await executeNativeAction(caller, params, observation, decision, signal, window)
  } catch (error) {
    await indicator?.activity({ phase: 'verifying', operation: decision.operation }).catch(() => undefined)
    throw error
  }
  await indicator?.activity({ phase: 'verifying', operation: decision.operation })
}

async function executeNativeAction(
  caller: NativeCaller,
  params: Record<string, unknown>,
  observation: Observation,
  decision: Decision,
  signal: AbortSignal,
  window?: WindowRect,
): Promise<void> {
  const target = observation.elements.find(element => element.id === decision.target)
  const { maxElements: _maxElements, maxDepth: _maxDepth, details: _details, ...operationParams } = params
  const base = { ...operationParams, snapshotId: observation.snapshot_id }
  const elementBase = { appHandle: params.appHandle, snapshotId: observation.snapshot_id }
  const point = (): DispatchPoint => resolveDispatchPoint(observation, decision, window)
  /**
   * A visual click is expressed as a fraction of the window the *screenshot* was
   * taken in. When the live frame differs from the snapshot frame, that mapping
   * is stale and the click is refused instead of landing at a wrong offset.
   */
  const frameIsStale = !sameWindowFrame(observation.windowBounds, window)
  const requireVisualPoint = (): Point => {
    if (frameIsStale) throw new Error('WINDOW_GEOMETRY_UNAVAILABLE: the window moved or resized after the screenshot; observe again')
    const resolved = point().relative
    if (resolved === undefined) throw new Error('WINDOW_GEOMETRY_UNAVAILABLE: re-read the window before dispatching a visual click')
    return resolved
  }
  if (decision.operation === 'WAIT') {
    await new Promise(resolve => setTimeout(resolve, 250))
    return
  }
  if (decision.operation === 'SCROLL_UP' || decision.operation === 'SCROLL_DOWN') {
    const resolved = frameIsStale
      ? undefined
      : target === undefined
        ? point().relative
        : windowRelativePoint(frameCenter(target.bounds) ?? { x: NaN, y: NaN }, window)
    if (resolved === undefined) throw new Error('WINDOW_GEOMETRY_UNAVAILABLE: scroll needs an unchanged window frame')
    await caller.call('scroll', {
      ...base,
      windowId: params.windowId,
      x: resolved.x,
      y: resolved.y,
      deltaLinesY: decision.operation === 'SCROLL_UP' ? 1 : -1,
    }, signal)
    return
  }
  if (decision.operation === 'CLICK') {
    if (decision.target === null && observation.screenshot !== undefined && decision.box !== undefined) {
      const resolved = requireVisualPoint()
      const dispatched = await caller.call('click', { ...base, windowId: params.windowId, x: resolved.x, y: resolved.y }, signal)
      if (process.env.DEBUG_CUA === '1') console.error('CUA_CLICK_RESULT', JSON.stringify(dispatched))
    } else {
      await caller.call('click', { ...elementBase, elementIndex: Number(decision.target) }, signal)
    }
    return
  }
  if (decision.operation === 'PASTE_TEXT') {
    if (decision.target === null && observation.screenshot !== undefined && decision.box !== undefined) {
      const resolved = requireVisualPoint()
      await caller.call('click', { ...base, windowId: params.windowId, x: resolved.x, y: resolved.y }, signal)
    } else {
      // An element focus click is coordinate-based only while the frame is
      // unchanged; otherwise the AX index is the safe, coordinate-free path.
      const basis = frameIsStale ? undefined : point().basis
      if (basis !== undefined) {
        await caller.call('click', { ...base, windowId: params.windowId, x: basis.x, y: basis.y, relative: true }, signal)
      } else {
        await caller.call('click', { ...elementBase, elementIndex: Number(decision.target) }, signal)
      }
    }
    await caller.call('paste', { appHandle: params.appHandle, text: decision.text }, signal)
    return
  }
  if (decision.operation === 'TYPE_TEXT') {
    if (decision.target === null && observation.screenshot !== undefined && decision.box !== undefined) {
      const resolved = requireVisualPoint()
      await caller.call('click', { ...base, windowId: params.windowId, x: resolved.x, y: resolved.y }, signal)
      await caller.call('typeText', { appHandle: params.appHandle, text: decision.text }, signal)
    } else if (target !== undefined && /TextField|TextArea|TextView|SearchField|ComboBox/iu.test(target.role)) {
      await caller.call('setValue', { ...elementBase, elementIndex: Number(decision.target), value: decision.text }, signal)
    } else {
      await caller.call('click', { ...elementBase, elementIndex: Number(decision.target) }, signal)
      await caller.call('pressKey', { appHandle: params.appHandle, key: 'a', modifiers: ['command'] }, signal)
      await caller.call('typeText', { appHandle: params.appHandle, text: decision.text }, signal)
    }
    return
  }
  if (decision.operation === 'INCREMENT' || decision.operation === 'DECREMENT') {
    const action = decision.operation === 'INCREMENT' ? 'AXIncrement' : 'AXDecrement'
    if (target?.declaredActions?.includes(action)) {
      await caller.call('performSecondaryAction', { ...elementBase, elementIndex: Number(decision.target), action }, signal)
    } else {
      await caller.call('click', { ...elementBase, elementIndex: Number(decision.target) }, signal)
      await caller.call('pressKey', { appHandle: params.appHandle, key: decision.operation === 'INCREMENT' ? 'Up' : 'Down' }, signal)
    }
    return
  }
  throw new Error(`Unsupported native operation: ${decision.operation}`)
}
