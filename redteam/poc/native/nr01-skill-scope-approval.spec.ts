/**
 * NR-01 — Native Skill scope is a string the target application controls, and Skill
 * replay has no approval path at all.
 *
 * skill-runner.ts:28 calls assertSkillScope({windowTitle: selected.title, appBundleId}).
 * skills.ts:245-259 compares those two strings and nothing else: no window id, no
 * executable path, no signature over the skill record. skill-runner.ts imports no
 * approval gateway, so a stored Skill executes every step without a single prompt.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { needsConsequentialApproval } from '@albaincompleta/dsh-cu-core/policy-approvals'
import { fixtureSkills, selectSkill } from '@albaincompleta/dsh-cu-core/skills'
import type { VerifiedSkill } from '@albaincompleta/dsh-cu-core/skills'
import { Config } from '../../../packages/dsh-computer-use-d1/src/config.ts'
import type { NativeCaller } from '../../../packages/dsh-computer-use-d1/src/controller.ts'
import { runNativeSkill } from '../../../packages/dsh-computer-use-d1/src/skill-runner.ts'
import { fakeCaller, stateResponse } from './fakes.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const loginTree = [
  '- [1] AXWindow "Sign in"',
  '  - [2] AXSecureTextField placeholder="Password" actions=["AXConfirm"] bounds=[40,80,300,24]',
  '  - [3] AXButton "Continue" actions=["AXPress"] bounds=[40,120,90,24]',
].join('\n')

function callerTree(tree: string) {
  return fakeCaller({
    getState: () => stateResponse({ tree, windowId: 2, title: 'Sign in' }),
    click: () => ({ ok: true }),
    paste: () => ({ ok: true }),
    setValue: () => ({ ok: true }),
    typeText: () => ({ ok: true }),
    pressKey: () => ({ ok: true }),
  }) as unknown as NativeCaller & { methods(): string[]; last(method: string): any }
}

const baseArgs = {
  goal: 'Sign in', app: '1', inputs: { Password: 'correct-horse-battery' },
  verify: [{ type: 'text_visible' as const, text: 'Welcome back' }],
}

describe('NR-01 native Skill scope and approval', () => {
  it('ships a built-in Skill that is always selectable and scoped by window title alone', async () => {
    const skill = await selectSkill({ skillId: 'fixture.native-csv-import' }, undefined)
    expect(skill).not.toBeNull()
    expect(skill!.match).toEqual({ windowTitle: 'DSH Workflow Fixture' })
    expect(fixtureSkills.map(entry => entry.id)).toContain('fixture.native-csv-import')
  })

  it('replays into another application that only copied the window title', async () => {
    const skill = fixtureSkills.find(entry => entry.id === 'fixture.native-csv-import')!
    const caller = callerTree('- [1] AXWindow "DSH Workflow Fixture"\n  - [2] AXTextField placeholder="Report path" bounds=[40,80,300,24]\n  - [3] AXButton "Import report" actions=["AXPress"] bounds=[40,120,90,24]')
    const result = await runNativeSkill(caller, skill, { ...baseArgs, inputs: { 'Report path': '/tmp/report.csv' } } as any, {
      windowId: 99, title: 'DSH Workflow Fixture', bounds: { x: 0, y: 0, width: 400, height: 300 },
    }, { appHandle: 'app-evil', windowId: 99, details: true },
    Config({ decisionToken: 'unused', verificationTimeoutMs: 0 }), new AbortController().signal,
    // A different bundle id, a different pid, a different window id: not compared.
    'com.attacker.clone')
    expect(result.actionsExecuted).toBeGreaterThan(0)
    expect(caller.methods()).toContain('setValue')
  })

  it('treats an empty window title as a wildcard for every untitled window', async () => {
    const untitled: VerifiedSkill = {
      id: 'nr01.untitled', version: 1, verifiedAt: '2026-10-28',
      match: { windowTitle: '' }, fallback: 'human', risk: 'read_only',
      verify: [{ type: 'text_visible', text: 'Never present' }],
      steps: [{ type: 'type', target: 'Password', input: 'Password' }],
    }
    const caller = callerTree(loginTree)
    const result = await runNativeSkill(caller, untitled, baseArgs as any, {
      windowId: 7, title: '',
    }, { appHandle: 'app-any', windowId: 7, details: true },
    Config({ decisionToken: 'unused', verificationTimeoutMs: 0 }), new AbortController().signal,
    'com.any.application')
    // '' matched '', so an unrelated untitled window received the keystrokes.
    expect(result.actionsExecuted).toBe(1)
    expect(caller.methods()).toContain('setValue')
  })

  it('dispatches a consequential secret entry with no approval prompt', async () => {
    const secretSkill: VerifiedSkill = {
      id: 'nr01.secret', version: 1, verifiedAt: '2026-10-28',
      match: { windowTitle: 'Sign in' }, fallback: 'human', risk: 'consequential',
      verify: [{ type: 'text_visible', text: 'Welcome back' }],
      steps: [
        { type: 'paste', target: 'Password', input: 'Password' },
        { type: 'click', target: 'Continue' },
      ],
    }
    const caller = callerTree(loginTree)
    const result = await runNativeSkill(caller, secretSkill, baseArgs as any, {
      windowId: 2, title: 'Sign in',
    }, { appHandle: 'app-1', windowId: 2, details: true },
    Config({ decisionToken: 'unused', verificationTimeoutMs: 0 }), new AbortController().signal,
    'com.example.login', undefined, undefined, undefined, undefined)
    // The d1 path would have asked for approval at this risk class...
    expect(needsConsequentialApproval({ risk: 'consequential' })).toBe(true)
    // ...the Skill path dispatched the credential and the sign-in click without asking.
    expect(result.actionsExecuted).toBe(2)
    expect(caller.methods()).toEqual(expect.arrayContaining(['paste', 'click']))
  })

  it('derives the replayed Skill risk from the model-supplied capture policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nr01-'))
    roots.push(root)
    const { createCandidateFromTrajectory } = await import('@albaincompleta/dsh-cu-core/skill-builder')
    const { SkillStore } = await import('@albaincompleta/dsh-cu-core/skill-store')
    const store = new SkillStore(join(root, 'skills.json'))
    const candidate = await createCandidateFromTrajectory(store, {
      route: 'd1',
      status: 'success',
      trace: [{ snapshotId: 'snap-1', operation: 'PASTE_TEXT', target: '3', targetName: 'Password', dispatched: true }],
      verify: [{ type: 'text_visible', text: 'Welcome back' }],
      inputs: { Password: 'correct-horse-battery' },
      capturedValues: [{ targetName: 'Password', value: 'correct-horse-battery' }],
      match: { windowTitle: 'Sign in' },
      // Exactly what controller.ts:694 passes: the model's own policy value.
      risk: 'read_only',
    })
    expect(candidate?.risk).toBe('read_only')
  })
})
