import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { validateDecision } from '@dsh-cu/core/actions'
import { subgoalInput } from '@dsh-cu/core/contract'
import type { RunStatus, Verification } from '@dsh-cu/core/contract'
import type { D1DecisionClient } from '@dsh-cu/core/decision'
import { checkPagePolicy, checkTargetAmbiguity, taskPolicySchema } from '@dsh-cu/core/policy'
import { selectSkill, SkillError } from '@dsh-cu/core/skills'
import type { SkillStore } from '@dsh-cu/core/skill-store'
import type { Decision, Observation } from '@dsh-cu/core/types'
import { z } from 'zod'
import { runNativeVerification } from './verification.ts'
import { createCandidateFromTrajectory } from '@dsh-cu/core/skill-builder'
import type { ExecutionHandle } from '@dsh-cu/core/run-controller'
import type { ApprovalGateway } from '@dsh-cu/core/approvals'
import {
  actionApprovalContext, needsConsequentialApproval, needsLoginApproval,
  requestConsequentialApproval, requestLoginApproval,
} from '@dsh-cu/core/policy-approvals'
import { uiStrings } from '@dsh-cu/core/locale'
import { RunBudget } from '@dsh-cu/core/budget'
import type { CapturedInput, TrajectoryStep } from '@dsh-cu/core/skill-builder'
import type { ResolvedConfig } from './config.ts'
import { permissionSettingsUrl, requestPermission, type PermissionKind } from './permissions.ts'
import type { ActivitySink } from '@dsh-cu/core/activity'
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

function nativeActions(element: any): string[] {
  const actions = new Set<string>()
  const declared: string[] = element.actions ?? []
  if (declared.some(action => /^(?:AX)?Press$/u.test(action))) actions.add('click')
  if (declared.some(action => /^(?:AX)?Increment$/u.test(action))) actions.add('increment')
  if (declared.some(action => /^(?:AX)?Decrement$/u.test(action))) actions.add('decrement')
  if (/TextField|TextArea|TextView|SearchField|ComboBox/iu.test(element.role)) actions.add('type')
  if (/TextField|TextArea|TextView|SearchField|ComboBox|Document/iu.test(element.role)) actions.add('paste')
  if (/Button|CheckBox|RadioButton|MenuItem|PopUpButton/iu.test(element.role)) actions.add('click')
  return [...actions]
}

export function parseAxElements(tree: string, window: any): Observation['elements'] {
  const elements: Observation['elements'] = []
  for (const line of tree.split('\n')) {
    const match = line.match(/^\s*- \[(\d+)\]\s+(\S+)(?:\s+(.*))?$/u)
    if (match === null) continue
    const [, index, role, content = ''] = match
    const title = content.match(/"([^"]*)"/u)?.[1] ?? ''
    const declared = content.match(/actions=\[([^\]]+)\]/u)?.[1]
    const actions = declared === undefined ? [] : [...declared.matchAll(/"([^"]+)"/gu)].map(match => match[1])
    const boundsText = content.match(/bounds=\[([^\]]+)\]/u)?.[1]
    const bounds = boundsText === undefined ? undefined : boundsText.split(',').map(value => Number(value.trim())) as [number, number, number, number]
    elements.push({
      id: index,
      role,
      name: content.match(/placeholder="([^"]+)"/u)?.[1] || title || content.match(/(?:identifier|id)="([^"]+)"/u)?.[1] || '',
      value: content.match(/\s=\s"([^"]*)"/u)?.[1] ?? content.match(/ value="([^"]*)"/u)?.[1] ?? null,
      actions: nativeActions({ role, actions }),
      enabled: !/\bdisabled\b/u.test(content),
      focused: /\bfocused\b/u.test(content),
      inputType: /SecureTextField/iu.test(role) ? 'password' : undefined,
      context: window.title ?? '',
      bounds,
      identifier: content.match(/(?:identifier|id)="([^"]+)"/u)?.[1],
      declaredActions: actions,
    })
  }
  return elements
}

export function visibleAxText(tree: string): string {
  const texts: string[] = []
  for (const line of tree.split('\n')) {
    const content = line.match(/^\s*- (?:\[\d+\]\s+)?\S+(?:\s+(.*))?$/u)?.[1] ?? ''
    if (content === '') continue
    const title = content.match(/^"([^"]*)"/u)?.[1]
    const value = content.match(/(?:^|\s)=\s"([^"]*)"/u)?.[1]
    if (title !== undefined) texts.push(title)
    if (value !== undefined) texts.push(value)
    for (const match of content.matchAll(/(?:^|\s)(?:description|placeholder|title|help|value)="([^"]*)"/gu)) {
      texts.push(match[1])
    }
  }
  return texts.join('\n')
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

export async function verifyNative(caller: NativeCaller, params: Record<string, unknown>, assertions: Verification[], signal: AbortSignal): Promise<boolean> {
  try {
    const state = await readNativeState(caller, params, signal)
    const window = state.windows.find((window: any) => window.windowId === params.windowId) ?? params
    const elements = parseAxElements(state.tree, window)
    const visibleText = visibleAxText(state.tree)
    for (const assertion of assertions) {
      if (assertion.type === 'custom' && !await runNativeVerification(
        assertion.name,
        assertion.args ?? {},
        { caller, params, signal },
      )) return false
      if (assertion.type === 'text_visible' && !visibleText.includes(assertion.text)) return false
      if (assertion.type === 'url_contains' && !`app://${state.pid}/${params.windowId ?? state.focusedWindowId ?? ''}`.includes(assertion.value)) return false
      if (assertion.type === 'input_value' && !elements.some(element =>
        (element.name === assertion.label || element.identifier === assertion.label)
        && element.value === assertion.value)) return false
      if (assertion.type === 'checkbox' && !elements.some(element =>
        (element.name === assertion.label || element.identifier === assertion.label)
        && ([true, 1, '1', 'true', 'checked'].includes(element.selected ?? element.value ?? '') === assertion.checked))) return false
    }
    return true
  } catch (error) {
    if (process.env.DEBUG_CUA === '1') console.error('CUA_VERIFY_ERROR', error instanceof Error ? error.name : 'Error')
    return false
  }
}

export function hasPendingState(state: any): boolean {
  return /loading|waiting|please wait|加载|等待/iu.test(state.tree)
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
): Promise<RunState> {
  const args = computerSubgoalInput.parse(rawArgs)
  let policy = taskPolicySchema.parse(args.policy ?? {})
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
        budget, Math.min(args.maxSteps ?? config.maxSteps, config.maxSteps), indicator, execution,
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
    if (await verifyNative(caller, params, args.verify, signal)) {
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
    const targetName = observation.elements.find(element => element.id === decision.target)?.name
      || observation.elements.find(element => element.id === decision.target)?.identifier
    const targetIdentifier = observation.elements.find(element => element.id === decision.target)?.identifier
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
      if (await verifyNative(caller, params, args.verify, signal)) {
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
      await executeNative(caller, params, observation, decision, signal, indicator)
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
        if (await verifyNative(caller, params, args.verify, signal)) {
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
      if (await verifyNative(caller, params, args.verify, signal)) {
        state.status = 'success'
        state.reason = 'independently_verified_after_action'
        return state
      }
      if (Date.now() >= shortDeadline) break
      await new Promise(resolve => setTimeout(resolve, 50))
    } while (true)

    let current = await readNativeState(caller, params, signal)
    if (!hasPendingState(current)) continue
    const asyncDeadline = Date.now() + config.asyncTimeoutMs
    do {
      signal.throwIfAborted()
      if (await verifyNative(caller, params, args.verify, signal)) {
        state.status = 'success'
        state.reason = 'independently_verified_after_async_update'
        return state
      }
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
    if (error instanceof Error && error.message.includes('FOREGROUND_REQUIRED')) {
      state.route = 'human'
      state.status = 'escalated'
      state.reason = 'foreground_required'
      return state
    }
    throw error
  }
}

function visualPoint(observation: Observation, box: NonNullable<Decision['box']>): [number, number] {
  const screenshot = observation.screenshot!
  const width = screenshot.coordinateSpace === 'screenshot-pixels' ? screenshot.pixelWidth : screenshot.bounds.width
  const height = screenshot.coordinateSpace === 'screenshot-pixels' ? screenshot.pixelHeight : screenshot.bounds.height
  return [
    (box.left + box.right) * width / 2,
    (box.top + box.bottom) * height / 2,
  ]
}

function nativeElementPoint(observation: Observation, target: Observation['elements'][number] | undefined): [number, number] | undefined {
  const bounds = target?.bounds
  const window = observation.windowBounds
  if (bounds === undefined || window === undefined || ![...bounds, window.x, window.y, window.width, window.height].every(Number.isFinite)) return undefined
  const x = bounds[0] + bounds[2] / 2 - window.x
  const y = bounds[1] + bounds[3] / 2 - window.y
  if (bounds[2] <= 0 || bounds[3] <= 0 || x < 0 || y < 0 || x > window.width || y > window.height) return undefined
  return [x, y]
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
): Promise<RunState> {
  try {
    const result = await runComputerSubgoalInner(caller, decisionClient, config, rawArgs, signal, skillStore, execution, approvals, indicator)
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
        risk: args.policy?.risk,
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

function nativeActivityPoint(observation: Observation, decision: Decision): { x: number; y: number } | undefined {
  const bounds = observation.elements.find(element => element.id === decision.target)?.bounds
  if (bounds !== undefined && bounds.every(Number.isFinite) && bounds[2] > 0 && bounds[3] > 0) {
    return { x: bounds[0] + bounds[2] / 2, y: bounds[1] + bounds[3] / 2 }
  }
  if (decision.target === null && observation.screenshot !== undefined && decision.box !== undefined && observation.windowBounds !== undefined) {
    const [x, y] = visualPoint(observation, decision.box)
    return { x: observation.windowBounds.x + x, y: observation.windowBounds.y + y }
  }
  return undefined
}

export async function executeNative(
  caller: NativeCaller,
  params: Record<string, unknown>,
  observation: Observation,
  decision: Decision,
  signal: AbortSignal,
  indicator?: ActivitySink,
): Promise<void> {
  await indicator?.activity({
    phase: decision.operation === 'WAIT' ? 'waiting' : 'acting',
    operation: decision.operation,
    point: nativeActivityPoint(observation, decision),
  })
  try {
    await executeNativeAction(caller, params, observation, decision, signal)
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
): Promise<void> {
  const target = observation.elements.find(element => element.id === decision.target)
  const { maxElements: _maxElements, maxDepth: _maxDepth, details: _details, ...operationParams } = params
  const base = { ...operationParams, snapshotId: observation.snapshot_id }
  const elementBase = { appHandle: params.appHandle, snapshotId: observation.snapshot_id }
  if (decision.operation === 'WAIT') {
    await new Promise(resolve => setTimeout(resolve, 250))
    return
  }
  if (decision.operation === 'SCROLL_UP' || decision.operation === 'SCROLL_DOWN') {
    const bounds = target?.bounds ?? [0, 0, 1, 1]
    await caller.call('scroll', {
      ...base,
      windowId: params.windowId,
      x: bounds[0] + bounds[2] / 2,
      y: bounds[1] + bounds[3] / 2,
      deltaLinesY: decision.operation === 'SCROLL_UP' ? 1 : -1,
    }, signal)
    return
  }
  if (decision.operation === 'CLICK') {
    if (decision.target === null && observation.screenshot !== undefined && decision.box !== undefined) {
      const [x, y] = visualPoint(observation, decision.box)
      await caller.call('click', { ...base, windowId: params.windowId, x, y }, signal)
    } else {
      await caller.call('click', { ...elementBase, elementIndex: Number(decision.target) }, signal)
    }
    return
  }
  if (decision.operation === 'PASTE_TEXT') {
    if (decision.target === null && observation.screenshot !== undefined && decision.box !== undefined) {
      const [x, y] = visualPoint(observation, decision.box)
      await caller.call('click', { ...base, windowId: params.windowId, x, y }, signal)
    } else {
      const point = nativeElementPoint(observation, target)
      if (point !== undefined) {
        const window = observation.windowBounds!
        const x = Math.min(999, Math.max(0, Math.round(point[0] * 999 / window.width)))
        const y = Math.min(999, Math.max(0, Math.round(point[1] * 999 / window.height)))
        await caller.call('click', { ...base, windowId: params.windowId, x, y, relative: true }, signal)
      } else {
        await caller.call('click', { ...elementBase, elementIndex: Number(decision.target) }, signal)
      }
    }
    await caller.call('paste', { appHandle: params.appHandle, text: decision.text }, signal)
    return
  }
  if (decision.operation === 'TYPE_TEXT') {
    if (decision.target === null && observation.screenshot !== undefined && decision.box !== undefined) {
      const [x, y] = visualPoint(observation, decision.box)
      await caller.call('click', { ...base, windowId: params.windowId, x, y }, signal)
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
