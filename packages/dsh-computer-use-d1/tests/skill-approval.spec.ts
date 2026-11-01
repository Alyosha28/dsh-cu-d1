/**
 * NR-01 / CR-01 / CR-03: a native Skill replay must pass the same two gates as the
 * D1 route, per mutating step, before any input is dispatched; and it may only
 * replay in a window/application scope it was verified for.
 */
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalRequest, ApprovalGateway } from '@albaincompleta/dsh-cu-core/approvals'
import type { ExecutionHandle } from '@albaincompleta/dsh-cu-core/run-controller'
import type { VerifiedSkill } from '@albaincompleta/dsh-cu-core/skills'
import { Config } from '../src/config.ts'
import type { ComputerSubgoalInput, NativeCaller } from '../src/controller.ts'
import { nativeSkillPolicy, runNativeSkill } from '../src/skill-runner.ts'
import type { NativeSkillPolicyConfig } from '../src/skill-runner.ts'
import type { ResolvedConfig } from '../src/config.ts'

const params = { appHandle: 'app-1', windowId: 2, details: true }

function config(extra: NativeSkillPolicyConfig = {}): ResolvedConfig {
  return Object.assign(Config({ decisionToken: 'unused', verificationTimeoutMs: 0 }), extra)
}

function callerWith(tree: string, title = 'Sign in') {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const caller = {
    async call(method: string, received: Record<string, unknown>) {
      calls.push({ method, params: received })
      return { pid: 4711, snapshotId: 'snap-1', truncated: false, windows: [{ windowId: 2, title }], tree }
    },
  } as unknown as NativeCaller
  return { caller, calls, methods: () => calls.map(call => call.method) }
}

const formTree = [
  '- [1] AXWindow "Sign in"',
  '  - [2] AXTextField placeholder="Report path" bounds=[40,80,300,24]',
  '  - [3] AXButton "Continue" actions=["AXPress"] bounds=[40,120,90,24]',
  '  - [4] AXSecureTextField placeholder="Password" bounds=[40,160,300,24]',
].join('\n')

function execution(): ExecutionHandle {
  return {
    id: 'run-1',
    agent: { id: 'agent-1' } as unknown as Agent,
    signal: new AbortController().signal,
    admit: () => null,
    waitWhilePaused: async () => null,
    pausedMs: () => 0,
  } as unknown as ExecutionHandle
}

function approvals(approved: boolean, reason = 'denied_by_user') {
  const requests: ApprovalRequest[] = []
  const gateway = {
    async request(_agent: unknown, request: ApprovalRequest) {
      requests.push(request)
      return approved ? { approved: true } : { approved: false, reason }
    },
  } as unknown as ApprovalGateway
  return { gateway, requests }
}

function nativeSkill(overrides: Partial<VerifiedSkill> = {}): VerifiedSkill {
  return {
    id: 'test.native-import', version: 1, verifiedAt: '2026-11-01',
    match: { windowTitle: 'Sign in' }, fallback: 'human', risk: 'consequential',
    verify: [{ type: 'text_visible', text: 'Welcome back' }],
    steps: [{ type: 'type', target: 'Report path', input: 'Report path' }],
    ...overrides,
  }
}

function args(overrides: Partial<ComputerSubgoalInput> = {}): ComputerSubgoalInput {
  return {
    goal: 'Fill the form',
    app: '1',
    inputs: { 'Report path': '/tmp/report.csv', Password: 'secret' },
    verify: [{ type: 'text_visible', text: 'Welcome back' }],
    ...overrides,
  } as ComputerSubgoalInput
}

const selected = { windowId: 2, title: 'Sign in', bounds: { x: 0, y: 0, width: 400, height: 300 } }

describe('NR-01 skill replay approval', () => {
  it('refuses a consequential step when the user denies it, and dispatches no input', async () => {
    const { caller, methods } = callerWith(formTree)
    const { gateway, requests } = approvals(false)
    const result = await runNativeSkill(
      caller, nativeSkill(), args(), selected, params, config(),
      new AbortController().signal, 'com.example.app', undefined, undefined, undefined, execution(), gateway,
    )
    expect(result).toMatchObject({ status: 'confirmation_required', reason: 'denied_by_user', actionsExecuted: 0 })
    expect(methods()).not.toContain('setValue')
    expect(requests).toHaveLength(1)
    expect(requests[0].id).toBe('dsh-cu-consequential')
    expect(requests[0].detail).toContain('Report path')
  })

  it('runs the step after an explicit approval, one prompt per mutating step', async () => {
    const { caller, methods } = callerWith(formTree)
    const { gateway, requests } = approvals(true)
    const result = await runNativeSkill(
      caller, nativeSkill(), args(), selected, params, config(),
      new AbortController().signal, 'com.example.app', undefined, undefined, undefined, execution(), gateway,
    )
    expect(result.actionsExecuted).toBe(1)
    expect(methods()).toContain('setValue')
    expect(requests.map(request => request.id)).toEqual(['dsh-cu-consequential'])
  })

  it('refuses with approval_unavailable when no gateway is wired in', async () => {
    const { caller, methods } = callerWith(formTree)
    const result = await runNativeSkill(
      caller, nativeSkill(), args(), selected, params, config(),
      new AbortController().signal, 'com.example.app',
    )
    expect(result).toMatchObject({ status: 'confirmation_required', reason: 'approval_unavailable', actionsExecuted: 0 })
    expect(methods()).not.toContain('setValue')
  })

  it('gates a credential paste behind the login approval even at reversible risk', async () => {
    const { caller, methods } = callerWith(formTree)
    const { gateway, requests } = approvals(false)
    const result = await runNativeSkill(
      caller, nativeSkill({ risk: 'reversible', steps: [{ type: 'paste', target: 'Password', input: 'Password' }] }),
      args(), selected, params, config(), new AbortController().signal, 'com.example.app',
      undefined, undefined, undefined, execution(), gateway,
    )
    expect(result).toMatchObject({ status: 'confirmation_required', actionsExecuted: 0 })
    expect(methods()).not.toContain('paste')
    expect(requests.map(request => request.id)).toEqual(['dsh-cu-login'])
  })

  it('honours a provider risk floor the caller did not ask for', async () => {
    const { caller, methods } = callerWith(formTree)
    const { gateway, requests } = approvals(false)
    const floored = config({ minRisk: 'consequential' })
    const result = await runNativeSkill(
      caller, nativeSkill({ risk: 'reversible' }), args({ policy: { risk: 'read_only' } }), selected, params, floored,
      new AbortController().signal, 'com.example.app', undefined, undefined, undefined, execution(), gateway,
    )
    expect(result).toMatchObject({ status: 'confirmation_required', actionsExecuted: 0 })
    expect(methods()).not.toContain('setValue')
    expect(requests).toHaveLength(1)
  })

  it('lets provider pre-authorization skip the prompt without weakening the gate', async () => {
    const { caller, methods } = callerWith(formTree)
    const { gateway, requests } = approvals(false)
    const preauthorized = config({ preauthorizeConsequential: true, preauthorizeLogin: true })
    await runNativeSkill(
      caller, nativeSkill(), args(), selected, params, preauthorized,
      new AbortController().signal, 'com.example.app', undefined, undefined, undefined, execution(), gateway,
    )
    expect(requests).toEqual([])
    expect(methods()).toContain('setValue')
  })

  it('refuses a read-only Skill that carries mutating steps', async () => {
    const { caller } = callerWith(formTree)
    await expect(runNativeSkill(
      caller, nativeSkill({ risk: 'read_only' }), args(), selected, params, config(),
      new AbortController().signal, 'com.example.app',
    )).rejects.toMatchObject({ code: 'skill_read_only_mutation' })
  })
})

describe('CR-03 skill provider and scope', () => {
  it('refuses a URL-scoped Skill in the native provider', async () => {
    const { caller } = callerWith(formTree)
    await expect(runNativeSkill(
      caller, nativeSkill({ match: { urlPath: '/filters.html' } }), args(), selected, params, config(),
      new AbortController().signal, 'com.example.app',
    )).rejects.toMatchObject({ code: 'skill_provider_mismatch' })
  })

  it('stops the replay when the live window no longer matches the Skill scope', async () => {
    const { caller, methods } = callerWith(formTree, 'Another Window')
    const result = await runNativeSkill(
      caller, nativeSkill(), args(), selected, params, config(),
      new AbortController().signal, 'com.example.app',
    )
    expect(result).toMatchObject({ status: 'escalated', reason: 'skill_window_mismatch' })
    expect(methods()).not.toContain('setValue')
  })

  it('derives the effective policy from the maximum of caller, Skill and floor', () => {
    const policy = nativeSkillPolicy(config({ minRisk: 'reversible' }), nativeSkill({ risk: 'consequential' }), args({ policy: { risk: 'read_only' } }))
    expect(policy.risk).toBe('consequential')
    const floored = nativeSkillPolicy(config({ minRisk: 'consequential' }), nativeSkill({ risk: 'reversible' }), args())
    expect(floored.risk).toBe('consequential')
    expect(floored.allowConsequential).toBeUndefined()
  })
})
