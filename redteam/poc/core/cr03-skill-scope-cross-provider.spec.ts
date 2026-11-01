/**
 * CR-03 — Skill scope is not enforced on browser replay.
 *
 * A Skill keyed on `windowTitle` or `appBundleId` declares "this belongs to one
 * application / window". `assertSkillOrigin` returns immediately for such Skills
 * (skills.ts:230 `if (skill.match.urlPath === undefined) return`) and the browser
 * runner never calls `assertSkillScope` — that call exists only in the native
 * runner. Net effect: a native-scoped Skill (including the built-in
 * `fixture.native-csv-import`) replays its type/click steps on any web page.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { assertSkillOrigin, fixtureSkills, selectSkill } from '../../../packages/dsh-cu-core/src/skills.ts'
import { runBrowserSkill } from '../../../packages/dsh-browser-use-d1/src/skill-runner.ts'
import { FakePage } from './fake-page.ts'

const browserRunner = readFileSync(
  new URL('../../../packages/dsh-browser-use-d1/src/skill-runner.ts', import.meta.url), 'utf8',
)
const nativeRunner = readFileSync(
  new URL('../../../packages/dsh-computer-use-d1/src/skill-runner.ts', import.meta.url), 'utf8',
)

const config = {
  locale: 'en', operationTimeoutMs: 1000, verificationTimeoutMs: 0, asyncTimeoutMs: 100,
  maxSteps: 12, decisionEndpoint: 'http://127.0.0.1:1', decisionToken: 'x',
  textStrategy: 'speculative', headless: true, maxWallClockMs: 60_000,
  maxInputTokens: 1, maxOutputTokens: 1, captureSkills: false, auditRetentionDays: 30, toolPrefix: 'browser',
} as any

describe('CR-03 windowTitle/appBundleId Skills have no origin or scope check on browser replay', () => {
  it('only the native runner enforces assertSkillScope', () => {
    expect(nativeRunner).toMatch(/assertSkillScope/)
    expect(browserRunner).not.toMatch(/assertSkillScope/)
  })

  it('a windowTitle Skill passes origin assertion on an arbitrary attacker origin', () => {
    const nativeSkill = fixtureSkills.find(skill => skill.id === 'fixture.native-csv-import')!
    expect(nativeSkill.match).toEqual({ windowTitle: 'DSH Workflow Fixture' })
    expect(() => assertSkillOrigin(nativeSkill, 'https://evil.example/account')).not.toThrow()
    expect(() => assertSkillOrigin(nativeSkill, undefined as any)).not.toThrow()
  })

  it('an appBundleId-scoped Skill replays its steps on a hostile page', async () => {
    const page = new FakePage('https://evil.example/account', [
      { name: 'Report path', role: 'textbox', inputType: 'text', actions: ['type'] },
      { name: 'Import report', role: 'button', actions: ['click'] },
    ])
    page.onClick = name => {
      if (name === 'Import report') page.visible.push('Import complete', 'Rows: 2 · Total: 300')
    }
    const skill = {
      id: 'redteam.native-import', version: 1, verifiedAt: '2026-11-01',
      match: { appBundleId: 'com.apple.finder' },
      fallback: 'd1', risk: 'reversible',
      verify: [{ type: 'text_visible', text: 'Import complete' }],
      steps: [
        { type: 'type', target: 'Report path', input: 'Report path' },
        { type: 'click', target: 'Import report' },
      ],
    } as any
    expect(() => assertSkillOrigin(skill, 'https://evil.example/account')).not.toThrow()

    const state = await runBrowserSkill(
      page as any, skill,
      { goal: 'sync', inputs: { 'Report path': '/etc/passwd' }, verify: [{ type: 'text_visible', text: 'Import complete' }] } as any,
      config, new AbortController().signal, undefined, 5,
    )
    expect(page.typed).toEqual([{ target: 'Report path', text: '/etc/passwd' }])
    expect(page.clicked).toEqual(['Import report'])
    expect(state?.status).toBe('success')
  })

  it('the built-in native fixture is selectable by the browser provider', async () => {
    const skill = await selectSkill({ skillId: 'fixture.native-csv-import', url: 'https://evil.example/x' }, undefined)
    expect(skill?.id).toBe('fixture.native-csv-import')
  })
})
