/**
 * The last postcondition read of a native Skill replay races the application's
 * AX update: a single sample taken right after the final dispatched step can be
 * stale and used to report `skill_postcondition_failed` for a replay that did
 * work. The final check therefore samples inside the same bounded window as the
 * per-step check. This spec pins that behaviour: the tree only settles on the
 * third read, which a single-sample implementation cannot observe.
 */
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ExecutionHandle } from '@albaincompleta/dsh-cu-core/run-controller'
import type { VerifiedSkill } from '@albaincompleta/dsh-cu-core/skills'
import { Config } from '../src/config.ts'
import type { ComputerSubgoalInput, NativeCaller } from '../src/controller.ts'
import { runNativeSkill } from '../src/skill-runner.ts'
import type { ResolvedConfig } from '../src/config.ts'

const params = { appHandle: 'app-1', windowId: 2, details: true }
const selected = { windowId: 2, title: 'Sign in', bounds: { x: 0, y: 0, width: 400, height: 300 } }

const pendingTree = [
  '- [1] AXWindow "Sign in"',
  '  - [2] AXTextField placeholder="Report path" bounds=[40,80,300,24]',
].join('\n')

const settledTree = [
  '- [1] AXWindow "Sign in"',
  '  - [2] AXTextField placeholder="Report path" bounds=[40,80,300,24]',
  '  - [3] AXStaticText "Import complete" bounds=[40,140,200,20]',
].join('\n')

function callerSettlingAfter(settleAfterMs: number) {
  const startedAt = Date.now()
  const caller = {
    async call() {
      const elapsed = Date.now() - startedAt
      return {
        pid: 4711,
        snapshotId: `snap-${Math.round(elapsed)}`,
        truncated: false,
        windows: [{ windowId: 2, title: 'Sign in' }],
        tree: elapsed >= settleAfterMs ? settledTree : pendingTree,
      }
    },
  } as unknown as NativeCaller
  return { caller, elapsed: () => Date.now() - startedAt }
}

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

function config(): ResolvedConfig {
  return Config({ decisionToken: 'unused', verificationTimeoutMs: 300 })
}

const skill: VerifiedSkill = {
  id: 'test.native-settle', version: 1, verifiedAt: '2026-11-01',
  match: { windowTitle: 'Sign in' }, fallback: 'human', risk: 'reversible',
  verify: [{ type: 'text_visible', text: 'Import complete' }],
  steps: [{ type: 'type', target: 'Report path', input: 'Report path' }],
}

const args = {
  goal: 'Fill the form',
  app: '1',
  inputs: { 'Report path': '/tmp/report.csv' },
  verify: [{ type: 'text_visible', text: 'Import complete' }],
} as unknown as ComputerSubgoalInput

describe('final postcondition sampling', () => {
  it('keeps sampling until the AX tree settles instead of failing on the first stale read', async () => {
    // Settles after the per-step verification window (300 ms) has expired, so
    // only the final postcondition loop can observe the settled tree.
    const { caller } = callerSettlingAfter(420)
    const result = await runNativeSkill(
      caller, skill, args, selected, params, config(),
      new AbortController().signal, 'com.example.app', undefined, undefined, undefined, execution(), undefined,
    )
    expect(result).toMatchObject({ status: 'success', reason: 'independently_verified_after_skill', actionsExecuted: 1 })
  })

  it('still fails when the postcondition never becomes true', async () => {
    const { caller } = callerSettlingAfter(Number.POSITIVE_INFINITY)  // never settles
    const result = await runNativeSkill(
      caller, skill, args, selected, params, config(),
      new AbortController().signal, 'com.example.app', undefined, undefined, undefined, execution(), undefined,
    )
    expect(result).toMatchObject({ route: 'human', reason: 'skill_postcondition_failed' })
  })
})
