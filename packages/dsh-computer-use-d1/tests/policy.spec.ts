import { expect, it } from 'vitest'
import { resolvePolicy } from '@albaincompleta/dsh-cu-core/policy'
import { Config } from '../src/config.ts'
import type { NativeCaller } from '../src/controller.ts'
import { computerSubgoalInput, runComputerSubgoal } from '../src/controller.ts'

const WINDOW = { windowId: 2, title: 'Fixture', isOnScreen: true, bounds: { x: 0, y: 0, width: 500, height: 400 } }
const TREE = '- [1] AXButton "Delete account" actions=["AXPress"] bounds=[10.0,20.0,100.0,40.0]'

async function run(overrides: { minRisk?: string; preauthorizeConsequential?: boolean }, policy?: Record<string, unknown>) {
  let clicks = 0
  const caller = {
    async call(method: string) {
      if (method === 'getCapabilities') return { sessionLocked: false, permissions: { accessibility: true, screenRecording: true } }
      if (method === 'getApp') return { appHandle: 'app-1', pid: 42, bundleId: 'fixture.app' }
      if (method === 'listWindows') return [WINDOW]
      if (method === 'getState') return { pid: 42, snapshotId: 'snapshot-1', truncated: false, windows: [WINDOW], tree: TREE }
      if (method === 'screenshot') return { bounds: WINDOW.bounds, pixelWidth: 500, pixelHeight: 400, windowId: 2, coordinateSpace: 'window-points', data: '', mimeType: 'image/png' }
      if (method === 'click') { clicks += 1; return { dispatched: true } }
      return { dispatched: true }
    },
  } as unknown as NativeCaller
  const decisionClient = {
    async decide() {
      return {
        decision: { operation: 'CLICK', target: '1' },
        usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, textExtractionCalls: 0,
      }
    },
  } as never
  const result = await runComputerSubgoal(
    caller, decisionClient, Config({ decisionToken: 'test-token', maxSteps: 1, ...overrides } as never),
    {
      goal: 'Delete the account', app: '42', windowId: 2, maxSteps: 1,
      verify: [{ type: 'text_visible', text: 'Never present' }],
      ...policy === undefined ? {} : { policy },
    },
    new AbortController().signal,
  )
  return { result: result as unknown as Record<string, unknown>, clicks }
}

it('the provider floor raises the model risk and blocks an unapproved destructive click', async () => {
  const { result, clicks } = await run({ minRisk: 'consequential' }, { risk: 'read_only' })
  expect(result).toMatchObject({ status: 'confirmation_required', reason: 'approval_unavailable', actionsExecuted: 0 })
  expect(clicks).toBe(0)
})

it('lets the model raise the risk on its own', async () => {
  const { result, clicks } = await run({}, { risk: 'consequential' })
  expect(result).toMatchObject({ status: 'confirmation_required', actionsExecuted: 0 })
  expect(clicks).toBe(0)
})

it('runs a consequential action only with host pre-authorization', async () => {
  const { result, clicks } = await run({ minRisk: 'consequential', preauthorizeConsequential: true })
  expect(clicks).toBe(1)
  expect(result.actionsExecuted).toBe(1)
  expect(result.status).not.toBe('confirmation_required')
})

it('does not accept pre-authorization from the tool argument', () => {
  expect(() => computerSubgoalInput.parse({
    goal: 'Delete the account', app: '42',
    verify: [{ type: 'text_visible', text: 'x' }],
    policy: { risk: 'consequential', allowConsequential: true },
  })).toThrow()
  expect(() => computerSubgoalInput.parse({
    goal: 'Delete the account', app: '42',
    verify: [{ type: 'text_visible', text: 'x' }],
    policy: { allowLogin: true },
  })).toThrow()
})

it('resolvePolicy composes the floor and keeps allow* host-owned', () => {
  expect(resolvePolicy({ risk: 'read_only' }, { minRisk: 'consequential' }))
    .toEqual({ risk: 'consequential' })
  expect(resolvePolicy({ risk: 'consequential' }, { minRisk: 'read_only' }))
    .toEqual({ risk: 'consequential' })
  expect(resolvePolicy({ risk: 'read_only' }, { preauthorizeConsequential: true, preauthorizeLogin: true }))
    .toEqual({ risk: 'read_only', allowConsequential: true, allowLogin: true })
  expect(resolvePolicy({ credentialsAvailable: false }, { minRisk: 'reversible' }))
    .toEqual({ risk: 'reversible', credentialsAvailable: false })
})
