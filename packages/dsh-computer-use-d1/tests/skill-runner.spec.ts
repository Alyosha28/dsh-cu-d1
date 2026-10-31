import { expect, it } from 'vitest'
import { RunBudget } from '@alyosha28/dsh-cu-core/budget'
import { fixtureSkills } from '@alyosha28/dsh-cu-core/skills'
import { Config } from '../src/config.ts'
import type { ComputerSubgoalInput, NativeCaller } from '../src/controller.ts'
import { readNativeState } from '../src/controller.ts'
import { runNativeSkill } from '../src/skill-runner.ts'

it('applies a bounded audit retention configuration', () => {
  expect(Config({ decisionToken: 'unused' }).auditRetentionDays).toBe(30)
  expect(Config({ decisionToken: 'unused', auditRetentionDays: 7 }).auditRetentionDays).toBe(7)
  expect(() => Config({ decisionToken: 'unused', auditRetentionDays: 0 })).toThrow()
  expect(() => Config({ decisionToken: 'unused', auditRetentionDays: 3651 })).toThrow()
})

it('blocks native Skill input to secure fields before dispatch', async () => {
  const calls: string[] = []
  const caller = {
    async call(method: string) {
      calls.push(method)
      return {
        pid: 1, snapshotId: 'snapshot-1', windows: [{ windowId: 1, title: 'DSH Workflow Fixture' }], truncated: false,
        tree: '- [1] AXSecureTextField placeholder="Password" actions=["AXConfirm"]',
      }
    },
  } as unknown as NativeCaller
  const skill = fixtureSkills.find(candidate => candidate.id === 'fixture.native-csv-import')!
  const result = await runNativeSkill(caller, { ...skill, steps: [{ type: 'type', target: 'Password', input: 'Password' }] }, {
    goal: 'Enter a password', app: '1', inputs: { Password: 'secret' },
    policy: { credentialsAvailable: false }, verify: [{ type: 'text_visible', text: 'Not present' }],
  }, { windowId: 1, title: 'DSH Workflow Fixture' }, { appHandle: 'app-1', windowId: 1, details: true },
  Config({ decisionToken: 'unused', verificationTimeoutMs: 0 }), new AbortController().signal)
  expect(result).toMatchObject({ status: 'blocked', reason: 'credentials_unavailable', actionsExecuted: 0 })
  expect(calls).not.toContain('setValue')
})

it('rejects a native Skill captured for another window', async () => {
  const skill = fixtureSkills.find(candidate => candidate.id === 'fixture.native-csv-import')!
  const caller = { async call() { throw new Error('Observation should not be needed') } } as unknown as NativeCaller
  await expect(runNativeSkill(caller, skill, {
    goal: 'Import', app: '1', inputs: { 'Report path': '/tmp/report.csv' }, verify: [{ type: 'text_visible', text: 'Done' }],
  }, { windowId: 2, title: 'Another Document' }, { appHandle: 'app-1', windowId: 2, details: true },
  Config({ decisionToken: 'unused' }), new AbortController().signal)).rejects.toMatchObject({ code: 'skill_window_mismatch' })
})

it('enforces wall-clock and step budgets during native Skill waits', async () => {
  const skill = fixtureSkills.find(candidate => candidate.id === 'fixture.native-csv-import')!
  const caller = {
    async call() {
      return { pid: 1, snapshotId: 'snapshot-1', windows: [], truncated: false, tree: '- AXStaticText = "idle"' }
    },
  } as unknown as NativeCaller
  const result = await runNativeSkill(caller, { ...skill, steps: [{ type: 'wait', ms: 100 }, ...skill.steps] }, {
    goal: 'Import', app: '1', inputs: { 'Report path': '/tmp/report.csv' }, verify: [{ type: 'text_visible', text: 'Done' }],
  }, { windowId: 1, title: 'DSH Workflow Fixture' }, { appHandle: 'app-1', windowId: 1, details: true },
  Config({ decisionToken: 'unused' }), new AbortController().signal, undefined,
  new RunBudget({ maxWallClockMs: 1, maxInputTokens: 10, maxOutputTokens: 10 }), 1)
  expect(result).toMatchObject({ status: 'escalated', reason: 'wall_clock_budget_exhausted', actionsExecuted: 0 })
})

it('reobserves a transient native AX failure before delivering a skill action', async () => {
  const reportPath = '/tmp/report.csv'
  const selected = { windowId: 1, title: 'DSH Workflow Fixture' }
  const skill = fixtureSkills.find(candidate => candidate.id === 'fixture.native-csv-import')!
  const args: ComputerSubgoalInput = {
    goal: 'Import the synthetic report.',
    app: '1',
    skillId: skill.id,
    inputs: { 'Report path': reportPath },
    verify: [{ type: 'text_visible', text: 'Report path' }],
  }
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  let path = ''
  let complete = false
  let stateCalls = 0
  let snapshot = 0
  const caller = {
    async call(method: string, params: Record<string, unknown>) {
      calls.push({ method, params })
      if (method === 'getState') {
        stateCalls += 1
        if (stateCalls === 2) {
          throw new Error('STALE_SNAPSHOT: Accessibility tree changed during observation; read fresh getAXState')
        }
        snapshot += 1
        return {
          pid: 1,
          snapshotId: `snapshot-${snapshot}`,
          tree: `AX scope=window
- [0] AXWindow "DSH Workflow Fixture"
  - [1] AXTextField = "${path}" placeholder="Report path" id="dsh-workflow-path" actions=["AXConfirm"]
  - [2] AXButton "Import report" id="dsh-workflow-import" actions=["AXPress"]
  - AXStaticText = "Status: ${complete ? 'Import complete' : 'idle'}"
  - AXStaticText = "Rows: ${complete ? 2 : 0} · Total: ${complete ? 300 : 0}"`,
          windows: [selected],
          truncated: false,
        }
      }
      if (method === 'setValue') {
        path = String(params.value)
        return { dispatched: true }
      }
      if (method === 'click') {
        complete = true
        return { dispatched: true }
      }
      throw new Error(`Unexpected native call: ${method}`)
    },
  } as unknown as NativeCaller

  const result = await runNativeSkill(
    caller,
    skill,
    args,
    selected,
    { appHandle: 'app-1', windowId: 1, details: true },
    Config({ decisionToken: 'unused', verificationTimeoutMs: 0 }),
    new AbortController().signal,
  )

  expect(result).toMatchObject({
    status: 'success', route: 'skill', actionsExecuted: 2, modelForwardCalls: 0,
  })
  expect(calls.filter(call => call.method === 'setValue')).toHaveLength(1)
  expect(calls.filter(call => call.method === 'click')).toHaveLength(1)
  expect(calls.find(call => call.method === 'setValue')?.params.snapshotId).toBe('snapshot-2')
})

it('read back an uncertain native paste once without replaying input', async () => {
  const skill = fixtureSkills.find(candidate => candidate.id === 'fixture.native-csv-import')!
  const selected = { windowId: 1, title: 'DSH Workflow Fixture' }
  const marker = 'independently observed paste'
  let pasted = false
  let pasteCalls = 0
  const caller = {
    async call(method: string) {
      if (method === 'getState') return {
        pid: 1, snapshotId: 'snapshot-1', windows: [selected], truncated: false,
        tree: `- [4] AXDocument "Body" = "${pasted ? marker : ''}"`,
      }
      if (method === 'click') return { dispatched: true }
      if (method === 'paste') {
        pasteCalls += 1
        pasted = true
        throw new Error('PASTE_NOT_CONSUMED: delayed paste may still run')
      }
      throw new Error(`Unexpected native call: ${method}`)
    },
  } as unknown as NativeCaller
  const result = await runNativeSkill(caller, {
    ...skill, steps: [{ type: 'paste', target: 'Body', input: 'Body' }], verify: [{ type: 'text_visible', text: marker }],
  }, {
    goal: 'Enter the document body', app: '1', inputs: { Body: marker }, verify: [{ type: 'text_visible', text: marker }],
  }, selected, { appHandle: 'app-1', windowId: 1, details: true },
  Config({ decisionToken: 'unused', verificationTimeoutMs: 0 }), new AbortController().signal)
  expect(result).toMatchObject({
    status: 'success', reason: 'independently_verified_after_uncertain_paste', actionsExecuted: 1, modelForwardCalls: 0,
  })
  expect(pasteCalls).toBe(1)
})

it('bounds stale observation retries and preserves persistent failures', async () => {
  let calls = 0
  const caller = {
    async call() {
      calls += 1
      throw new Error('STALE_SNAPSHOT: Accessibility tree changed during observation; read fresh getAXState')
    },
  } as unknown as NativeCaller

  await expect(readNativeState(caller, {}, new AbortController().signal))
    .rejects.toThrow('STALE_SNAPSHOT: Accessibility tree changed during observation')
  expect(calls).toBe(3)
})
